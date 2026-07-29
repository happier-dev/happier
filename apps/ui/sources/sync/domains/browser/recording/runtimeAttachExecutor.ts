import type { ActionExecuteResult } from '@happier-dev/protocol';

import type {
    BrowserRecordingAttachResult,
    BrowserRecordingUnavailableReason,
} from './types';

export type BrowserRecordingAttachExecutorInput = Readonly<{
    recordingId: string;
    sessionId?: string;
}>;

/**
 * Adapter that owns the UI-side recording attach (recording-state mutation + composer
 * attachment). The executor leaf only validates input shape and delegates here; the adapter
 * applies the canonical `attachBrowserRecordingToComposer` gate-checks + state update.
 */
export type BrowserRecordingAttachAdapter = Readonly<{
    attach(input: BrowserRecordingAttachExecutorInput): Promise<BrowserRecordingAttachResult> | BrowserRecordingAttachResult;
}>;

export type BrowserRecordingAttachExecutorOptions = Readonly<{
    adapter?: BrowserRecordingAttachAdapter | null;
    resolveAdapter?: (
        input: BrowserRecordingAttachExecutorInput,
    ) => BrowserRecordingAttachAdapter | null | undefined;
}>;

type BrowserRecordingAttachFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

const invalidParametersResult = {
    ok: false,
    errorCode: 'invalid_parameters',
    error: 'invalid_parameters',
} as const satisfies BrowserRecordingAttachFailure;

function disabledResult(reason: BrowserRecordingUnavailableReason | 'browser_recording_unavailable'): BrowserRecordingAttachFailure {
    const reasonCode = typeof reason === 'string' ? reason : reason.reasonCode;
    return {
        ok: false,
        errorCode: 'runtime_action_disabled',
        error: `runtime_action_disabled:browser:${reasonCode}`,
    };
}

function readAttachInput(input: unknown): BrowserRecordingAttachExecutorInput | null {
    if (!input || typeof input !== 'object') return null;
    const record = input as Readonly<Record<string, unknown>>;
    const recordingId = typeof record.recordingId === 'string' ? record.recordingId.trim() : '';
    if (!recordingId) return null;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    return { recordingId, ...(sessionId ? { sessionId } : {}) };
}

/**
 * UI runtime executor leaf for `browser.recording.attachToComposer`. Validates the input,
 * resolves the recording-attach adapter, and routes the finalized recording's mediaRef into
 * the composer through the canonical `attachBrowserRecordingToComposer` owner. Fail-closed on
 * a missing adapter or any gate denial (returns the exact typed disabled reason).
 */
export function createBrowserRecordingAttachExecutor(
    options: BrowserRecordingAttachExecutorOptions,
): (input: unknown) => Promise<unknown> {
    return async (rawInput) => {
        const input = readAttachInput(rawInput);
        if (!input) return invalidParametersResult;

        const adapter = options.adapter ?? options.resolveAdapter?.(input) ?? null;
        if (!adapter) {
            return disabledResult('browser_recording_unavailable');
        }

        const result = await adapter.attach(input);
        if (result.status === 'unavailable') {
            return disabledResult(result.reason);
        }
        return {
            v: 1,
            actionId: 'browser.recording.attachToComposer',
            status: 'attached',
            attachmentId: result.attachmentId,
        };
    };
}
