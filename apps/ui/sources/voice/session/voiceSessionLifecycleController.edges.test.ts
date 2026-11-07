import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
    getStorage, loadLocalVoiceEngineWithCompatState, localVoiceHomeId, machineRpcWithServerScope,
    localVoiceSpeechOutputBoundary, registerLocalVoiceEngineHarnessHooks,
    setPlatformOs, warmLocalVoiceEngineHarnessGraph, waitForLocalVoiceBoundaryEvent,
} from '@/voice/local/localVoiceEngine.testHarness';
import { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';

import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import type { VoiceAdapterController, VoiceSessionSnapshot } from './types';

// Vitest does not select Metro's platform suffix. Exercise the real native PCM
// owner beneath the installed OS boundary, rather than the unsupported fallback.
vi.mock('@/voice/runtime/daemonInference/DaemonSpeechPcmCapture', () => import('../runtime/daemonInference/DaemonSpeechPcmCapture.native'));

// Register the existing OS/Socket boundaries before the real Sync/Voice graph.
const { AppState } = await import('react-native');
const appState = createReactNativeAppStateEmitter();
const restoreAppState = appState.install(AppState);
const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('./voiceAdapterRegistry');
const { sync } = await import('@/sync/sync');
const { isServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
registerLocalVoiceEngineHarnessHooks();
afterAll(() => { restoreHarnessModuleLoader(); restoreAppState(); });

async function configureLocalProvider(providerId: 'local_direct' | 'local_conversation', mode: 'direct_session' | 'agent' = 'direct_session') {
    await loadLocalVoiceEngineWithCompatState();
    const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { readLocalDirectVoiceSettings, readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
    const storage = await getStorage();
    const voice = storage.getState().settings.voice;
    const config = providerId === 'local_direct'
        ? readLocalDirectVoiceSettings(voice) : readLocalConversationVoiceSettings(voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
        ...voice, providerId, executionMachine: { mode: 'fixed', machineId: 'machine-1' },
        providers: { ...voice.providers, [providerId]: {
            schemaVersion: 1, config: { ...config,
                ...(providerId === 'local_conversation' ? { conversationMode: mode } : {}),
                tts: { ...config.tts, autoSpeakReplies: false },
            },
        } },
    } } });
    registerVoiceAdapters([createLocalDirectVoiceAdapter(), createLocalConversationVoiceAdapter()]);
    return { storage, target: { serverId: localVoiceHomeId, sessionId: 's1' } };
}

async function createOpenAiAttempt(
    onCreatePeer?: (peer: import('@/dev/testkit/harness/voiceWebRtcHarness').TestVoiceWebRtcPeer) => void,
    createAudioContext?: () => AudioContext,
) {
    setPlatformOs('web');
    const { createOpenAiVoiceRuntimeEnvironment } = await import('@/dev/testkit/harness/openAiVoiceRuntime');
    const { installVoiceWebRtcBrowserBoundary } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext, onCreatePeer: peer => {
        // Physical negotiation opens each fresh SDK channel; no controller or
        // reconnect policy is substituted, and a closed peer is never reused.
        peer.setRemoteDescription.mockImplementation(async () => { peer.channel.open(); });
        onCreatePeer?.(peer);
    } });
    const runtime = await environment.createRuntime(browser);
    const controller = createVoiceSessionLifecycleController();
    controller.setConfiguredProviderId(runtime.adapter.id);
    return { environment, browser, runtime, controller, async dispose() {
        await controller.dispose();
        await runtime.runtime.dispose();
        runtime.hostLease.revoke();
        browser.restore();
        await environment.dispose();
    } };
}

async function installSameIdHomeTargets(environment: Awaited<ReturnType<typeof createOpenAiAttempt>>['environment'], sessionId = 'same-session') {
    const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
    const { createSessionReadBatchFetchBoundary } = await import('@/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const { answerVoiceRealtimePreparationHttpRequest } = await import('@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary');
    const homeA = environment.accountConnection.home;
    const homeB = await upsertServerProfileOnly({ serverUrl: 'https://lifecycle-home-b.example.test' });
    const credentialsB = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'lifecycle-account-b' })).toString('base64url')}.signature` };
    const writeB = await TokenStorage.setCredentialsForServerUrlWithRollback(homeB.serverUrl, { serverId: homeB.id }, credentialsB);
    if (!writeB) throw new Error('Expected saved Home credential write');
    const targets = [homeA, homeB].map(home => ({ serverId: home.id, sessionId }));
    const sessions = [homeA, homeB].map(() => {
        const boundary = createSessionMetadataHttpBoundary(() => ({}));
        boundary.replaceSession(sessionId, createPlainSessionCurrentProjectionRecordFixture({
            id: sessionId, metadata: { path: '/repo', host: 'lifecycle-test', flavor: 'claude' },
        }));
        return boundary;
    });
    const reads: Array<{ serverUrl: string; path: string; authorization: string | null }> = [];
    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === 'https://api.openai.com') return environment.providerFetch(input, init);
        const index = [homeA, homeB].findIndex(home => new URL(home.serverUrl).origin === url.origin);
        if (index === -1) throw new Error('Unexpected lifecycle Home HTTP origin');
        reads.push({ serverUrl: index === 0 ? homeA.serverUrl : homeB.serverUrl, path: url.pathname,
            authorization: new Headers(init?.headers).get('authorization') });
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        if (url.pathname === `/v2/sessions/${encodeURIComponent(sessionId)}`) return sessions[index]!.handle(input, init)!;
        // B owns an independent empty plain prompt/settings catalog; never
        // borrow the active A Account's authoring inputs for B preparation.
        if (index === 1) {
            const preparation = answerVoiceRealtimePreparationHttpRequest(input, {});
            if (preparation) return preparation;
        }
        // B is a saved target Home, not a fabricated second active Account.
        // Never serve A's Profile/settings as B; unclaimed B routes fail closed.
        if (index === 1) return sessions[1]!.handle(input, init) ?? Response.json({}, { status: 404 });
        return await environment.homeRequest(input, init) ?? Response.json({}, { status: 404 });
    }));
    return { targets, reads, homeA, homeB, credentialsB, async dispose() { await writeB.rollback(); } };
}

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';

const sessionAddress = (sessionId: string) => ({ serverId: 'server-1', sessionId });

afterEach(async () => {
    const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
    await resetVoiceSessionRuntimeStateForTests();
});

function createSnapshotPublisher(initial: VoiceSessionSnapshot): Readonly<{
    getSnapshot: () => VoiceSessionSnapshot;
    publish: (next: VoiceSessionSnapshot) => void;
    subscribe: (listener: () => void) => () => void;
}> {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => snapshot,
        publish: (next) => {
            snapshot = next;
            for (const listener of listeners) listener();
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

describe('voice session lifecycle edge contracts', () => {
    it('keeps End truthful while real local capture retires ahead of a pending daemon stop', async () => {
        const { storage, target } = await configureLocalProvider('local_direct');
        const { readLocalDirectVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const { DaemonVoiceInferenceModelsWarmResponseSchema,
            DaemonVoiceInferenceSttStreamStartResponseSchema, DaemonVoiceInferenceSttStreamCancelResponseSchema,
            DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT } = await import('@happier-dev/protocol/daemon/voiceInference');
        const { getSharedVoicePcmCapture } = await import('@happier-dev/audio-stream-native');
        const voice = storage.getState().settings.voice;
        const config = readLocalDirectVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providers: { ...voice.providers, local_direct: { schemaVersion: 1, config: {
                ...config, handsFree: { ...config.handsFree, enabled: true },
                stt: { ...config.stt, provider: 'local_neural', localNeural: {
                    ...config.stt.localNeural, execution: 'daemon', assetId: 'daemon-stt',
                } },
            } } },
        } } });
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Expected incumbent machine Socket responder');
        let releaseRemoteStop!: () => void;
        const remoteStop = new Promise<void>(resolve => { releaseRemoteStop = resolve; });
        let remoteStopEntered = false;
        const remoteStopStarted = createDeferred<void>();
        machineRpcWithServerScope.mockImplementation(async request => {
            if (request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM) {
                return DaemonVoiceInferenceModelsWarmResponseSchema.parse({ ok: true, models: [] });
            }
            if (request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START) {
                return DaemonVoiceInferenceSttStreamStartResponseSchema.parse({ ok: true,
                    requestId: request.payload.requestId, streamId: 'end-track-stream', generation: 1,
                    ackSeq: -1, format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
            }
            if (request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL) {
                remoteStopEntered = true;
                remoteStopStarted.resolve();
                await remoteStop;
                return DaemonVoiceInferenceSttStreamCancelResponseSchema.parse({ ok: true,
                    streamId: 'end-track-stream', generation: 1 });
            }
            return incumbent(request);
        });
        const capture = getSharedVoicePcmCapture();
        if (!capture) throw new Error('Expected installed native PCM owner');
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId('local_direct');
        const terminalCapture: number[] = [];
        const unsubscribe = controller.subscribe(() => {
            if (!controller.getSnapshot().canStop) terminalCapture.push(capture.getSnapshot().subscriberCount);
        });
        let stopping: Promise<void> | undefined;
        try {
            await controller.toggle(target);
            expect(controller.getSnapshot(), JSON.stringify(controller.getSnapshot())).toMatchObject({ status: 'connected', canStop: true });
            expect(capture.getSnapshot().subscriberCount).toBeGreaterThan(0);
            stopping = controller.stop(target.sessionId);
            await Promise.race([remoteStopStarted.promise, stopping]);
            expect(remoteStopEntered).toBe(true);
            expect(controller.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle', canStop: true });
            expect(capture.getSnapshot().subscriberCount).toBe(0);
            releaseRemoteStop();
            await stopping;
            expect(controller.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
            expect(terminalCapture.length).toBeGreaterThan(0);
            expect(terminalCapture.every(count => count === 0)).toBe(true);
        } finally { unsubscribe(); releaseRemoteStop(); await stopping; await controller.dispose(); }
    }, 120_000);

    it('dismisses a real failed attempt only after physical capture cleanup and permits a fresh explicit Start', async () => {
        const { TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');
        const contexts: InstanceType<typeof TestVoiceAudioContext>[] = [];
        let failFirstOffer = true;
        let rejectOffer!: (error: Error) => void;
        const offer = new Promise<RTCSessionDescriptionInit>((_resolve, reject) => { rejectOffer = reject; });
        const offerStarted = createDeferred<void>();
        void offer.catch(() => {});
        const attempt = await createOpenAiAttempt(peer => {
            if (!failFirstOffer) return;
            failFirstOffer = false;
            peer.createOffer.mockImplementationOnce(() => {
                offerStarted.resolve();
                return offer;
            });
        }, () => {
            const context = new TestVoiceAudioContext();
            if (contexts.length === 0) context.close.mockRejectedValueOnce(new Error('AudioContext close failed'));
            contexts.push(context);
            // Canonical fixture represents the browser SDK AudioContext port.
            return context as unknown as AudioContext;
        });
        const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
        const { getVoiceSessionEndedAttempt, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const terminalMedia: Array<{ tracks: MediaStreamTrackState[]; peers: RTCPeerConnectionState[]; hasStream: boolean }> = [];
        const unsubscribe = attempt.controller.subscribe(() => {
            const snapshot = attempt.controller.getSnapshot();
            setVoiceSessionSnapshot(snapshot);
            if (snapshot.status !== 'error' || snapshot.canStop) return;
            terminalMedia.push({ tracks: attempt.browser.micTracks.map(track => track.readyState),
                peers: attempt.browser.peers.map(peer => peer.connectionState),
                hasStream: attempt.browser.micSession.getStream() !== null });
        });
        try {
            const starting = attempt.controller.toggle(null);
            await Promise.race([offerStarted.promise, starting]);
            expect(attempt.browser.peers[0]?.createOffer).toHaveBeenCalled();
            const context = contexts[0];
            if (!context) throw new Error('Expected actual acquired browser AudioContext');
            expect(attempt.browser.micSession.getAudioContext?.()).toBe(context);
            expect(attempt.browser.micTrack.readyState).toBe('live');
            rejectOffer(new TypeError('Network unavailable'));
            await starting;
            const failure = attempt.controller.getSnapshot();
            expect(failure).toMatchObject({ status: 'error', canStop: false,
                errorCode: 'voice_connection_failed', errorMessage: 'voice_connection_failed', errorRecoveryAction: 'retry' });
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            expect(context.close).toHaveBeenCalledTimes(1);
            expect(terminalMedia.length).toBeGreaterThan(0);
            for (const media of terminalMedia) expect(media).toEqual({ tracks: ['ended'], peers: ['closed'], hasStream: false });
            const firstTrack = attempt.browser.micTrack;
            const firstPeer = attempt.browser.peer;
            expect(firstTrack.readyState).toBe('ended');
            expect(firstTrack.stop).toHaveBeenCalledTimes(1);
            expect(firstPeer.connectionState).toBe('closed');
            expect(attempt.browser.micSession.getStream()).toBeNull();
            await attempt.controller.dismissFailedAttempt('another-visible-session');
            expect(attempt.controller.getSnapshot()).toEqual(failure);
            await attempt.controller.dismissFailedAttempt(failure.sessionId);
            expect(attempt.controller.getSnapshot()).toEqual({
                adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
            });
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            firstPeer.dispatchEvent(new Event('connectionstatechange'));
            firstPeer.channel.message({ type: 'error', error: { type: 'invalid_request_error', code: 'late_failure' } });
            await Promise.resolve();
            expect(attempt.controller.getSnapshot()).toEqual({
                adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
            });
            const requests = attempt.environment.providerFetch.mock.calls.length;
            await attempt.controller.retry('another-visible-session');
            expect(attempt.environment.providerFetch).toHaveBeenCalledTimes(requests);
            expect(attempt.browser.micTracks).toEqual([firstTrack]);
            const dictation = voiceCaptureAdmissionController.acquire('dictation');
            expect(dictation.status).toBe('acquired');
            if (dictation.status === 'acquired') dictation.lease.release();
            await attempt.controller.toggle(null);
            expect(attempt.controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(attempt.browser.micTrack).not.toBe(firstTrack);
            expect(attempt.browser.micTrack.readyState).toBe('live');
            expect(attempt.browser.peer).not.toBe(firstPeer);
        } finally { rejectOffer(new Error('Test cleanup')); unsubscribe(); await attempt.dispose(); }
    }, 120_000);

    it('dismisses a real terminal disconnected Local Agent attempt without losing recovery', async () => {
        const { storage, target } = await configureLocalProvider('local_conversation', 'agent');
        const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const { DaemonVoiceInferenceModelsWarmResponseSchema } = await import('@happier-dev/protocol/daemon/voiceInference');
        const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
        const incumbent = machineRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Expected incumbent machine Socket responder');
        let releaseWarm!: () => void;
        const warm = new Promise<unknown>(resolve => { releaseWarm = () => resolve(
            DaemonVoiceInferenceModelsWarmResponseSchema.parse({
                ok: false, errorCode: 'model_not_installed', error: 'Daemon model is not installed',
            }),
        ); });
        machineRpcWithServerScope.mockImplementation(request => request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM
            ? warm : incumbent(request));
        const voice = storage.getState().settings.voice;
        const config = readLocalConversationVoiceSettings(voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...voice, providers: { ...voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...config, tts: { ...config.tts, provider: 'local_neural', autoSpeakReplies: false,
                    localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                        voiceId: 'af_heart', speed: 1, execution: 'daemon' },
                },
            } } },
        } } });
        const controller = createVoiceSessionLifecycleController();
        controller.setConfiguredProviderId('local_conversation');
        const { createVoiceContinuationProjection } = await import('@/voice/transcript/voiceContinuationProjection');
        const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
        const continuation = createVoiceContinuationProjection();
        const notes: string[] = [];
        const unsubscribeContinuation = controller.subscribe(() => {
            const snapshot = controller.getSnapshot();
            const binding = snapshot.sessionId ? voiceConversationBindingResolver.resolveByControlSessionId({
                controlSessionId: snapshot.sessionId, adapterId: snapshot.adapterId,
            }) : null;
            const note = continuation.update({ snapshot, binding, deviceId: 'local-device', sessionSeq: 0 });
            if (note) {
                notes.push(note.localId);
                continuation.settle(note, true);
            }
        });
        try {
            await controller.toggle(target);
            expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(notes).toHaveLength(1);
            await waitForLocalVoiceBoundaryEvent(`rpc:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM}`);
            expect(machineRpcWithServerScope.mock.calls.some(([request]) =>
                request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM)).toBe(true);
            const coordinator = localVoiceSpeechOutputBoundary.getAudioSessionCoordinator();
            if (!coordinator) throw new Error('Expected actual native audio session coordinator');
            expect(coordinator.getSnapshot().leaseCount).toBeGreaterThan(0);
            expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(1);
            releaseWarm();
            await waitForTestEvent(controller.subscribe, controller.getSnapshot, snapshot => snapshot.status === 'disconnected' && !snapshot.canStop);
            expect(controller.getSnapshot()).toMatchObject({
                status: 'disconnected', canStop: false, errorCode: 'provider_error',
                errorMessage: 'daemon_voice_inference_model_not_installed', errorRecoveryAction: 'retry',
            });
            const failure = controller.getSnapshot();
            expect(getVoiceAdapterRegistry().get('local_conversation')?.getSnapshot()).toEqual(failure);
            expect(coordinator.getSnapshot().leaseCount).toBeGreaterThan(0);
            expect(localVoiceSpeechOutputBoundary.fileRecording.stop).not.toHaveBeenCalled();
            const heldDictation = voiceCaptureAdmissionController.acquire('dictation');
            if (heldDictation.status === 'acquired') heldDictation.lease.release();
            expect(heldDictation.status).toBe('busy');
            await controller.dismissFailedAttempt('another-session');
            expect(controller.getSnapshot()).toEqual(failure);
            await controller.dismissFailedAttempt(failure.sessionId);
            expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalledTimes(1);
            expect(coordinator.getSnapshot().leaseCount).toBe(0);
            expect(controller.getSnapshot()).toEqual({
                adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
            });
            expect(notes).toHaveLength(1);
            await controller.retry('another-session');
            expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(1);
            const dictation = voiceCaptureAdmissionController.acquire('dictation');
            expect(dictation.status).toBe('acquired');
            if (dictation.status === 'acquired') dictation.lease.release();
        } finally { unsubscribeContinuation(); releaseWarm(); await controller.dispose(); }
    });

    it.each([
        { status: 'error', rejectCleanup: false, replaceDuringCleanup: false },
        { status: 'error', rejectCleanup: true, replaceDuringCleanup: false },
        { status: 'disconnected', rejectCleanup: false, replaceDuringCleanup: true },
    ] as const)('dismisses synthetic terminal $status (cleanup rejected: $rejectCleanup, replaced: $replaceDuringCleanup) without losing recovery', async ({ status, rejectCleanup, replaceDuringCleanup }) => {
        const { getVoiceSessionEndedAttempt, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
        });
        let mediaHeld = false;
        let cleanupRejected = rejectCleanup;
        let releaseCleanup!: () => void;
        const cleanup = replaceDuringCleanup ? new Promise<void>((resolve) => { releaseCleanup = resolve; }) : Promise.resolve();
        const start = vi.fn(async ({ sessionId }: Readonly<{ sessionId: string }>) => {
            mediaHeld = true;
            snapshots.publish({ adapterId: OPENAI_PROVIDER_ID, sessionId, status: 'connected', mode: 'listening', canStop: true });
        });
        // Qualified F: this synthetic terminal-with-held-media premise has no
        // established real OpenAI producer. closeAttempt releases resources
        // before failed publication; WebMic consumes AudioContext.close rejection.
        // Preserve the four distinct contracts until a reachable producer or a
        // stronger GREEN keeper establishes the dismissal/recovery world.
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID, engineKind: 'realtime', start,
            stop: async () => {
                if (cleanupRejected) {
                    cleanupRejected = false;
                    throw new Error('media_cleanup_failed');
                }
                await cleanup;
                mediaHeld = false;
            },
            toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
            getSnapshot: snapshots.getSnapshot, subscribe: snapshots.subscribe,
        };
        const captureAdmission = createVoiceCaptureAdmissionController();
        const releaseConnectivity = vi.fn();
        const controller = createVoiceSessionLifecycleController({
            captureAdmission, acquireConnectivityLease: () => releaseConnectivity,
            getRegistry: () => ({ get: () => adapter, list: () => [adapter] }),
        });
        const unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
        try {
            controller.setConfiguredProviderId(adapter.id);
            await controller.toggle({ serverId: 'home-a', sessionId: 'voice-session' });
            const failure: VoiceSessionSnapshot = {
                adapterId: adapter.id, sessionId: 'voice-session', status, mode: 'idle', canStop: false,
                errorCode: 'network_error', errorRecoveryAction: 'retry', errorPresentation: 'error',
            };
            snapshots.publish(failure);
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            await controller.dismissFailedAttempt('another-session');
            expect(controller.getSnapshot()).toMatchObject(failure);
            if (rejectCleanup) {
                await expect(controller.dismissFailedAttempt('voice-session')).rejects.toThrow('media_cleanup_failed');
                expect(mediaHeld).toBe(true);
                expect(controller.getSnapshot()).toMatchObject(failure);
                await controller.retry('another-session');
                expect(start).toHaveBeenCalledTimes(2);
                expect(controller.getSnapshot().status).toBe('connected');
                return;
            }
            const dismissal = controller.dismissFailedAttempt('voice-session');
            if (replaceDuringCleanup) {
                const target = { serverId: 'home-b', sessionId: 'new-session' };
                const replacement = controller.toggle(target);
                expect(start).toHaveBeenCalledTimes(1);
                releaseCleanup();
                await replacement;
                snapshots.publish({ ...failure, sessionId: target.sessionId });
                await dismissal;
                expect(controller.getSnapshot()).toMatchObject({ ...failure, sessionId: target.sessionId });
                await controller.retry('voice-session');
                expect(start).toHaveBeenLastCalledWith(expect.objectContaining({
                    sessionId: target.sessionId, requestedTargetSessionAddress: target,
                }));
                expect(controller.getSnapshot().status).toBe('connected');
                return;
            }
            await dismissal;
            expect(mediaHeld).toBe(false);
            expect(releaseConnectivity).toHaveBeenCalled();
            expect(controller.getSnapshot()).toEqual({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            expect(getVoiceSessionEndedAttempt()).toBeNull();
            snapshots.publish({ ...failure });
            expect(controller.getSnapshot().status).toBe('disconnected');
            expect(controller.getSnapshot().errorCode).toBeUndefined();
            await controller.retry('voice-session');
            expect(start).toHaveBeenCalledTimes(1);
            const capture = captureAdmission.acquire('dictation');
            expect(capture.status).toBe('acquired');
            if (capture.status === 'acquired') capture.lease.release();
            await controller.toggle({ serverId: 'home-b', sessionId: 'new-session' });
            expect(controller.getSnapshot().status).toBe('connected');
        } finally {
            unsubscribe();
            await controller.dispose();
        }
    });

    it.each(['connecting', 'connected'] as const)('refuses to dismiss a live %s attempt', async (status) => {
        const { target } = await configureLocalProvider('local_direct');
        let releaseRecording: (() => void) | undefined;
        let rejectRecording: ((error: Error) => void) | undefined;
        if (status === 'connecting') {
            const pendingRecording = new Promise<{ recordingId: string }>((resolve, reject) => {
                releaseRecording = () => resolve({ recordingId: 'live-dismissal-recording' });
                rejectRecording = reject;
            });
            localVoiceSpeechOutputBoundary.fileRecording.start.mockImplementationOnce(() => pendingRecording);
        }
        const controller = createVoiceSessionLifecycleController({
            acquireConnectivityLease: () => sync.acquireUserRequestLease(),
        });
        controller.setConfiguredProviderId('local_direct');
        const start = controller.toggle(target);
        try {
            if (status === 'connected') await start;
            else {
                await waitForLocalVoiceBoundaryEvent('audio-start');
                expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalled();
            }
            const live = controller.getSnapshot();
            expect(live).toMatchObject({ status, canStop: true });
            await controller.dismissFailedAttempt(target.sessionId);
            expect(controller.getSnapshot()).toEqual(live);
            expect(localVoiceSpeechOutputBoundary.fileRecording.stop).not.toHaveBeenCalled();
            appState.emit('background');
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
            if (status === 'connecting') {
                rejectRecording?.(new Error('Native recording unavailable'));
                await start.catch(() => {});
                expect(controller.getSnapshot().canStop).toBe(false);
                expect(isServerReachabilityNetworkAllowed()).toBe(false);
            }
        } finally {
            releaseRecording?.();
            await start.catch(() => {});
            await controller.dispose();
            appState.emit('active');
        }
    }, 120_000);

    it('refuses to dismiss a synthetic live error attempt', async () => {
        // Qualified F: inspected real OpenAI/local projections publish terminal
        // failures with canStop:false; no live error producer is established yet.
        const snapshots = createSnapshotPublisher({
            adapterId: OPENAI_PROVIDER_ID, sessionId: 'voice-session', status: 'error', mode: 'listening', canStop: true,
            errorCode: 'network_error', errorPresentation: 'error',
        });
        let mediaHeld = true;
        const adapter: VoiceAdapterController = {
            id: OPENAI_PROVIDER_ID, engineKind: 'realtime', start: async () => {},
            stop: async () => { mediaHeld = false; },
            toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
            getSnapshot: snapshots.getSnapshot, subscribe: snapshots.subscribe,
        };
        const controller = createVoiceSessionLifecycleController({ getRegistry: () => ({ get: () => adapter, list: () => [adapter] }) });
        try {
            controller.setConfiguredProviderId(adapter.id);
            await controller.dismissFailedAttempt('voice-session');
            expect(controller.getSnapshot()).toEqual(snapshots.getSnapshot());
            expect(mediaHeld).toBe(true);
        } finally {
            await controller.dispose();
        }
    });

    it('retries the exact failed Home binding and honors a later explicit global start', async () => {
        const attempt = await createOpenAiAttempt();
        const homes = await installSameIdHomeTargets(attempt.environment);
        const { controller, environment } = attempt;
        try {
            for (const target of homes.targets) {
                // The public caller selects a hydrated Session. Let actual
                // HTTP/Sync publish its owner metadata before provider preflight.
                const hydration = await sync.ensureSessionVisibleForMessageRoute(target.sessionId, {
                    serverId: target.serverId, forceRefresh: true, hydrateMessages: false,
                });
                expect(hydration, JSON.stringify(hydration)).toMatchObject({ kind: 'available', serverId: target.serverId });
                environment.providerFetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
                await controller.toggle(target).catch(() => {});
                expect(controller.getSnapshot()).toMatchObject({ canStop: false, errorRecoveryAction: 'retry' });
                expect(controller.getAttemptTargetSessionAddress()).toEqual(target);
                const failedRequests = environment.providerFetch.mock.calls.length;
                await controller.retry('another-visible-session');
                expect(environment.providerFetch.mock.calls.length, JSON.stringify(controller.getSnapshot())).toBeGreaterThan(failedRequests);
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                expect(controller.getAttemptTargetSessionAddress()).toEqual(target);
                await controller.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            }
            environment.providerFetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
            await sync.ensureSessionVisibleForMessageRoute('same-session', {
                serverId: homes.homeA.id, forceRefresh: true, hydrateMessages: false,
            });
            await controller.toggle(homes.targets[0]!).catch(() => {});
            await controller.toggle(null);
            expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(controller.getAttemptTargetSessionAddress()).toBeNull();
            await controller.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            environment.providerFetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
            await controller.toggle(null).catch(() => {});
            await controller.retry(VOICE_AGENT_GLOBAL_SESSION_ID);
            expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(controller.getAttemptTargetSessionAddress()).toBeNull();
            for (const home of [homes.homeA, homes.homeB]) {
                expect(homes.reads).toContainEqual(expect.objectContaining({
                    serverUrl: home.serverUrl, path: '/v2/sessions/same-session',
                }));
            }
            expect(homes.reads.filter(read => read.serverUrl === homes.homeB.serverUrl
                && read.path === '/v2/sessions/same-session')).toEqual(expect.arrayContaining([
                    expect.objectContaining({ authorization: `Bearer ${homes.credentialsB.token}` }),
                ]));
        } finally { await homes.dispose(); await attempt.dispose(); }
    }, 180_000);

    it.each(['end', 'account', 'provider', 'global_binding'] as const)('retires the failed binding after %s without starting a targetless retry', async (retirement) => {
        const attempt = await createOpenAiAttempt();
        const { controller, environment, browser } = attempt;
        try {
            const { storage } = await import('@/sync/domains/state/storage');
            const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
            const target = { serverId: environment.accountConnection.home.id, sessionId: 'same-session' };
            storage.getState().applySessions([createSessionFixture({ id: target.sessionId, serverId: target.serverId,
                encryptionMode: 'plain', metadata: { path: '/repo', host: 'lifecycle-test', flavor: 'claude' },
            })]);
            environment.sessionHttp.replaceSession(target.sessionId);
            environment.providerFetch.mockRejectedValueOnce(new TypeError('Network unavailable'));
            await controller.toggle(retirement === 'global_binding' ? null : target).catch(() => {});
            expect(controller.getSnapshot()).toMatchObject({ canStop: false, errorRecoveryAction: 'retry' });
            expect(controller.getAttemptTargetSessionAddress()).toEqual(retirement === 'global_binding' ? null : target);
            const providerRequests = environment.providerFetch.mock.calls.length;
            expect(providerRequests).toBeGreaterThan(0);
            expect(browser.micSession.ensureActive).not.toHaveBeenCalled();
            if (retirement === 'end') await controller.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            if (retirement === 'account') {
                const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
                const lifetime = captureActiveServerAccountScopeLifetime();
                expect(lifetime?.isCurrent()).toBe(true);
                await environment.accountConnection.dispose();
                expect(lifetime?.isCurrent()).toBe(false);
                controller.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
            }
            if (retirement === 'global_binding') {
                const previous = environment.persistedAccountSettings.voiceSettingsV1;
                await environment.installConnectedAccountSettings();
                expect(environment.persistedAccountSettings.voiceSettingsV1).not.toEqual(previous);
                controller.rearmAfterCredentialAuthorityChange({ globalBindingAuthorityChanged: true });
            }
            if (retirement === 'provider') {
                controller.setConfiguredProviderId('off');
                controller.setConfiguredProviderId(OPENAI_PROVIDER_ID);
            }
            await controller.retry('another-visible-session');
            expect(environment.providerFetch.mock.calls.length).toBe(providerRequests);
            expect(controller.getSnapshot().canStop).toBe(false);
            expect(controller.getAttemptTargetSessionAddress()).toBeNull();
        } finally { await attempt.dispose(); }
    }, 120_000);

    it('holds routine connectivity through the exact active Voice attempt', async () => {
        const { target } = await configureLocalProvider('local_direct');
        const controller = createVoiceSessionLifecycleController({
            acquireConnectivityLease: () => sync.acquireUserRequestLease(),
        });
        try {
            controller.setConfiguredProviderId('local_direct');
            await controller.toggle(target);
            expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
            expect(controller.getAttemptTargetSessionAddress()).toEqual(target);
            expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalledTimes(1);
            appState.emit('background');
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
            await controller.stop(target.sessionId);
            expect(controller.getSnapshot().canStop).toBe(false);
            expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            appState.emit('active');
            await controller.dispose();
        }
    }, 120_000);

    it('does not release connectivity for an initial disconnected snapshot while Start is still pending', async () => {
        const { target } = await configureLocalProvider('local_direct');
        let rejectRecording!: (error: Error) => void;
        const recording = new Promise<{ recordingId: string }>((_resolve, reject) => {
            rejectRecording = reject;
        });
        localVoiceSpeechOutputBoundary.fileRecording.start.mockImplementationOnce(() => recording);
        const controller = createVoiceSessionLifecycleController({
            acquireConnectivityLease: () => sync.acquireUserRequestLease(),
        });
        controller.setConfiguredProviderId('local_direct');
        const starting = controller.toggle(target);
        void starting.catch(() => {});
        try {
            // Real Local Direct binding admission yields before capture begins.
            // Republish that actual initial snapshot while Start owns its lease.
            expect(getVoiceAdapterRegistry().get('local_direct')?.getSnapshot().status).toBe('disconnected');
            appState.emit('background');
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
            controller.setConfiguredProviderId('local_direct');
            expect(controller.getSnapshot().status).toBe('disconnected');
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
            await waitForLocalVoiceBoundaryEvent('audio-start');
            expect(localVoiceSpeechOutputBoundary.fileRecording.start).toHaveBeenCalled();
            expect(controller.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
            rejectRecording(new Error('Native recording unavailable'));
            await expect(starting).rejects.toThrow('Native recording unavailable');
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            rejectRecording(new Error('Test cleanup'));
            await starting.catch(() => {});
            await controller.dispose();
            appState.emit('active');
        }
    }, 120_000);

    it.each([false, true])('Start consumes Machine readiness before reporting a missing plugin adapter (Machine reachable: %s)', async (reachable) => {
        const { storage } = await configureLocalProvider('local_conversation');
        const settings = storage.getState().settings;
        storage.__setState({ settings: { ...settings, voice: { ...settings.voice,
            executionMachine: { mode: 'fixed', machineId: 'machine-1' },
        } } });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected active Voice Account');
        if (!reachable) recordMachineRequestFailed({ ...lifetime.scope, machineId: 'machine-1' });
        const providerId = 'happier.voice.xai/realtime-grok';
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const { resolveVoiceRoleReadiness } = await import('@/voice/registry/readiness');
        const { resolveVoiceExecutionMachineSelectionFromState, projectVoiceExecutionMachineReadiness } = await import('@/voice/settings/executionMachine');
        const { resolveVoiceSurfaceRecovery } = await import('@/components/voice/surface/resolveVoiceSurfaceRecovery');
        const { resolveVoiceMachineErrorTranslationKey } = await import('@/voice/runtime/machine/voiceMachineErrorCopy');
        const selection = resolveVoiceExecutionMachineSelectionFromState(storage.getState());
        expect(selection.kind).toBe(reachable ? 'resolved' : 'selected_unreachable');
        const readiness = resolveVoiceRoleReadiness({ registry: createDefaultVoiceProviderRegistry(),
            providerId, role: 'realtime_conversation', platform: 'web', modeId: 'byo',
            facts: { settings: 'ready', credential: 'ready',
                executionMachine: projectVoiceExecutionMachineReadiness(selection.kind, 'machineId' in selection ? selection.machineId : null) } });
        const captureAdmission = createVoiceCaptureAdmissionController();
        const published = vi.fn();
        const controller = createVoiceSessionLifecycleController({
            captureAdmission,
        });
        controller.setConfiguredProviderId(providerId);
        const unsubscribe = controller.subscribe(published);

        try {
            await controller.toggle(sessionAddress('session-1'));

            expect(controller.getSnapshot()).toEqual({
                adapterId: providerId,
                sessionId: 'session-1',
                status: 'error',
                mode: 'idle',
                canStop: false,
                errorCode: 'service_temporarily_unavailable',
                errorMessage: reachable ? 'voice_provider_adapter_not_registered' : readiness.code,
                errorRecoveryAction: reachable ? 'retry' : readiness.recoveryAction,
                errorPresentation: 'error',
                recoveryTarget: null,
            });
            if (!reachable) {
                const snapshot = controller.getSnapshot();
                expect(snapshot.errorMessage).toBe('execution_machine_incompatible');
                expect(resolveVoiceMachineErrorTranslationKey('execution_machine_unavailable', snapshot.errorMessage)).toBe(readiness.reasonKey);
                expect(resolveVoiceSurfaceRecovery(snapshot.errorRecoveryAction)?.labelKey).toBe('common.retry');
            }
            expect(published).toHaveBeenCalledTimes(1);

            // Repeated Start on the same unavailable selection retains the
            // current refusal instead of publishing/erroring again.
            await controller.toggle(sessionAddress('session-1'));
            expect(published).toHaveBeenCalledTimes(1);

            const dictationAdmission = captureAdmission.acquire('dictation');
            expect(dictationAdmission).toMatchObject({ status: 'acquired' });
            if (dictationAdmission.status === 'acquired') dictationAdmission.lease.release();

            if (!reachable) {
                const rpc = machineRpcWithServerScope.getMockImplementation()!;
                machineRpcWithServerScope.mockImplementation(async request => request.method === RPC_METHODS.CAPABILITIES_DETECT
                    ? { protocolVersion: 1, results: {} } : rpc(request));
                await controller.retry('session-1');
                expect(resolveVoiceExecutionMachineSelectionFromState(storage.getState()).kind).toBe('resolved');
                expect(controller.getSnapshot()).toMatchObject({ errorMessage: 'voice_provider_adapter_not_registered' });
            }

            // The refusal belongs only to the selected provider/session. A
            // later selection must not inherit that stale error.
            controller.setConfiguredProviderId('local_conversation');
            expect(controller.getSnapshot()).toEqual({
                adapterId: null,
                sessionId: null,
                status: 'disconnected',
                mode: 'idle',
                canStop: false,
            });
        } finally {
            unsubscribe();
            await controller.dispose();
        }
    });

    it('retains the exact Home address when an unavailable same-id target is replaced before Retry', async () => {
        const attempt = await createOpenAiAttempt();
        // Each scenario owns its server records; A and B still share this id.
        const homes = await installSameIdHomeTargets(attempt.environment, 'replacement-session');
        let replacement: Awaited<ReturnType<typeof attempt.environment.createRuntime>> | null = null;
        try {
            await attempt.runtime.runtime.dispose();
            registerVoiceAdapters([]);
            expect(getVoiceAdapterRegistry().get(OPENAI_PROVIDER_ID)).toBeNull();
            await attempt.controller.toggle(homes.targets[0]!);
            await attempt.controller.toggle(homes.targets[1]!);
            expect(attempt.controller.getSnapshot().errorCode).toBe('service_temporarily_unavailable');
            expect(attempt.environment.providerFetch).not.toHaveBeenCalled();
            replacement = await attempt.environment.createRuntime(attempt.browser);
            const hydration = await sync.ensureSessionVisibleForMessageRoute(homes.targets[1]!.sessionId, {
                serverId: homes.homeB.id, forceRefresh: true, hydrateMessages: false,
            });
            expect(hydration, JSON.stringify(hydration)).toMatchObject({ kind: 'available', serverId: homes.homeB.id });
            await attempt.controller.retry(homes.targets[1]!.sessionId);
            expect(attempt.controller.getSnapshot(), JSON.stringify(attempt.controller.getSnapshot())).toMatchObject({ status: 'connected', canStop: true });
            expect(attempt.controller.getAttemptTargetSessionAddress()).toEqual(homes.targets[1]);
            expect(homes.reads).toContainEqual(expect.objectContaining({
                serverUrl: homes.homeB.serverUrl, path: `/v2/sessions/${homes.targets[1]!.sessionId}`,
                authorization: `Bearer ${homes.credentialsB.token}`,
            }));
        } finally {
            await attempt.controller.dispose();
            if (replacement) { await replacement.runtime.dispose(); replacement.hostLease.revoke(); }
            await homes.dispose();
            await attempt.dispose();
        }
    }, 120_000);
});
