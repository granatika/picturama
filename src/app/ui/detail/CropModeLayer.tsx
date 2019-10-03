import React from 'react'
import classnames from 'classnames'

import { PhotoWork, ExifOrientation } from 'common/CommonTypes'
import { vec2 } from 'gl-matrix'

import { CameraMetrics, getInvertedCameraMatrix, getInvertedProjectionMatrix, createProjectionMatrix } from 'app/renderer/CameraMetrics'
import { Point, Size, Rect, Side, Corner, corners } from 'app/util/GeometryTypes'
import {
    transformRect, oppositeCorner, cornerPointOfRect, toVec2, centerOfRect, intersectLineWithPolygon,
    rectFromCenterAndSize, scaleSize, isPointInPolygon, nearestPointOnPolygon, Vec2Like, rectFromCornerPointAndSize,
    roundRect, rectFromPoints, directionOfPoints, movePoint, ceilVec2, floorVec2, roundVec2
} from 'app/util/GeometryUtil'

import CropOverlay from './CropOverlay'
import { bindMany, isShallowEqual } from 'common/util/LangUtil'
import CropModeToolbar from './CropModeToolbar'
import { createDragRectFencePolygon } from './CropModeUtil'


const minCropRectSize = 32


export interface Props {
    topBarClassName: string
    bodyClassName: string
    exifOrientation: ExifOrientation
    photoWork: PhotoWork
    cameraMetrics: CameraMetrics
    onPhotoWorkEdited(photoWork: PhotoWork): void
    onDone(): void
}

interface State {
    actionInfo:
        { type: 'tilt', centerInTextureCoords: vec2, maxCropRectSize: Size } |
        { type: 'drag-rect', startCropRect: Rect, fencePolygon: vec2[] } |
        null
}

export default class CropModeLayer extends React.Component<Props, State> {

    constructor(props: Props) {
        super(props)
        bindMany(this, 'onRectDrag', 'onSideDrag', 'onCornerDrag', 'onTiltChange')
        this.state = { actionInfo: null }
    }

    private onRectDrag(deltaX: number, deltaY: number, isFinished: boolean) {
        const { props } = this
        const { cameraMetrics } = props
        const { actionInfo } = this.state
        let nextState: Partial<State> | null = null

        let startCropRect: Rect
        let fencePolygon: vec2[]
        if (actionInfo && actionInfo.type === 'drag-rect') {
            startCropRect = actionInfo.startCropRect
            fencePolygon = actionInfo.fencePolygon
        } else {
            startCropRect = cameraMetrics.cropRect
            fencePolygon = createDragRectFencePolygon(startCropRect, createTexturePolygon(cameraMetrics))
            nextState = { actionInfo: { type: 'drag-rect', startCropRect, fencePolygon } }
        }

        // Limit the crop rect to the texture
        const zoom = cameraMetrics.photoPosition.zoom
        let nextRectLeftTop: Vec2Like = [startCropRect.x + deltaX / zoom, startCropRect.y + deltaY / zoom]
        if (!isPointInPolygon(nextRectLeftTop, fencePolygon)) {
            nextRectLeftTop = nearestPointOnPolygon(nextRectLeftTop, fencePolygon)
        }
        const cropRect = rectFromCornerPointAndSize(roundVec2(nextRectLeftTop), startCropRect)

        // Apply changes
        if (isFinished) {
            nextState = { actionInfo: null }
        }
        if (nextState) {
            this.setState(nextState as any)
        }
        this.onPhotoWorkEdited({ ...props.photoWork, cropRect })
    }

    private onSideDrag(side: Side, point: Point, isFinished: boolean) {
        const { props } = this
        const { cameraMetrics } = props
        const prevCropRect = cameraMetrics.cropRect

        const invertedCameraMatrix = getInvertedCameraMatrix(cameraMetrics)
        const projectedPoint = vec2.transformMat4(vec2.create(), toVec2(point), invertedCameraMatrix)

        const nwCorner = cornerPointOfRect(prevCropRect, 'nw')
        const seCorner = cornerPointOfRect(prevCropRect, 'se')

        switch (side) {
            case 'w': nwCorner[0] = Math.min(seCorner[0] - minCropRectSize, projectedPoint[0]); break
            case 'n': nwCorner[1] = Math.min(seCorner[1] - minCropRectSize, projectedPoint[1]); break
            case 'e': seCorner[0] = Math.max(nwCorner[0] + minCropRectSize, projectedPoint[0]); break
            case 's': seCorner[1] = Math.max(nwCorner[1] + minCropRectSize, projectedPoint[1]); break
        }

        const wantedCropRect = rectFromPoints(nwCorner, seCorner)
        const texturePolygon = createTexturePolygon(cameraMetrics)
        const cropRect = limitRectResizeToTexture(prevCropRect, wantedCropRect, texturePolygon)

        // Apply changes
        if (this.state.actionInfo) {
            this.setState({ actionInfo: null })
        }
        this.onPhotoWorkEdited({ ...props.photoWork, cropRect })
    }

    private onCornerDrag(corner: Corner, point: Point, isFinished: boolean) {
        const { props } = this
        const { cameraMetrics } = props
        const prevCropRect = cameraMetrics.cropRect

        const invertedCameraMatrix = getInvertedCameraMatrix(cameraMetrics)
        const projectedPoint = vec2.transformMat4(vec2.create(), toVec2(point), invertedCameraMatrix)
        const oppositePoint = cornerPointOfRect(prevCropRect, oppositeCorner[corner])

        // Limit the crop rect to the texture
        // The oppositePoint stays fixed, find width/height that fits into the texture
        const texturePolygon = createTexturePolygon(cameraMetrics)
        const wantedCornerPoint = isPointInPolygon(projectedPoint, texturePolygon) ? projectedPoint : nearestPointOnPolygon(projectedPoint, texturePolygon)
        const nextCropRectSize = {
            width:  wantedCornerPoint[0] - oppositePoint[0],
            height: wantedCornerPoint[1] - oppositePoint[1]
        }
        const xCutFactor = maxCutFactor(oppositePoint, [nextCropRectSize.width, 0], texturePolygon)
        if (xCutFactor && xCutFactor < 1) {
            nextCropRectSize.width *= xCutFactor
        }
        const yCutFactor = maxCutFactor(oppositePoint, [0, nextCropRectSize.height], texturePolygon)
        if (yCutFactor && yCutFactor < 1) {
            nextCropRectSize.height *= yCutFactor
        }
        const cornerDirection = [
            corner === 'ne' || corner === 'se' ? 1 : -1,
            corner === 'sw' || corner === 'se' ? 1 : -1
        ]
        nextCropRectSize.width  = cornerDirection[0] * Math.max(minCropRectSize, Math.floor(cornerDirection[0] * nextCropRectSize.width))
        nextCropRectSize.height = cornerDirection[1] * Math.max(minCropRectSize, Math.floor(cornerDirection[1] * nextCropRectSize.height))
        const cropRect = rectFromCornerPointAndSize(oppositePoint, nextCropRectSize)

        // Apply changes
        if (this.state.actionInfo) {
            this.setState({ actionInfo: null })
        }
        this.onPhotoWorkEdited({ ...props.photoWork, cropRect })
    }

    private onTiltChange(tilt: number) {
        const { props } = this
        const { cameraMetrics } = props
        const { actionInfo } = this.state
        let nextState: Partial<State> | null = null
        const prevCropRect = cameraMetrics.cropRect

        // Apply tilt
        const photoWork = { ...props.photoWork }
        if (tilt === 0) {
            delete photoWork.tilt
        } else {
            photoWork.tilt = tilt
        }

        // Get center and maximum size of crop rect
        let centerInTextureCoords: vec2
        let maxCropRectSize: Size
        if (actionInfo && actionInfo.type === 'tilt') {
            centerInTextureCoords = actionInfo.centerInTextureCoords
            maxCropRectSize = actionInfo.maxCropRectSize
        } else {
            const center = centerOfRect(prevCropRect)
            vec2.transformMat4(center, center, getInvertedProjectionMatrix(cameraMetrics))
            centerInTextureCoords = center
            maxCropRectSize = { width: prevCropRect.width, height: prevCropRect.height }
            nextState = { actionInfo: { type: 'tilt', centerInTextureCoords, maxCropRectSize } }
        }

        // Adjust crop rect
        const texturePolygon = createTexturePolygon(cameraMetrics)
        const nextProjectionMatrix = createProjectionMatrix(cameraMetrics.textureSize, props.exifOrientation, photoWork)
        const nextCropRectCenter = vec2.transformMat4(vec2.create(), centerInTextureCoords, nextProjectionMatrix)
        let outFactors: number[]
        outFactors = intersectLineWithPolygon(nextCropRectCenter, [maxCropRectSize.width / 2, maxCropRectSize.height / 2], texturePolygon)
        let minFactor = outFactors.reduce((minFactor, factor) => Math.min(minFactor, Math.abs(factor)), 1)
        outFactors = intersectLineWithPolygon(nextCropRectCenter, [maxCropRectSize.width / 2, -maxCropRectSize.height / 2], texturePolygon)
        minFactor = outFactors.reduce((minFactor, factor) => Math.min(minFactor, Math.abs(factor)), minFactor)
        photoWork.cropRect = roundRect(rectFromCenterAndSize(nextCropRectCenter, scaleSize(maxCropRectSize, minFactor)))

        // Apply changes
        if (nextState) {
            this.setState(nextState as any)
        }
        this.onPhotoWorkEdited(photoWork)
    }

    private onPhotoWorkEdited(photoWork: PhotoWork) {
        const { cropRect } = photoWork
        if (cropRect) {
            if (isShallowEqual(cropRect, this.props.cameraMetrics.neutralCropRect)) {
                delete photoWork.cropRect
            } else {
                photoWork.cropRect = cropRect
            }
        }

        this.props.onPhotoWorkEdited(photoWork)
    }

    render() {
        const { props } = this
        const { cameraMetrics } = props
        if (!cameraMetrics) {
            return null
        }

        const cropRectInViewCoords = transformRect(cameraMetrics.cropRect, cameraMetrics.cameraMatrix)

        return (
            <>
                <CropModeToolbar
                    className={classnames(props.topBarClassName, 'CropModeLayer-toolbar')}
                    photoWork={props.photoWork}
                    onPhotoWorkEdited={props.onPhotoWorkEdited}
                    onDone={props.onDone}
                />
                <CropOverlay
                    className={classnames(props.bodyClassName, 'CropModeLayer-body')}
                    width={cameraMetrics.canvasSize.width}
                    height={cameraMetrics.canvasSize.height}
                    rect={cropRectInViewCoords}
                    tilt={props.photoWork.tilt || 0}
                    onRectDrag={this.onRectDrag}
                    onSideDrag={this.onSideDrag}
                    onCornerDrag={this.onCornerDrag}
                    onTiltChange={this.onTiltChange}
                />
            </>
        )
    }

}


/**
 * Creates a polygon of the texture's outline (in projected coordinates).
 */
function createTexturePolygon(cameraMetrics: CameraMetrics): vec2[] {
    const { textureSize, projectionMatrix } = cameraMetrics

    // Create the polygon in texture coordinates
    const polygon = [
        vec2.fromValues(0, 0),
        vec2.fromValues(textureSize.width, 0),
        vec2.fromValues(textureSize.width, textureSize.height),
        vec2.fromValues(0, textureSize.height),
    ]

    // Transform the polygon to projected coordinates
    for (let i = 0, il = polygon.length; i < il; i++) {
        vec2.transformMat4(polygon[i], polygon[i], projectionMatrix)
    }

    return polygon
}


function limitRectResizeToTexture(prevRect: Rect, wantedRect: Rect, texturePolygon: Vec2Like[]): Rect {
    let minFactor = 1

    if (wantedRect.width < minCropRectSize) {
        const minFactorX = (prevRect.width - minCropRectSize) / (wantedRect.width - minCropRectSize)
        if (minFactorX < minFactor) {
            minFactor = minFactorX
        }
    }
    if (wantedRect.height < minCropRectSize) {
        const minFactorY = (prevRect.height - minCropRectSize) / (wantedRect.height - minCropRectSize)
        if (minFactorY < minFactor) {
            minFactor = minFactorY
        }
    }

    let nwStart: vec2 | null = null
    let nwDirection: vec2 | null = null
    let seStart: vec2 | null = null
    let seDirection: vec2 | null = null
    for (const corner of corners) {
        const start = cornerPointOfRect(prevRect, corner)
        const end = cornerPointOfRect(wantedRect, corner)
        const direction = directionOfPoints(start, end)

        const cutFactor = maxCutFactor(start, direction, texturePolygon)
        if (cutFactor && cutFactor < minFactor) {
            minFactor = cutFactor
        }

        if (corner === 'nw') {
            nwStart = start
            nwDirection = cutFactor ? direction : null
        } else if (corner === 'se') {
            seStart = start
            seDirection = cutFactor ? direction : null
        }
    }

    const nextNwPoint = ceilVec2(nwDirection ? movePoint(nwStart!, nwDirection, minFactor) : nwStart!)
    const nextSePoint = floorVec2(seDirection ? movePoint(seStart!, seDirection, minFactor) : seStart!)
    return rectFromPoints(nextNwPoint, nextSePoint)
}


function maxCutFactor(lineStart: Vec2Like, lineDirection: Vec2Like, polygonPoints: Vec2Like[]): number | null {
    const factors = intersectLineWithPolygon(lineStart, lineDirection, polygonPoints)
    if (factors.length) {
        return factors[factors.length - 1]
    } else {
        return null
    }
}
