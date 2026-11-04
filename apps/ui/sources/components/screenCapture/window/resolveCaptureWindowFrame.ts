import { clampWindowCoordinate, resolveWindowPlacement, type WindowRect } from '@/desktop/window/windowPlacement';

export type CaptureRect = WindowRect;
type Size = Readonly<{ width: number; height: number }>;

/**
 * A picture may take this share of the work area each way, so the source stays visible around the
 * window (D3, lab `cw` L: 760 × 475 on a 1440 × 900 screen).
 */
const PICTURE_WORK_AREA_SHARE = 0.53;

export type CaptureWindowFrameInput = Readonly<{
    /** The capture's logical size. */
    picture: Size;
    /** Where it came from, in the same desktop coordinates as the work area; absent for the portal and recents. */
    origin: CaptureRect | null;
    workArea: CaptureRect;
    metrics: Readonly<{
        gutter: number;
        /** How far from the work-area edge a clamped window stays. */
        screenInset: number;
        /** The toolbar row and the space above the picture. */
        chromeTop: number;
        /** The caption and note under the picture. */
        chromeBottom: number;
        /** The measured palette and action rows: the window never makes them wrap. */
        floorWidth: number;
    }>;
    /** A place the person dragged the window to. Only a centred open uses it. */
    remembered: Readonly<{ x: number; y: number }> | null;
    /** The preceding editor's frame, sampled by the native placement owner at open. */
    previousFrame?: CaptureRect | null;
}>;

export type CaptureWindowFrame = Readonly<{
    window: CaptureRect;
    /** The picture's rect inside the window. */
    picture: CaptureRect;
    scale: number;
    /** The native frame while the paper grows: everything the morph draws on. */
    union: CaptureRect;
}>;

function unionRects(a: CaptureRect, b: CaptureRect): CaptureRect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x, y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}

/** The one owner of the Capture window's size and place (D3). */
export function resolveCaptureWindowFrame(input: CaptureWindowFrameInput): CaptureWindowFrame {
    const { metrics, workArea, origin, remembered } = input;
    const scale = Math.min(1,
        (workArea.width * PICTURE_WORK_AREA_SHARE) / input.picture.width,
        (workArea.height * PICTURE_WORK_AREA_SHARE) / input.picture.height);
    const pictureWidth = Math.round(input.picture.width * scale);
    const pictureHeight = Math.round(input.picture.height * scale);
    const width = Math.max(pictureWidth + metrics.gutter * 2, metrics.floorWidth);
    const height = metrics.chromeTop + pictureHeight + metrics.chromeBottom;
    const picture = { x: (width - pictureWidth) / 2, y: metrics.chromeTop, width: pictureWidth, height: pictureHeight };

    const wanted = origin
        ? { x: origin.x - picture.x, y: origin.y - picture.y }
        : remembered ?? {
            x: workArea.x + (workArea.width - width) / 2,
            y: workArea.y + (workArea.height - height) / 2,
        };
    const window = resolveWindowPlacement({ size: { width, height }, workArea,
        previousFrame: input.previousFrame, position: wanted,
        cascadeOffset: metrics.gutter, screenInset: metrics.screenInset });
    return { window, picture, scale, union: origin ? unionRects(origin, window) : window };
}

/** The window folds into the pill at its bottom edge (MIS §6). */
export function resolveCapturePillFrame(input: Readonly<{
    window: CaptureRect;
    pill: Size;
    workArea: CaptureRect;
    screenInset: number;
}>): CaptureRect {
    const { window, pill, workArea, screenInset } = input;
    return {
        x: clampWindowCoordinate(window.x + (window.width - pill.width) / 2, pill.width, workArea.x, workArea.width, screenInset),
        y: window.y + window.height - pill.height,
        width: pill.width,
        height: pill.height,
    };
}
