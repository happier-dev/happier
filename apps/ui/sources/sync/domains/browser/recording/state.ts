import { BrowserRecordingSessionV1Schema, type BrowserRecordingPolicyStateV1, type BrowserRecordingSessionV1 } from '@happier-dev/protocol/browser/recording/v1';
import { resolveBrowserRecordingProfileUnavailableReason } from '@happier-dev/protocol/browser/recording/captureProfiles';

import type {
    BrowserRecordingAvailabilityInput,
    BrowserRecordingState,
    BrowserRecordingUnavailableReason,
    BrowserRecordingUnavailableReasonCode,
} from './types';

function createUnavailableReason(
    reasonCode: BrowserRecordingUnavailableReasonCode,
    policyState: BrowserRecordingPolicyStateV1,
    message: string,
): BrowserRecordingUnavailableReason {
    return { reasonCode, policyState, message };
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
