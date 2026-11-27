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

export function replaceBrowserRecordingViewSnapshot(
    state: BrowserRecordingState,
    view: Pick<BrowserRecordingSessionV1, 'browserSessionId' | 'viewId'>,
    recordings: readonly BrowserRecordingSessionV1[],
): BrowserRecordingState {
    const removed = new Set(Object.values(state.sessionsById)
        .filter(recording => recording.browserSessionId === view.browserSessionId && recording.viewId === view.viewId)
        .map(recording => recording.recordingId));
    const retained = {
        ...state,
        sessionsById: Object.fromEntries(Object.entries(state.sessionsById).filter(([id]) => !removed.has(id))),
        sessionOrder: state.sessionOrder.filter(id => !removed.has(id)),
        activeRecordingIdByViewId: Object.fromEntries(Object.entries(state.activeRecordingIdByViewId).filter(([, id]) => !removed.has(id))),
    };
    return recordings.reduce(applyBrowserRecordingSessionSnapshot, retained);
}
