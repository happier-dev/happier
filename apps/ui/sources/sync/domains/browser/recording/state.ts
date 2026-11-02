import { BrowserRecordingSessionV1Schema, type BrowserRecordingSessionV1 } from '@happier-dev/protocol/browser/recording/v1';
export { resolveBrowserRecordingAvailability } from '@happier-dev/protocol/browser/recording/captureProfiles';

import type {
    BrowserRecordingState,
} from './types';

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
