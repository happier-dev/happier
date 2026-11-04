import { invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';

type Frame = Readonly<{ x: number; y: number; width: number; height: number }>;
export type CaptureWindowPosition = Readonly<{ x: number; y: number; scale: number }>;

/** The Capture webview's native window steps (`T/capture_window.rs`). Geometry is decided by `resolveCaptureWindowFrame`. */
export type CaptureWindowLifecycle = 'start' | 'hidden';
export const subscribeCaptureWindowLifecycle = (receive: (lifecycle: CaptureWindowLifecycle) => void): Promise<() => void> =>
    listenDesktopHostEvent('desktopCapture://window', receive);
export const announceCaptureWindowReady = (phase: 'wake' | 'state' | 'paint'): Promise<boolean> =>
    invokeDesktopHost<boolean>('desktop_capture_window_ready', { phase });

/** A frame between callbacks lets the committed clear document reach WebKit's compositor. */
export async function acknowledgeCaptureWindowPaint(): Promise<void> {
    if (typeof requestAnimationFrame === 'function') {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    await announceCaptureWindowReady('paint');
}
/**
 * `glassRadius` is the radius of the one card that fills `frame` at rest: native clips the app's glass to
 * it. Omitted or null (a union frame for motion, nothing resting yet), the window carries no material.
 */
export const presentCaptureWindow = async (frame: Frame, options?: Readonly<{ activate?: boolean; glassRadius?: number | null }>): Promise<CaptureWindowPosition | null> => {
    const previous = await invokeDesktopHost<CaptureWindowPosition | null>('desktop_capture_window_present', {
        frame, activate: options?.activate ?? true, glassRadius: options?.glassRadius ?? null,
    });
    await acknowledgeCaptureWindowPaint();
    return previous;
};
export const hideCaptureWindow = (): Promise<CaptureWindowPosition | null> =>
    invokeDesktopHost<CaptureWindowPosition | null>('desktop_capture_window_hide');
export const readCaptureWindowPlacement = (): Promise<Readonly<{ previousFrame: Frame | null }>> =>
    invokeDesktopHost('desktop_capture_window_placement');
export const setCaptureWindowFloating = (floating: boolean): Promise<void> =>
    invokeDesktopHost<void>('desktop_capture_window_set_floating', { floating });
