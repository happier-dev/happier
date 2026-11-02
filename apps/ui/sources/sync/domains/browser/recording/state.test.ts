import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol/browser/recording/v1';
import { describe, expect, it } from 'vitest';

import { applyBrowserRecordingSessionSnapshot, createBrowserRecordingState } from './state';

describe('browser recording snapshot projection', () => {
    it('applies daemon recording snapshots while maintaining the one-active-recording index', () => {
        const recording: BrowserRecordingSessionV1 = {
            v: 1,
            recordingId: 'recording_daemon_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            status: 'recording',
            navigationGenerationStart: 7,
            durationMs: 0,
            byteSize: 0,
            frameCount: 0,
            fps: 12,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            redactionLevel: 'metadataOnly',
            policyState: 'allowed',
            actionChapters: [],
            relatedReferences: [],
        };

        const activeState = applyBrowserRecordingSessionSnapshot(createBrowserRecordingState(), recording);
        expect(activeState.sessionsById.recording_daemon_1).toEqual(recording);
        expect(activeState.activeRecordingIdByViewId.view_1).toBe('recording_daemon_1');

        const finalized = {
            ...recording,
            status: 'finalized',
            outcomeReason: 'user_stopped',
            stoppedAtMs: 12_000,
            navigationGenerationEnd: 8,
            durationMs: 2_000,
            byteSize: 800_000,
            frameCount: 24,
            mediaRef: {
                refKind: 'sessionMedia',
                mediaId: 'media_recording_1',
                mediaKind: 'video',
                mimeType: 'video/webm',
                sizeBytes: 800_000,
            },
        } satisfies BrowserRecordingSessionV1;
        const finalizedState = applyBrowserRecordingSessionSnapshot(activeState, finalized);
        expect(finalizedState.sessionsById.recording_daemon_1).toEqual(finalized);
        expect(finalizedState.sessionOrder).toEqual(['recording_daemon_1']);
        expect(finalizedState.activeRecordingIdByViewId.view_1).toBeUndefined();
    });
});
