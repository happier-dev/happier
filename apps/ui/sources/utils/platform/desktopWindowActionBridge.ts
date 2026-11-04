import { getDesktopHostWindowLabel, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';

export type CaptureActionWindowLabel = 'capture' | `capture_${number}`;
export type DesktopActionWindowLabel = 'main' | 'activity_overlay' | CaptureActionWindowLabel | `destination_${string}`;

export function isCaptureWindowLabel(label: string): label is CaptureActionWindowLabel {
    return label === 'capture' || /^capture_[0-9]+$/.test(label);
}
/** Private data read, carried by the same native-label-checked request/result transport. */
export const DESKTOP_CAPTURE_SESSION_CHOOSER_READ = 'screenCapture.sessionChooser.read';
/** Private UI intent; prepared media stays in the main renderer. */
export const DESKTOP_CAPTURE_NEW_SESSION = 'screenCapture.sessionChooser.newSession';
/** Private navigation intent; the main renderer owns Session routing. */
export const DESKTOP_CAPTURE_OPEN_SESSION = 'screenCapture.session.open';
export const DESKTOP_CAPTURE_OPEN_SETTINGS = 'screenCapture.settings.open';
/** A keyboard intent; the primary renderer retains the single Voice lifecycle and microphone. */
export const DESKTOP_VOICE_TOGGLE = 'desktop.voice.toggle';
export type DesktopWindowActionRequest = Readonly<{
    windowLabel: DesktopActionWindowLabel;
    /** An admitted data-realm continuation; the native bridge removes this before delivery. */
    targetWindowLabel?: `destination_${string}`;
    requestId?: string;
    actionIdentifier: string;
    data: Record<string, unknown>;
    intent?: 'retry' | 'chooseSession';
}>;
export type DesktopWindowActionResult = Readonly<{
    windowLabel: DesktopActionWindowLabel;
    requestId: string;
    phase?: 'admitted' | 'settled';
    ok: boolean;
    result?: unknown;
    details?: unknown;
    errorCode?: string;
    error?: string;
}>;
/** Retires a presenter's wait, never an already admitted main-renderer operation. */
export type DesktopWindowActionWaitOptions = Readonly<{ timeoutMs?: number; signal?: AbortSignal }>;

export const DESKTOP_WINDOW_ACTION_EVENTS = {
    request: 'desktopWindow://action',
    result: 'desktopWindow://action-result',
} as const;

let nextRequestSequence = 0;

export function emitDesktopWindowAction(payload: DesktopWindowActionRequest): Promise<void> {
    return invokeDesktopHost<void>('desktop_window_emit_action', { payload });
}

export function emitDesktopWindowActionResult(payload: DesktopWindowActionResult): Promise<void> {
    return invokeDesktopHost<void>('desktop_window_emit_action_result', { payload });
}

export function listenDesktopWindowAction(handler: (request: DesktopWindowActionRequest) => void): Promise<() => void> {
    return listenDesktopHostEvent(DESKTOP_WINDOW_ACTION_EVENTS.request, handler);
}

export function listenDesktopWindowActionResult(handler: (result: DesktopWindowActionResult) => void): Promise<() => void> {
    return listenDesktopHostEvent(DESKTOP_WINDOW_ACTION_EVENTS.result, handler);
}

/** Capture chooser footer: only a reference and the person's note cross IPC. */
export function requestCaptureNewSession(input: Readonly<{ captureRef: string; note?: string }>, options?: DesktopWindowActionWaitOptions): Promise<DesktopWindowActionResult> {
    return executeDesktopWindowActionWithResult({ windowLabel: 'capture', actionIdentifier: DESKTOP_CAPTURE_NEW_SESSION,
        data: { captureRef: input.captureRef, ...(input.note === undefined ? {} : { note: input.note }) } }, options);
}

/** The ⋯ menu's Capture settings: main shows its own Settings page. */
export function requestCaptureOpenSettings(options?: DesktopWindowActionWaitOptions): Promise<DesktopWindowActionResult> {
    return executeDesktopWindowActionWithResult({ windowLabel: 'capture', actionIdentifier: DESKTOP_CAPTURE_OPEN_SETTINGS, data: {} }, options);
}

/** Pill Open never restores Sync in the auxiliary window. */
export function requestCaptureOpenSession(session: ExactSessionMachineTargetIdentity, options?: DesktopWindowActionWaitOptions): Promise<DesktopWindowActionResult> {
    return executeDesktopWindowActionWithResult({ windowLabel: 'capture', actionIdentifier: DESKTOP_CAPTURE_OPEN_SESSION,
        data: { serverId: session.serverId, accountId: session.accountId, sessionId: session.sessionId } }, options);
}

/** The native host verifies the originating window label before forwarding to main. */
export function executeDesktopWindowActionWithResult(
    payload: DesktopWindowActionRequest,
    options: DesktopWindowActionWaitOptions = {},
): Promise<DesktopWindowActionResult> {
    const sourceLabel = getDesktopHostWindowLabel();
    if (payload.windowLabel === 'capture' && sourceLabel && isCaptureWindowLabel(sourceLabel)) {
        payload = { ...payload, windowLabel: sourceLabel };
    }
    nextRequestSequence = (nextRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    const requestId = payload.requestId ?? `desktop-window-${Date.now().toString(36)}-${nextRequestSequence}`;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let dispose: (() => void) | null = null;
    return new Promise(resolve => {
        const settle = (result: DesktopWindowActionResult) => {
            if (settled) return;
            settled = true;
            if (timeoutId !== null) clearTimeout(timeoutId);
            dispose?.();
            options.signal?.removeEventListener('abort', retire);
            resolve(result);
        };
        const retire = () => settle({
            windowLabel: payload.windowLabel, requestId, ok: false, errorCode: 'cancelled', error: 'cancelled',
        });
        if (options.signal?.aborted) { retire(); return; }
        options.signal?.addEventListener('abort', retire, { once: true });
        // Capture Add/Send settle on the operation result. Only the activity
        // overlay supplies its existing acknowledgement deadline.
        if (options.timeoutMs !== undefined) {
            timeoutId = setTimeout(() => settle({
                windowLabel: payload.windowLabel, requestId, ok: false, errorCode: 'ack_timeout', error: 'ack_timeout',
            }), options.timeoutMs);
        }
        void listenDesktopWindowActionResult(result => {
            if (result.windowLabel === payload.windowLabel && result.requestId === requestId && result.phase !== 'admitted') settle(result);
        }).then(nextDispose => {
            if (settled) { nextDispose(); return; }
            dispose = nextDispose;
            return emitDesktopWindowAction({ ...payload, requestId });
        }).catch((error: unknown) => {
            // Native command failures are strings. Preserve the closed caller
            // refusal; an opaque exception may contain private paths or data.
            const errorCode = error === 'desktop_window_action_source_refused'
                ? error : 'bridge_emit_failed';
            settle({ windowLabel: payload.windowLabel, requestId, ok: false, errorCode, error: errorCode });
        });
    });
}
