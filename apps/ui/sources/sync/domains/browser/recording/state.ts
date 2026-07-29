import {
    BrowserRecordingSessionV1Schema,
    resolveBrowserRecordingProfileUnavailableReason,
    type BrowserRecordingOutcomeReasonV1,
    type BrowserRecordingPolicyStateV1,
    type BrowserRecordingSessionV1,
} from '@happier-dev/protocol';

import type {
    BrowserRecordingAttachResult,
    BrowserRecordingAttachmentInput,
    BrowserRecordingAvailabilityInput,
    BrowserRecordingCleanupResult,
    BrowserRecordingFinalizeInput,
    BrowserRecordingFinalizeResult,
    BrowserRecordingLifecycleEvent,
    BrowserRecordingLifecycleResult,
    BrowserRecordingStartInput,
    BrowserRecordingStartResult,
    BrowserRecordingState,
    BrowserRecordingUnavailableReason,
    BrowserRecordingUnavailableReasonCode,
} from './types';

const RECORDING_ID_PREFIX = 'browser_recording';

function createUnavailableReason(
    reasonCode: BrowserRecordingUnavailableReasonCode,
    policyState: BrowserRecordingPolicyStateV1,
    message: string,
): BrowserRecordingUnavailableReason {
    return { reasonCode, policyState, message };
}

function sanitizeRecordingIdSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return sanitized.length > 0 ? sanitized.slice(0, 72) : 'view';
}

function buildRecordingId(input: BrowserRecordingStartInput): string {
    if (input.recordingId) return input.recordingId;
    return [
        RECORDING_ID_PREFIX,
        sanitizeRecordingIdSegment(input.viewId),
        input.navigationGeneration,
        input.startedAtMs,
    ].join('_');
}

function durationFrom(session: BrowserRecordingSessionV1, atMs: number): number {
    return Math.max(0, atMs - session.startedAtMs);
}

function putRecording(
    state: BrowserRecordingState,
    recording: BrowserRecordingSessionV1,
    activeForView: boolean,
): BrowserRecordingState {
    const exists = state.sessionsById[recording.recordingId] !== undefined;
    const activeRecordingIdByViewId = activeForView
        ? {
            ...state.activeRecordingIdByViewId,
            [recording.viewId]: recording.recordingId,
        }
        : Object.fromEntries(
            Object.entries(state.activeRecordingIdByViewId)
                .filter(([viewId, recordingId]) => viewId !== recording.viewId || recordingId !== recording.recordingId),
        );

    return {
        ...state,
        sessionsById: {
            ...state.sessionsById,
            [recording.recordingId]: recording,
        },
        sessionOrder: exists ? state.sessionOrder : [...state.sessionOrder, recording.recordingId],
        activeRecordingIdByViewId,
    };
}

function recordingStatusIsActive(status: BrowserRecordingSessionV1['status']): boolean {
    return status === 'starting' || status === 'recording' || status === 'stopping';
}

export function createBrowserRecordingState(): BrowserRecordingState {
    return {
        sessionsById: {},
        sessionOrder: [],
        activeRecordingIdByViewId: {},
        attachmentsById: {},
        attachmentOrder: [],
    };
}

export function applyBrowserRecordingSessionSnapshot(
    state: BrowserRecordingState,
    recording: BrowserRecordingSessionV1,
): BrowserRecordingState {
    const parsed = BrowserRecordingSessionV1Schema.parse(recording);
    return putRecording(state, parsed, recordingStatusIsActive(parsed.status));
}

export function resolveBrowserRecordingAvailability(
    input: BrowserRecordingAvailabilityInput,
): BrowserRecordingUnavailableReason | null {
    if (!input.browserRecordingEnabled) {
        return createUnavailableReason(
            'browser_recording_disabled',
            'permissionDenied',
            'Browser recording is disabled.',
        );
    }

    if (!input.recordingCapabilities.enabled || !input.recordingCapabilities.available) {
        return createUnavailableReason(
            'browser_recording_capability_unavailable',
            'captureUnavailable',
            input.recordingCapabilities.disabledReasons[0] ?? 'Browser recording capability is unavailable.',
        );
    }

    if (input.policyState && input.policyState !== 'allowed') {
        return createUnavailableReason(
            input.policyState === 'permissionDenied'
                ? 'browser_recording_permission_denied'
                : 'browser_recording_capability_unavailable',
            input.policyState,
            'Browser recording is denied by policy.',
        );
    }

    const profileUnavailable = resolveBrowserRecordingProfileUnavailableReason({
        recordingCapabilities: input.recordingCapabilities,
        adapterKind: input.adapterKind,
        renderEngineKind: input.renderEngineKind,
        captureKind: input.captureKind,
        mimeType: input.mimeType,
        retentionClass: input.retentionClass,
        captureSourceAvailable: input.captureSourceAvailable,
    });
    if (profileUnavailable) {
        switch (profileUnavailable) {
            case 'adapter':
                return createUnavailableReason(
                    'browser_recording_adapter_unavailable',
                    'captureUnavailable',
                    'Browser recording is unavailable for this adapter.',
                );
            case 'capture':
            case 'engine':
            case 'source':
                return createUnavailableReason(
                    'browser_recording_capture_unavailable',
                    'captureUnavailable',
                    'Browser recording capture is unavailable for this adapter.',
                );
            case 'mime':
                return createUnavailableReason(
                    'browser_recording_mime_unavailable',
                    'captureUnavailable',
                    'Browser recording output type is unavailable.',
                );
            case 'retention':
                return createUnavailableReason(
                    'browser_recording_retention_unavailable',
                    'retentionLimited',
                    'Browser recording retention class is unavailable.',
                );
            case 'capability':
                return createUnavailableReason(
                    'browser_recording_capability_unavailable',
                    'captureUnavailable',
                    input.recordingCapabilities.disabledReasons[0] ?? 'Browser recording capability is unavailable.',
                );
        }
    }

    return null;
}

export function startBrowserRecordingSession(input: BrowserRecordingStartInput): BrowserRecordingStartResult {
    const activeRecordingId = input.state.activeRecordingIdByViewId[input.viewId];
    if (activeRecordingId) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: createUnavailableReason(
                'browser_recording_already_active',
                'policyDenied',
                'Only one browser recording can be active for a view.',
            ),
        };
    }

    const unavailable = resolveBrowserRecordingAvailability({
        browserRecordingEnabled: input.browserRecordingEnabled,
        recordingCapabilities: input.recordingCapabilities,
        adapterKind: input.adapterKind,
        renderEngineKind: input.renderEngineKind,
        captureKind: input.captureKind,
        mimeType: input.mimeType,
        retentionClass: input.retentionClass,
        policyState: input.policyState,
        captureSourceAvailable: input.captureSourceAvailable,
    });
    if (unavailable) {
        return {
            status: 'unavailable',
            state: input.state,
            reason: unavailable,
        };
    }

    const recording: BrowserRecordingSessionV1 = BrowserRecordingSessionV1Schema.parse({
        v: 1,
        recordingId: buildRecordingId(input),
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        profileId: input.profileId,
        targetKind: input.targetKind,
        adapterKind: input.adapterKind,
        renderEngineKind: input.renderEngineKind,
        captureKind: input.captureKind,
        fidelity: input.fidelity,
        startedAtMs: input.startedAtMs,
        status: 'recording',
        navigationGenerationStart: input.navigationGeneration,
        durationMs: 0,
        byteSize: 0,
        frameCount: 0,
        fps: input.recordingCapabilities.maxFps,
        mimeType: input.mimeType,
        retentionClass: input.retentionClass,
        redactionLevel: 'metadataOnly',
        policyState: input.policyState ?? 'allowed',
        maxDurationMs: input.recordingCapabilities.maxDurationMs,
        maxBytes: input.recordingCapabilities.maxBytes,
    });

    return {
        status: 'started',
        state: putRecording(input.state, recording, true),
        recordingId: recording.recordingId,
    };
}

function resolveLifecycleOutcome(event: BrowserRecordingLifecycleEvent): Readonly<{
    status: BrowserRecordingSessionV1['status'];
    outcomeReason: BrowserRecordingOutcomeReasonV1;
    keepActive: boolean;
}> {
    switch (event) {
        case 'hidden':
            return { status: 'paused', outcomeReason: 'view_hidden', keepActive: true };
        case 'parked':
            return { status: 'paused', outcomeReason: 'view_parked', keepActive: true };
        case 'suspended':
            return { status: 'paused', outcomeReason: 'view_suspended', keepActive: true };
        case 'hostLost':
            return { status: 'failed', outcomeReason: 'host_lost', keepActive: false };
        case 'closed':
            return { status: 'discarded', outcomeReason: 'view_closed', keepActive: false };
    }
}

export function applyBrowserRecordingLifecycleEvent(
    state: BrowserRecordingState,
    input: Readonly<{
        viewId: string;
        event: BrowserRecordingLifecycleEvent;
        canContinueCapture: boolean;
        atMs: number;
    }>,
): BrowserRecordingLifecycleResult {
    const recordingId = state.activeRecordingIdByViewId[input.viewId];
    const current = recordingId ? state.sessionsById[recordingId] : undefined;
    if (!current) {
        return {
            status: 'unavailable',
            state,
            reason: createUnavailableReason(
                'browser_recording_missing',
                'captureUnavailable',
                'No active browser recording is available for this view.',
            ),
        };
    }

    if (input.canContinueCapture) {
        const updated = BrowserRecordingSessionV1Schema.parse({
            ...current,
            durationMs: durationFrom(current, input.atMs),
        });
        return {
            status: 'updated',
            state: putRecording(state, updated, true),
            recording: updated,
        };
    }

    const outcome = resolveLifecycleOutcome(input.event);
    const updated = BrowserRecordingSessionV1Schema.parse({
        ...current,
        status: outcome.status,
        outcomeReason: outcome.outcomeReason,
        stoppedAtMs: input.atMs,
        durationMs: durationFrom(current, input.atMs),
        mediaRef: undefined,
    });

    return {
        status: 'updated',
        state: putRecording(state, updated, outcome.keepActive),
        recording: updated,
    };
}

export function finalizeBrowserRecordingSession(
    state: BrowserRecordingState,
    input: BrowserRecordingFinalizeInput,
): BrowserRecordingFinalizeResult {
    const current = state.sessionsById[input.recordingId];
    if (!current) {
        return {
            status: 'unavailable',
            state,
            reason: createUnavailableReason(
                'browser_recording_missing',
                'captureUnavailable',
                'Browser recording is no longer available.',
            ),
        };
    }

    const finalized = BrowserRecordingSessionV1Schema.parse({
        ...current,
        status: 'finalized',
        outcomeReason: 'user_stopped',
        stoppedAtMs: input.stoppedAtMs,
        navigationGenerationEnd: input.navigationGenerationEnd,
        durationMs: input.durationMs,
        byteSize: input.byteSize,
        frameCount: input.frameCount,
        fps: input.fps,
        mediaRef: input.mediaRef,
        expiresAtMs: input.expiresAtMs,
    });

    return {
        status: 'finalized',
        state: putRecording(state, finalized, false),
        recording: finalized,
    };
}

export function cleanupExpiredBrowserRecordings(
    state: BrowserRecordingState,
    input: Readonly<{ nowMs: number }>,
): BrowserRecordingCleanupResult {
    let next = state;
    const discardedRecordingIds: string[] = [];

    for (const recordingId of state.sessionOrder) {
        const recording = next.sessionsById[recordingId];
        if (!recording?.expiresAtMs || recording.expiresAtMs > input.nowMs) continue;
        if (recording.status !== 'completed' && recording.status !== 'finalized') continue;

        const discarded = BrowserRecordingSessionV1Schema.parse({
            ...recording,
            status: 'discarded',
            outcomeReason: 'retention_limit',
            mediaRef: undefined,
        });
        next = putRecording(next, discarded, false);
        discardedRecordingIds.push(recordingId);
    }

    return { state: next, discardedRecordingIds };
}

function resolveAttachmentUnavailable(
    state: BrowserRecordingState,
    input: BrowserRecordingAttachmentInput,
): BrowserRecordingUnavailableReason | null {
    if (!input.browserRecordingEnabled) {
        return createUnavailableReason(
            'browser_recording_disabled',
            'permissionDenied',
            'Browser recording is disabled.',
        );
    }
    if (!input.browserRecordingAttachmentsEnabled) {
        return createUnavailableReason(
            'browser_recording_attachments_disabled',
            'permissionDenied',
            'Browser recording attachments are disabled.',
        );
    }
    if (!input.attachmentsUploadsEnabled) {
        return createUnavailableReason(
            'browser_recording_attachment_uploads_disabled',
            'permissionDenied',
            'Attachment uploads are required for browser recording attachments.',
        );
    }
    if (!input.sessionMediaPolicyAllowed) {
        return createUnavailableReason(
            'browser_recording_session_media_policy_denied',
            'policyDenied',
            'Session media policy does not allow browser recording attachments.',
        );
    }
    if (!input.browserContextPolicyAllowed) {
        return createUnavailableReason(
            'browser_recording_context_policy_denied',
            'policyDenied',
            'Browser context policy does not allow recording attachments.',
        );
    }
    const recording = state.sessionsById[input.recordingId];
    if (!recording) {
        return createUnavailableReason(
            'browser_recording_missing',
            'captureUnavailable',
            'Browser recording is no longer available.',
        );
    }
    if (recording.status !== 'completed' && recording.status !== 'finalized') {
        return createUnavailableReason(
            'browser_recording_not_finalized',
            'captureUnavailable',
            'Browser recording is not finalized.',
        );
    }
    if (!recording.mediaRef) {
        return createUnavailableReason(
            'browser_recording_media_missing',
            'captureUnavailable',
            'Browser recording media reference is unavailable.',
        );
    }
    return null;
}

export function attachBrowserRecordingToComposer(
    state: BrowserRecordingState,
    input: BrowserRecordingAttachmentInput,
): BrowserRecordingAttachResult {
    const unavailable = resolveAttachmentUnavailable(state, input);
    if (unavailable) {
        return {
            status: 'unavailable',
            state,
            reason: unavailable,
        };
    }

    const recording = state.sessionsById[input.recordingId];
    const mediaRef = recording?.mediaRef;
    if (!recording || !mediaRef) {
        return {
            status: 'unavailable',
            state,
            reason: createUnavailableReason(
                'browser_recording_media_missing',
                'captureUnavailable',
                'Browser recording media reference is unavailable.',
            ),
        };
    }
    const exists = state.attachmentsById[input.attachmentId] !== undefined;
    return {
        status: 'attached',
        state: {
            ...state,
            sessionsById: {
                ...state.sessionsById,
                [input.recordingId]: {
                    ...recording,
                    retentionClass: 'attached',
                },
            },
            attachmentsById: {
                ...state.attachmentsById,
                [input.attachmentId]: {
                    attachmentId: input.attachmentId,
                    recordingId: input.recordingId,
                    mediaRef,
                },
            },
            attachmentOrder: exists ? state.attachmentOrder : [...state.attachmentOrder, input.attachmentId],
        },
        attachmentId: input.attachmentId,
    };
}
