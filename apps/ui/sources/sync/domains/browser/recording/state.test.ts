import type {
    BrowserRecordingCapabilities,
    BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

async function loadRecordingStateModule(): Promise<Record<string, unknown> | null> {
    return import('./state').catch(() => null);
}

const recordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['simulatorPreview'],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

describe('browser recording state', () => {
    it('starts one active recording per view and fails closed when the recording gate or policy is unavailable', async () => {
        const mod = await loadRecordingStateModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        const createBrowserRecordingState = mod.createBrowserRecordingState as () => unknown;
        const startBrowserRecordingSession = mod.startBrowserRecordingSession as (input: any) => any;

        const started = startBrowserRecordingSession({
            state: createBrowserRecordingState(),
            browserRecordingEnabled: true,
            recordingCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            navigationGeneration: 7,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            captureSourceAvailable: true,
        });

        expect(started.status).toBe('started');
        const duplicate = startBrowserRecordingSession({
            state: started.state,
            browserRecordingEnabled: true,
            recordingCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_100,
            navigationGeneration: 7,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            captureSourceAvailable: true,
        });
        expect(duplicate).toMatchObject({
            status: 'unavailable',
            reason: { reasonCode: 'browser_recording_already_active' },
        });

        const disabled = startBrowserRecordingSession({
            state: createBrowserRecordingState(),
            browserRecordingEnabled: false,
            recordingCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            navigationGeneration: 7,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            captureSourceAvailable: true,
        });
        expect(disabled).toMatchObject({
            status: 'unavailable',
            reason: { reasonCode: 'browser_recording_disabled', policyState: 'permissionDenied' },
        });
    });

    it('records hidden, parked, suspended, host-lost, and closed lifecycle outcomes explicitly', async () => {
        const mod = await loadRecordingStateModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        const createBrowserRecordingState = mod.createBrowserRecordingState as () => unknown;
        const startBrowserRecordingSession = mod.startBrowserRecordingSession as (input: any) => any;
        const applyBrowserRecordingLifecycleEvent = mod.applyBrowserRecordingLifecycleEvent as (state: any, input: any) => any;

        const started = startBrowserRecordingSession({
            state: createBrowserRecordingState(),
            browserRecordingEnabled: true,
            recordingCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            navigationGeneration: 7,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            captureSourceAvailable: true,
        });
        if (started.status !== 'started') throw new Error('expected recording to start');

        const hidden = applyBrowserRecordingLifecycleEvent(started.state, {
            viewId: 'view_1',
            event: 'hidden',
            canContinueCapture: false,
            atMs: 11_000,
        });
        expect(hidden.recording).toMatchObject({ status: 'paused', outcomeReason: 'view_hidden' });

        for (const [event, outcomeReason] of [
            ['parked', 'view_parked'],
            ['suspended', 'view_suspended'],
            ['hostLost', 'host_lost'],
            ['closed', 'view_closed'],
        ] as const) {
            const fresh = startBrowserRecordingSession({
                state: createBrowserRecordingState(),
                browserRecordingEnabled: true,
                recordingCapabilities,
                browserSessionId: 'browser_session_1',
                viewId: `view_${event}`,
                profileId: 'profile_1',
                targetKind: 'simulatorPreview',
                adapterKind: 'simulatorPreview',
                renderEngineKind: 'streamedSurface',
                captureKind: 'streamFrameCapture',
                fidelity: 'streamFrame',
                startedAtMs: 10_000,
                navigationGeneration: 7,
                mimeType: 'video/webm',
                retentionClass: 'preSend',
                captureSourceAvailable: true,
            });
            if (fresh.status !== 'started') throw new Error('expected recording to start');
            const result = applyBrowserRecordingLifecycleEvent(fresh.state, {
                viewId: `view_${event}`,
                event,
                canContinueCapture: false,
                atMs: 11_000,
            });
            expect(result.recording.outcomeReason).toBe(outcomeReason);
            expect(['paused', 'failed', 'discarded']).toContain(result.recording.status);
        }
    });

    it('finalizes by reference, discards temporary media on retention cleanup, and never stores inline bytes', async () => {
        const mod = await loadRecordingStateModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        const createBrowserRecordingState = mod.createBrowserRecordingState as () => unknown;
        const startBrowserRecordingSession = mod.startBrowserRecordingSession as (input: any) => any;
        const finalizeBrowserRecordingSession = mod.finalizeBrowserRecordingSession as (state: any, input: any) => any;
        const cleanupExpiredBrowserRecordings = mod.cleanupExpiredBrowserRecordings as (state: any, input: any) => any;

        const started = startBrowserRecordingSession({
            state: createBrowserRecordingState(),
            browserRecordingEnabled: true,
            recordingCapabilities,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            navigationGeneration: 7,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            captureSourceAvailable: true,
        });
        if (started.status !== 'started') throw new Error('expected recording to start');

        const finalized = finalizeBrowserRecordingSession(started.state, {
            recordingId: started.recordingId,
            stoppedAtMs: 12_000,
            navigationGenerationEnd: 8,
            durationMs: 2_000,
            byteSize: 800_000,
            frameCount: 24,
            fps: 12,
            mediaRef: {
                refKind: 'sessionMedia',
                mediaId: 'media_recording_1',
                mediaKind: 'video',
                mimeType: 'video/webm',
                sizeBytes: 800_000,
            },
            expiresAtMs: 13_000,
        });

        expect(finalized.recording).toMatchObject({
            status: 'finalized',
            mediaRef: { mediaId: 'media_recording_1' },
        });
        expect(JSON.stringify(finalized.recording)).not.toContain('base64');

        const cleaned = cleanupExpiredBrowserRecordings(finalized.state, { nowMs: 13_001 });
        expect(cleaned.discardedRecordingIds).toEqual([started.recordingId]);
        expect(cleaned.state.sessionsById[started.recordingId]).toMatchObject({
            status: 'discarded',
            outcomeReason: 'retention_limit',
            mediaRef: undefined,
        });
    });

    it('applies daemon recording snapshots while maintaining the one-active-recording index', async () => {
        const mod = await loadRecordingStateModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        const createBrowserRecordingState = mod.createBrowserRecordingState as () => unknown;
        const applyBrowserRecordingSessionSnapshot = mod.applyBrowserRecordingSessionSnapshot as (
            state: any,
            recording: BrowserRecordingSessionV1,
        ) => unknown;
        expect(applyBrowserRecordingSessionSnapshot).toBeTypeOf('function');

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
            maxDurationMs: 30_000,
            maxBytes: 16_000_000,
            actionChapters: [],
            relatedReferences: [],
        };

        const activeState = applyBrowserRecordingSessionSnapshot(createBrowserRecordingState(), recording) as any;
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
        const finalizedState = applyBrowserRecordingSessionSnapshot(activeState, finalized) as any;
        expect(finalizedState.sessionsById.recording_daemon_1).toEqual(finalized);
        expect(finalizedState.sessionOrder).toEqual(['recording_daemon_1']);
        expect(finalizedState.activeRecordingIdByViewId.view_1).toBeUndefined();
    });

    it('attaches recordings to composer only when every browser, attachment, media, and context gate is available', async () => {
        const mod = await loadRecordingStateModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        const createBrowserRecordingState = mod.createBrowserRecordingState as () => unknown;
        const attachBrowserRecordingToComposer = mod.attachBrowserRecordingToComposer as (state: any, input: any) => any;
        const recording: BrowserRecordingSessionV1 = {
            v: 1,
            recordingId: 'recording_1',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            profileId: 'profile_1',
            targetKind: 'simulatorPreview',
            adapterKind: 'simulatorPreview',
            renderEngineKind: 'streamedSurface',
            captureKind: 'streamFrameCapture',
            fidelity: 'streamFrame',
            startedAtMs: 10_000,
            stoppedAtMs: 12_000,
            status: 'finalized',
            outcomeReason: 'user_stopped',
            navigationGenerationStart: 7,
            navigationGenerationEnd: 8,
            durationMs: 2_000,
            byteSize: 800_000,
            frameCount: 24,
            fps: 12,
            mimeType: 'video/webm',
            retentionClass: 'preSend',
            redactionLevel: 'metadataOnly',
            policyState: 'allowed',
            maxDurationMs: 30_000,
            maxBytes: 16_000_000,
            mediaRef: {
                refKind: 'sessionMedia',
                mediaId: 'media_recording_1',
                mediaKind: 'video',
                mimeType: 'video/webm',
                sizeBytes: 800_000,
            },
            actionChapters: [],
            relatedReferences: [],
        };
        const state = {
            ...createBrowserRecordingState() as any,
            sessionsById: { recording_1: recording },
            sessionOrder: ['recording_1'],
        };

        const denied = attachBrowserRecordingToComposer(state, {
            recordingId: 'recording_1',
            attachmentId: 'attachment_1',
            browserRecordingEnabled: true,
            browserRecordingAttachmentsEnabled: false,
            attachmentsUploadsEnabled: true,
            sessionMediaPolicyAllowed: true,
            browserContextPolicyAllowed: true,
        });
        expect(denied).toMatchObject({
            status: 'unavailable',
            reason: { reasonCode: 'browser_recording_attachments_disabled' },
        });

        const attached = attachBrowserRecordingToComposer(state, {
            recordingId: 'recording_1',
            attachmentId: 'attachment_1',
            browserRecordingEnabled: true,
            browserRecordingAttachmentsEnabled: true,
            attachmentsUploadsEnabled: true,
            sessionMediaPolicyAllowed: true,
            browserContextPolicyAllowed: true,
        });
        expect(attached).toMatchObject({
            status: 'attached',
            attachmentId: 'attachment_1',
        });
        expect(attached.state.attachmentsById.attachment_1).toMatchObject({
            recordingId: 'recording_1',
            mediaRef: { mediaId: 'media_recording_1' },
        });
    });
});
