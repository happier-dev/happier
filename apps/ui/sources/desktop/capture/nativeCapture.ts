import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';

const errorCodes = ['desktop_only', 'unsupported_platform', 'screen_permission_required',
    'target_unavailable', 'invalid_selection', 'cancelled', 'invalid_png', 'invalid_media', 'unknown_capture',
    'prepared_missing', 'blurred_capture', 'capture_in_use', 'file_io', 'native_failure', 'operation_unavailable',
    'portal_unavailable', 'portal_denied', 'unsupported_target', 'invalid_portal_uri',
    'pipewire_unavailable', 'video_encoder_unavailable', 'video_muxer_unavailable',
    'video_decoder_unavailable', 'cursor_unavailable', 'video_pipeline_unavailable'] as const;
export type NativeCaptureErrorCode = typeof errorCodes[number];

export class NativeCaptureError extends Error {
    constructor(readonly code: NativeCaptureErrorCode) { super(code); this.name = 'NativeCaptureError'; }
}
export function readNativeCaptureErrorCode(error: unknown): NativeCaptureErrorCode {
    return error instanceof NativeCaptureError ? error.code : errorCodes.find(code => code === error) ?? 'native_failure';
}
function requireTauri(): void {
    if (desktopHostKind() !== 'tauri') throw new NativeCaptureError('desktop_only');
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    requireTauri();
    try { return await invokeDesktopHost<T>(command, args); }
    catch (error) {
        // Rust returns a closed, bodyless code; preserve it without logging native content.
        throw new NativeCaptureError(readNativeCaptureErrorCode(error));
    }
}

export async function readCaptureSourcePng(captureRef: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>('desktop_capture_read_source_png', { captureRef }));
}
/** The existing capture source reader also serves owned video bytes. */
export const readCaptureSource = readCaptureSourcePng;

export async function readPreparedCapturePng(captureRef: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<number[]>('desktop_capture_read_prepared_png', { captureRef }));
}
