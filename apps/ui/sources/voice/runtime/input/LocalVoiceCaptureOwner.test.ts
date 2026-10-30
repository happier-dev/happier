import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module, { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
const network = await installSessionOpsNetworkBoundary();
import { Platform } from 'react-native';
import type {
    HappierAudioStreamNativeModule,
} from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';
import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT, FeaturesResponseSchema,
    MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { DaemonVoiceInferenceSttStreamStartRequestSchema, DaemonVoiceInferenceSttStreamChunkRequestSchema,
    DaemonVoiceInferenceSttStreamStartResponseSchema, DaemonVoiceInferenceSttStreamChunkResponseSchema,
    DaemonVoiceInferenceSttStreamFinishResponseSchema, DaemonVoiceInferenceSttStreamCancelResponseSchema,
    type DaemonVoiceInferenceSttStreamEvent } from '@happier-dev/protocol/daemon/voiceInference';

import type { TurnEndpointSignal } from './TurnEndpointController';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import { createDeferred } from '@/dev/testkit';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import type { SherpaNativeModule } from '@happier-dev/sherpa-native';

// The installed OS module has one identity for the process. The package's
// unmodified registry owns its real capture and audio-session coordinator.
const nativeSystem = createNativeVoicePcmCaptureHarness();
const nativeStartImplementation = vi.mocked(nativeSystem.nativeModule.start).getMockImplementation();
let filesystem: ReturnType<typeof createMemFs>;
const sdk = vi.hoisted(() => ({
    permission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    recognitionStart: vi.fn(), recognitionStop: vi.fn(), recognitionAbort: vi.fn(),
    recognitionListeners: new Map<string, Set<(event: unknown) => void>>(),
    sherpaCreate: vi.fn<SherpaNativeModule['createStreamingRecognizer']>(async () => {}),
    sherpaPush: vi.fn<SherpaNativeModule['pushAudioFrame']>(async () => ({ text: 'interrupt that', isEndpoint: false })),
    sherpaFinish: vi.fn<SherpaNativeModule['finishStreaming']>(async () => ({ status: 'finalized', text: 'interrupt that' })),
    sherpaCancel: vi.fn<SherpaNativeModule['cancel']>(async () => {}),
}));
vi.mock('expo-modules-core', async importOriginal => {
    const actual = await importOriginal<typeof import('expo-modules-core')>();
    return { ...actual, requireOptionalNativeModule: (name: string) => {
        if (name === 'HappierAudioStreamNative') return nativeSystem.nativeModule;
        if (name === 'HappierSherpaNative') return {
            createStreamingRecognizer: sdk.sherpaCreate, pushAudioFrame: sdk.sherpaPush,
            finishStreaming: sdk.sherpaFinish, cancel: sdk.sherpaCancel,
        };
        return actual.requireOptionalNativeModule(name);
    } };
});
vi.mock('expo-audio', async importOriginal => {
    const actual = await importOriginal<typeof import('expo-audio')>();
    return { ...actual, AudioModule: { ...actual.AudioModule,
        requestRecordingPermissionsAsync: sdk.permission, setAudioModeAsync: vi.fn(async () => {}),
    } };
});
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: sdk.permission,
    addListener: (name: string, listener: (event: unknown) => void) => {
        const listeners = sdk.recognitionListeners.get(name) ?? new Set();
        listeners.add(listener); sdk.recognitionListeners.set(name, listeners);
        return { remove: () => listeners.delete(listener) };
    },
    start: sdk.recognitionStart, stop: sdk.recognitionStop, abort: sdk.recognitionAbort,
} }));
vi.mock('@/voice/runtime/daemonInference/DaemonSpeechPcmCapture', () => import('../daemonInference/DaemonSpeechPcmCapture.native'));

function emitRecognition(name: string, event: unknown = {}): void {
    for (const listener of [...(sdk.recognitionListeners.get(name) ?? [])]) listener(event);
}

// The real microphone permission surface reaches Sync through Modal. Load its
// canonical composition before importing capture leaves, avoiding a test-only
// partial-module cycle through the eagerly constructed local Voice engine.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createVoiceFileRecording, getSharedVoicePcmCapture, getSharedVoiceAudioSessionCoordinator } = await import('@happier-dev/audio-stream-native');
const capture = getSharedVoicePcmCapture();
const coordinator = getSharedVoiceAudioSessionCoordinator();
if (!capture || !coordinator) throw new Error('Installed native audio SDK capture unavailable');
const nativeAudio = { ...nativeSystem, capture, coordinator };
const { createLocalVoiceCaptureOwner: createActualLocalVoiceCaptureOwner } = await import('./LocalVoiceCaptureOwner');
const { resolveNativeSileroVadBridge } = await import('./NativeSileroVadBridge');
const { createNativeVadController } = await import('./NativeVadController');
const { createVoiceCaptureAdmissionBinding } = await import('./VoiceCaptureAdmissionBinding');
const { createVoiceCaptureAdmissionController } = await import('./VoiceCaptureAdmissionController');
const { classifyVoiceMachineError } = await import('../machine/voiceMachineError');
const { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } = await import('@/voice/adapters/local/settings');
const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
const { createSherpaStreamingSttController } = await import('@/voice/input/SherpaStreamingSttController');
const { createExpoAudioRecordingMicSession } = await import('../mic/NativeMicSession');
const { createLiveMicSession: createWebLiveMicSession } = await import('../mic/createLiveMicSession.web');
const { installVoiceWebRtcBrowserBoundary, TestVoiceAudioContext } = await import('@/dev/testkit/harness/voiceWebRtcHarness');

// Metro selects the web factory synchronously. An asynchronous vi.mock alias
// introduces a different import cycle through real Modal/Sync, so select the
// complete real platform factory at this existing composition option instead.
const captureOwners: Array<ReturnType<typeof createActualLocalVoiceCaptureOwner>> = [];
function createLocalVoiceCaptureOwner(
    deps: Parameters<typeof createActualLocalVoiceCaptureOwner>[0],
    options: Parameters<typeof createActualLocalVoiceCaptureOwner>[1] = {},
) {
    const owner = createActualLocalVoiceCaptureOwner(deps, {
        ...(Platform.OS === 'web' ? { createLiveMicSession: createWebLiveMicSession } : {}),
        ...options,
    });
    captureOwners.push(owner);
    return owner;
}

// Node's deferred CJS lookup and Metro resolve the same real factories. Vitest
// needs that platform-loader bridge; none of these entries substitute owners.
const requireForTest = createRequire(import.meta.url);
const factoryBridges = [
    ['../../input/DeviceSttController.ts', { createDeviceSttController }],
    ['../../input/SherpaStreamingSttController.ts', { createSherpaStreamingSttController }],
    ['../mic/NativeMicSession.ts', { createExpoAudioRecordingMicSession }],
] as const;
const previousFactoryModules = new Map<string, NodeJS.Module | undefined>();
for (const [path, exports] of factoryBridges) {
    const id = requireForTest.resolve(path);
    previousFactoryModules.set(id, requireForTest.cache[id]);
    const bridge = new Module(id); bridge.exports = exports; requireForTest.cache[id] = bridge;
}
afterAll(async () => {
    await network.dispose();
    for (const [id, prior] of previousFactoryModules) {
        if (prior) requireForTest.cache[id] = prior; else delete requireForTest.cache[id];
    }
});

const packBytes = new TextEncoder().encode('native model fixture');
const installedManifest = parseModelPackManifest({ packId: 'local-owner-pack', kind: 'stt_sherpa',
    model: 'zipformer_transducer', version: 'v1',
    files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'].map(path => ({
        path, url: `https://example.test/${path}`, sizeBytes: packBytes.length,
        sha256: createHash('sha256').update(packBytes).digest('hex'),
    })),
});
const neuralSettings = { voice: { providerId: 'local_conversation', providers: {
    local_conversation: { schemaVersion: 1, config: { stt: { provider: 'local_neural',
        localNeural: { assetId: installedManifest.packId, language: 'en', execution: 'device' } } } },
} } };

const recordingSessions: Array<ReturnType<typeof createExpoAudioRecordingMicSession>> = [];
function createRecordingBoundary(uri: string | null = 'blob:voice-end-recording') {
    const recorder = { uri, prepareToRecordAsync: vi.fn(async () => {}), record: vi.fn(),
        pause: vi.fn(), stop: vi.fn(async () => {}) };
    const session = createExpoAudioRecordingMicSession({ createRecorder: () => recorder });
    recordingSessions.push(session);
    return { recorder, session };
}

function installBrowserCaptureBoundary() {
    (Platform as { OS: string }).OS = 'web';
    const audioContext = new TestVoiceAudioContext();
    const browser = installVoiceWebRtcBrowserBoundary({ createAudioContext: () => audioContext as unknown as AudioContext });
    const capture = browser.allocateCapture();
    const captureEntered = createDeferred<void>();
    const trackStopped = createDeferred<void>();
    const stopTrack = vi.mocked(capture.track.stop).getMockImplementation();
    if (!stopTrack) throw new Error('Browser track stop boundary missing');
    vi.mocked(capture.track.stop).mockImplementation(() => { stopTrack(); trackStopped.resolve(); });
    const captureAcquire = vi.fn(async () => capture.stream);
    const permissionTrack = { stop: vi.fn() };
    const permissionStream = { getTracks: () => [permissionTrack] } as unknown as MediaStream;
    // Permission probing and capture are separate browser acquisitions. A
    // stopped permission-probe track must not be the capture resource.
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async constraints => {
        if (constraints?.audio === true) return permissionStream;
        captureEntered.resolve();
        return await captureAcquire();
    });
    vi.stubGlobal('window', { AudioContext: vi.fn(() => audioContext) });
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    return { micStream: capture.stream, micTrack: capture.track,
        audioContext, captureAcquire, captureEntered: captureEntered.promise, trackStopped: trackStopped.promise,
        getUserMedia: vi.mocked(navigator.mediaDevices.getUserMedia) };
}

const accountCleanups: Array<() => Promise<void>> = [];
async function installDaemonCaptureBoundary() {
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
    const { createMachineFixture } = await import('@/dev/testkit');
    const { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
    const { VoiceLocalSttSchema } = await import('@/sync/domains/settings/voiceLocalSttSettings');
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    network.resetRequests();
    const serverUrl = 'https://local-capture.example.test';
    await network.addHome(serverUrl, 'artifact-account');
    const previousState = storage.getState();
    const features = FeaturesResponseSchema.parse({ features: {
        voice: { enabled: true }, execution: { runs: { enabled: true } },
        machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
    }, capabilities: { machines: { liveStream: { serverRouted: {
        caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } });
    const account = await createPlainArtifactHomeFixture(serverUrl, { serverFeatures: features,
        handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    const machine = createMachineFixture({ id: 'capture-machine', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
    const voice = voiceSettingsParse({ providerId: 'local_conversation',
        executionMachine: { mode: 'fixed', machineId: machine.id } });
    const configuredVoice = writeLocalConversationVoiceSettings(voice, {
        ...readLocalConversationVoiceSettings(voice),
        stt: VoiceLocalSttSchema.parse({ provider: 'local_neural', localNeural: {
            assetId: installedManifest.packId, language: 'en', execution: 'daemon',
        } }),
    });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
        voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
    }, ...normalizeVoiceSettingsLocalDelta({ voice: configuredVoice }, storage.getState().settings) });
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
        snapshot: { status: 'ready', features } });
    accountCleanups.push(async () => {
        await account.dispose();
        storage.setState(previousState, true);
        resetServerFeaturesClientForTests();
    });
    const boundary = { finalText: 'daemon transcript', events: [] as DaemonVoiceInferenceSttStreamEvent[],
        start: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    };
    let ackSeq = -1;
    network.setRpcResponder(async request => {
        expect(request.targetId).toBe(machine.id);
        expect(request.serverUrl).toBe(serverUrl);
        switch (request.method) {
            case 'daemon.voiceInference.stt.stream.start': {
                const payload = DaemonVoiceInferenceSttStreamStartRequestSchema.parse(request.payload);
                await boundary.start();
                return DaemonVoiceInferenceSttStreamStartResponseSchema.parse({ ok: true, requestId: payload.requestId,
                    streamId: 'capture-stream', generation: 1, ackSeq: -1, format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT });
            }
            case 'daemon.voiceInference.stt.stream.chunk': {
                const payload = DaemonVoiceInferenceSttStreamChunkRequestSchema.parse(request.payload);
                ackSeq = payload.seq;
                return DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: true, streamId: 'capture-stream',
                    generation: 1, ackSeq, events: boundary.events });
            }
            case 'daemon.voiceInference.stt.stream.finish':
                await boundary.finish();
                return DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({ ok: true, streamId: 'capture-stream',
                    generation: 1, ackSeq, finalText: boundary.finalText, language: 'en', modelPackId: installedManifest.packId, events: [] });
            case 'daemon.voiceInference.stt.stream.cancel':
                await boundary.cancel();
                return DaemonVoiceInferenceSttStreamCancelResponseSchema.parse({ ok: true, streamId: 'capture-stream', generation: 1 });
            default: throw new Error(`unexpected capture RPC: ${request.method}`);
        }
    });
    return { ...boundary, getSettings: () => storage.getState().settings, boundary, machine, account };
}

const micVadNew = vi.fn();
const micVadStart = vi.fn();
const micVadPause = vi.fn();
let activeOnSpeechEnd: (() => void) | null = null;
let activeOnSpeechStart: (() => void) | null = null;

const nativeFileBoundary = vi.hoisted(() => {
    const file = {
        exists: true,
        delete: vi.fn(async () => {}),
    };
    return {
        file,
        File: vi.fn(function File(_uri: string) {
            return file;
        }),
    };
});

vi.mock('@ricky0123/vad-web', () => ({
    MicVAD: {
        new: (...args: unknown[]) => micVadNew(...args),
    },
}));

vi.mock('expo-file-system', () => ({
    get Paths() { return filesystem.fs.Paths; },
    get Directory() { return filesystem.fs.Directory; },
    File: class {
        constructor(...args: unknown[]) {
            const first = args[0];
            const uri = typeof first === 'string' ? first
                : first && typeof first === 'object' && 'uri' in first && typeof first.uri === 'string' ? first.uri : '';
            if (uri.startsWith(filesystem.fs.Paths.document)) {
                return new filesystem.fs.File(...args);
            }
            return nativeFileBoundary.File(String(args[0]));
        }
    },
}));

// WebVadController is platform-split for Metro (`WebVadController.ts` is the
// native-safe no-op fallback that keeps `@ricky0123/vad-web` -> `onnxruntime-web`
// out of the native bundle; `WebVadController.web.ts` holds the real
// implementation this suite exercises via the `@ricky0123/vad-web` mock above).
// Vitest has no Metro-style platform resolution for the unsuffixed import
// `LocalVoiceCaptureOwner.ts` uses, so point it at the real web implementation —
// its own `isDomRuntime()` guard still gates behavior identically to before the
// split when `window`/`document` are not simulated by a given test.
vi.mock('@/voice/runtime/input/WebVadController', () => import('./WebVadController.web'));


function createSharedNativePcmHarness(options: Readonly<{
    nativeStart?: HappierAudioStreamNativeModule['start'];
}> = {}) {
    const nativeStart = vi.mocked(nativeAudio.nativeModule.start);
    if (options.nativeStart) nativeStart.mockImplementation(options.nativeStart);
    return {
        ...nativeAudio,
        emitFrame: nativeAudio.emit,
        nativeStart,
        nativeStop: vi.mocked(nativeAudio.nativeModule.stop),
        platformApply: vi.mocked(nativeAudio.nativeModule.configureAudioSession),
    };
}


describe('createLocalVoiceCaptureOwner', () => {
    const originalPlatformOs = Platform.OS;
    it.each([
        { handsFree: true, settings: {} },
        { handsFree: false, settings: { voice: { providerId: 'local_conversation', providers: {
            local_conversation: { schemaVersion: 1, config: { tts: { bargeInEnabled: true } } },
        } } } },
    ])('refuses word-gated capture before acquiring audio when installed segmentation is unavailable: $handsFree', async ({ handsFree, settings }) => {
        const unavailableIntl = Object.create(Intl);
        Object.defineProperty(unavailableIntl, 'Segmenter', { value: undefined });
        vi.stubGlobal('Intl', unavailableIntl);
        try {
            const owner = createLocalVoiceCaptureOwner({
                getSettings: () => settings, onCaptureStarted: () => {}, onCaptureError: () => {},
            });
            const failure = await owner.startCapture({
                sessionId: 'missing-segmentation', handsFree, provider: 'local_neural',
                localNeuralExecution: 'daemon',
            }).then(() => null, (error: unknown) => error);
            expect(classifyVoiceMachineError(failure)).toMatchObject({
                kind: 'provider_setup_required', reason: 'voice_text_segmentation_unavailable',
                presentation: 'error', recoverable: false,
            });
            expect(owner.isCaptureActive('missing-segmentation')).toBe(false);
            expect(owner.isHandsFreeCaptureSession({ sessionId: 'missing-segmentation', provider: 'local_neural' })).toBe(false);
            await owner.stopSession('missing-segmentation');
        } finally {
            vi.unstubAllGlobals();
        }
    });
    const previousWindow = (globalThis as { window?: object }).window;
    const previousDocument = (globalThis as { document?: object }).document;

    beforeEach(() => {
        (Platform as { OS: string }).OS = 'android';
        vi.mocked(nativeAudio.nativeModule.start).mockReset();
        if (nativeStartImplementation) vi.mocked(nativeAudio.nativeModule.start).mockImplementation(nativeStartImplementation);
        vi.mocked(nativeAudio.nativeModule.stop).mockClear();
        vi.mocked(nativeAudio.nativeModule.configureAudioSession).mockClear();
        vi.mocked(nativeAudio.nativeModule.restoreAudioSession).mockClear();
        filesystem = createMemFs();
        const directory = `file:///docs/happier/voice/modelPacks/${installedManifest.packId}`;
        filesystem.files.set(`${directory}/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest: installedManifest })));
        for (const file of installedManifest.files) filesystem.files.set(`${directory}/${file.path}`, packBytes);
        sdk.permission.mockReset(); sdk.permission.mockResolvedValue({ granted: true, canAskAgain: true });
        sdk.recognitionListeners.clear();
        sdk.recognitionStart.mockReset(); sdk.recognitionStart.mockImplementation(() => emitRecognition('start'));
        sdk.recognitionStop.mockReset(); sdk.recognitionStop.mockImplementation(() => emitRecognition('end'));
        sdk.recognitionAbort.mockReset(); sdk.recognitionAbort.mockImplementation(() => emitRecognition('end'));
        sdk.sherpaCreate.mockReset(); sdk.sherpaCreate.mockResolvedValue(undefined);
        sdk.sherpaPush.mockReset(); sdk.sherpaPush.mockResolvedValue({ text: 'interrupt that', isEndpoint: false });
        sdk.sherpaFinish.mockReset(); sdk.sherpaFinish.mockResolvedValue({ status: 'finalized', text: 'interrupt that' });
        sdk.sherpaCancel.mockReset(); sdk.sherpaCancel.mockResolvedValue(undefined);
        micVadNew.mockReset();
        micVadStart.mockReset();
        micVadPause.mockReset();
        nativeFileBoundary.file.exists = true;
        nativeFileBoundary.file.delete.mockReset();
        nativeFileBoundary.File.mockClear();
        activeOnSpeechEnd = null;
        activeOnSpeechStart = null;
        micVadNew.mockImplementation(async (options: { onSpeechEnd?: () => void; onSpeechStart?: () => void }) => {
            activeOnSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
            activeOnSpeechStart = typeof options.onSpeechStart === 'function' ? options.onSpeechStart : null;
            return {
                start: micVadStart,
                pause: micVadPause,
            };
        });
    });

    afterEach(async () => {
        vi.useRealTimers();
        for (const owner of captureOwners.splice(0)) await owner.stopSession();
        // An injected recording's fixture owns its terminal cleanup too. Late
        // preparation can settle after LocalOwner has retired its reference;
        // teardown here never releases a lease directly or changes the assertion.
        for (const session of recordingSessions.splice(0)) await session.teardown();
        (Platform as { OS: string }).OS = originalPlatformOs;
        for (const cleanup of accountCleanups.splice(0)) await cleanup();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        if (previousWindow === undefined) {
            Reflect.deleteProperty(globalThis as object, 'window');
        } else {
            (globalThis as { window?: object }).window = previousWindow;
        }

        if (previousDocument === undefined) {
            Reflect.deleteProperty(globalThis as object, 'document');
        } else {
            (globalThis as { document?: object }).document = previousDocument;
        }
    });

    it('discards a finalized browser recording exactly once when End Voice tears down capture', async () => {
        const originalPlatformOs = Platform.OS;
        const revokeObjectURL = vi.fn();
        const recordingUri = 'blob:voice-end-recording';
        const { recorder, session: recordingMicSession } = createRecordingBoundary(recordingUri);
        const localRelease = createDeferred<void>();
        const stopEntered = createDeferred<void>();
        recorder.stop.mockImplementationOnce(() => { stopEntered.resolve(); return localRelease.promise; });
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createRecordingMicSession: () => recordingMicSession,
            },
        );

        try {
            (Platform as unknown as { OS: string }).OS = 'web';
            vi.stubGlobal('URL', { revokeObjectURL });

            await owner.startCapture({
                handsFree: false,
                provider: 'recorded_audio',
                sessionId: 'end-voice-session',
            });
            vi.useFakeTimers();
            let stopSettled = false;
            const stopping = Promise.all([
                owner.stopSession('end-voice-session'),
                owner.stopSession('end-voice-session'),
            ]).then(() => { stopSettled = true; });
            try {
                await stopEntered.promise;
                expect(recorder.stop).toHaveBeenCalledOnce();
                await vi.advanceTimersByTimeAsync(1_001);
                expect(stopSettled).toBe(false);
            } finally { localRelease.resolve(); await stopping; }

            expect(recorder.stop).toHaveBeenCalledOnce();
            expect(revokeObjectURL).toHaveBeenCalledOnce();
            expect(revokeObjectURL).toHaveBeenCalledWith(recordingUri);
            expect(sdk.recognitionStart).not.toHaveBeenCalled();
        } finally {
            localRelease.resolve();
            (Platform as unknown as { OS: string }).OS = originalPlatformOs;
            vi.unstubAllGlobals();
        }
    });

    it('surfaces a failed finalized-recording deletion when End Voice tears down capture', async () => {
        const originalPlatformOs = Platform.OS;
        const deletionFailure = new Error('recording_delete_failed');
        const revokeObjectURL = vi.fn(() => {
            throw deletionFailure;
        });
        const onCaptureError = vi.fn();
        const recordingUri = 'blob:voice-end-recording';
        const { recorder, session: recordingMicSession } = createRecordingBoundary(recordingUri);
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError,
            },
            {
                createRecordingMicSession: () => recordingMicSession,
            },
        );

        try {
            (Platform as unknown as { OS: string }).OS = 'web';
            vi.stubGlobal('URL', { revokeObjectURL });

            await owner.startCapture({
                handsFree: false,
                provider: 'recorded_audio',
                sessionId: 'end-voice-session',
            });

            await expect(owner.stopSession('end-voice-session')).rejects.toBe(deletionFailure);

            expect(recorder.stop).toHaveBeenCalledOnce();
            expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(recordingUri);
            expect(onCaptureError).toHaveBeenCalledExactlyOnceWith({
                controlSessionId: 'end-voice-session',
                kind: 'provider_error',
                reason: 'recording_cleanup_failed',
            });
            expect(sdk.recognitionStart).not.toHaveBeenCalled();
        } finally {
            (Platform as unknown as { OS: string }).OS = originalPlatformOs;
            vi.unstubAllGlobals();
        }
    });

    it('still tears down terminal recording media when finalization cannot yield an artifact', async () => {
        const recorderStopFailure = new Error('recorder_stop_failed');
        const { recorder, session: recordingMicSession } = createRecordingBoundary(null);
        recorder.stop.mockRejectedValue(recorderStopFailure);
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createRecordingMicSession: () => recordingMicSession,
            },
        );

        await owner.startCapture({
            handsFree: false,
            provider: 'recorded_audio',
            sessionId: 'recording-stop-error-session',
        });
        await expect(owner.stopSession('recording-stop-error-session')).resolves.toBeUndefined();

        expect(recorder.stop).toHaveBeenCalledOnce();
        expect(nativeAudio.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('leaves a normal recorded stop for the existing stop-and-send cleanup path', async () => {
        const originalPlatformOs = Platform.OS;
        const revokeObjectURL = vi.fn();
        const recordingUri = 'blob:voice-send-recording';
        const { recorder, session: recordingMicSession } = createRecordingBoundary(recordingUri);
        const owner = createLocalVoiceCaptureOwner(
            {
                getSettings: () => ({}),
                onCaptureStarted: vi.fn(),
                onCaptureError: vi.fn(),
            },
            {
                createRecordingMicSession: () => recordingMicSession,
            },
        );

        try {
            (Platform as unknown as { OS: string }).OS = 'web';
            vi.stubGlobal('URL', { revokeObjectURL });

            await owner.startCapture({
                handsFree: false,
                provider: 'recorded_audio',
                sessionId: 'stop-and-send-session',
            });
            await expect(owner.stopCapture({
                provider: 'recorded_audio',
                sessionId: 'stop-and-send-session',
            })).resolves.toEqual({
                provider: 'recorded_audio',
                uri: recordingUri,
            });

            expect(revokeObjectURL).not.toHaveBeenCalled();
            await owner.stopSession('stop-and-send-session');
            expect(recorder.stop).toHaveBeenCalledOnce();
            expect(revokeObjectURL).not.toHaveBeenCalled();
        } finally {
            (Platform as unknown as { OS: string }).OS = originalPlatformOs;
            vi.unstubAllGlobals();
        }
    });

    it('keeps hands-free session ownership in the runtime capture owner instead of the provider controllers', async () => {
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {} });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: ' session-1 ' });
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(true);
        emitRecognition('result', { isFinal: true, results: [{ transcript: 'device transcript' }] });
        await expect(owner.stopCapture({ provider: 'device', sessionId: 'session-1' })).resolves.toEqual({
            continueHandsFree: true, provider: 'device', text: 'device transcript',
        });
        owner.clearHandsFree({ provider: 'device', sessionId: 'session-1' });
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(false);
        await owner.stopSession();
        expect(nativeAudio.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('uses an attempt-scoped settings snapshot for Dictation capture without changing the ambient owner', async () => {
        const ambientSettings = { voice: { dictation: { language: 'en-US' } } };
        const dictationSettings = { voice: { dictation: { language: 'de-CH' } } };
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ambientSettings, onCaptureStarted() {}, onCaptureError() {} });
        await owner.startCapture({ handsFree: false, provider: 'device', capturePurpose: 'dictation',
            sessionId: 'dictation-session', settings: dictationSettings });
        expect(sdk.recognitionStart).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'de-CH' }));
        await owner.stopCapture({ provider: 'device', sessionId: 'dictation-session' });
        await owner.startCapture({ handsFree: false, provider: 'device', capturePurpose: 'dictation', sessionId: 'local-session' });
        expect(sdk.recognitionStart).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'en-US' }));
        expect(ambientSettings.voice.dictation.language).toBe('en-US');
        await owner.stopSession();
    });

    it('clears all runtime-owned hands-free sessions when stopping the capture owner', async () => {
        const recording = createRecordingBoundary('file:///recording.wav');
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => neuralSettings, onCaptureStarted() {}, onCaptureError() {} },
            { createRecordingMicSession: () => recording.session });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-1' });
        await owner.stopCapture({ provider: 'device', sessionId: 'session-1' });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', sessionId: 'session-2' });
        await owner.stopCapture({ provider: 'local_neural', sessionId: 'session-2' });
        await owner.startCapture({ handsFree: false, provider: 'recorded_audio', sessionId: 'session-3' });
        await owner.stopSession();
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-1' })).toBe(false);
        expect(owner.isHandsFreeCaptureSession({ provider: 'local_neural', sessionId: 'session-2' })).toBe(false);
        expect(recording.recorder.stop).toHaveBeenCalledOnce();
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
        expect(nativeAudio.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it.each(['Привет, как дела', 'こんにちは', 'مرحبا بالعالم', 'très bien'])('submits recognized Unicode text unchanged after endpoint capture: %s', async transcript => {
        const { boundary, getSettings } = await installDaemonCaptureBoundary();
        boundary.finalText = transcript;
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError: error => { throw new Error(error.reason); } });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', localNeuralExecution: 'daemon', sessionId: 'unicode-session' });
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        await expect(owner.stopEndpointDrivenCapture({ adaptiveConfig: { ignoredPhrases: ['yeah'] },
            provider: 'local_neural', sessionId: 'unicode-session',
        })).resolves.toMatchObject({ kind: 'submit_turn', transcript });
        expect(network.requests.some(request => request.method === 'daemon.voiceInference.stt.stream.chunk')).toBe(true);
        await owner.stopSession();
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
    });

    it('retains a private daemon finish cause through endpoint capture failure', async () => {
        const { boundary, getSettings } = await installDaemonCaptureBoundary();
        const finishFailure = new Error('private daemon finish detail');
        boundary.finish.mockRejectedValue(finishFailure);
        const onCaptureError = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', localNeuralExecution: 'daemon', sessionId: 'finish-failure' });
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();

        const result = await owner.stopEndpointDrivenCapture({ adaptiveConfig: { ignoredPhrases: [] },
            provider: 'local_neural', sessionId: 'finish-failure' });

        expect(result.kind).not.toBe('submit_turn');
        expect(onCaptureError).toHaveBeenCalledOnce();
        const failure: unknown = onCaptureError.mock.calls[0]?.[0];
        expect(failure).toMatchObject({ controlSessionId: 'finish-failure', kind: 'provider_error',
            reason: 'daemon_streaming_stt_finalization_failed' });
        expect(failure).toHaveProperty('cause.cause', finishFailure);
        expect(Object.getOwnPropertyDescriptor(failure, 'cause')?.enumerable).toBe(false);
        expect(JSON.stringify(failure)).not.toContain('private daemon finish detail');
        expect(owner.isCaptureActive('finish-failure')).toBe(false);
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
        await owner.stopSession();
    });

    it('releases acquired browser media on End while recognizer startup is pending', async () => {
        const browser = installBrowserCaptureBoundary();
        const vadEntered = createDeferred<void>();
        const vadReady = createDeferred<void>();
        micVadNew.mockImplementationOnce(async () => {
            vadEntered.resolve();
            await vadReady.promise;
            return { start: micVadStart, pause: micVadPause };
        });
        const onCaptureStarted = vi.fn();
        const admission = createVoiceCaptureAdmissionController();
        const rawOwner = createLocalVoiceCaptureOwner({
            getSettings: () => ({}), onCaptureStarted, onCaptureError() {},
        });
        const owner = createVoiceCaptureAdmissionBinding({
            admission, captureOwner: rawOwner, productOwner: 'conversation',
        });
        const start = owner.startCapture({ handsFree: false, provider: 'device', sessionId: 'pending-browser-start' });
        await vadEntered.promise;
        expect(browser.micTrack.readyState).toBe('live');
        try {
            await owner.stopSession('pending-browser-start');
            expect(browser.micTrack.readyState).toBe('ended');
            expect(onCaptureStarted).not.toHaveBeenCalled();
            const next = admission.acquire('dictation');
            expect(next.status).toBe('acquired');
            if (next.status === 'acquired') next.lease.release();
        } finally {
            vadReady.resolve();
            await start;
            await owner.stopSession();
        }
        expect(browser.micTrack.readyState).toBe('ended');
        expect(onCaptureStarted).not.toHaveBeenCalled();
        expect(sdk.recognitionStart).not.toHaveBeenCalled();
    });

    it('releases the owned browser track before a pending daemon STT stop settles', async () => {
        const browser = installBrowserCaptureBoundary();
        const { boundary, getSettings } = await installDaemonCaptureBoundary();
        const remoteStop = createDeferred<void>();
        const remoteStopEntered = createDeferred<void>();
        boundary.cancel.mockImplementationOnce(async () => {
            remoteStopEntered.resolve();
            await remoteStop.promise;
        });
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError() {} });
        let stopping: Promise<void> | undefined;
        try {
            await owner.startCapture({ handsFree: false, provider: 'local_neural',
                localNeuralExecution: 'daemon', sessionId: 'end-pending-daemon' });
            expect(browser.micTrack.readyState).toBe('live');
            stopping = owner.stopSession('end-pending-daemon');
            await remoteStopEntered.promise;
            expect(browser.micTrack.readyState).toBe('ended');
        } finally {
            remoteStop.resolve();
            await stopping;
            await owner.stopSession();
        }
    });

    it.each([false, true])('retains finalized manual input across a long daemon mute (resume=%s)', async resume => {
        const { boundary, getSettings, machine, account } = await installDaemonCaptureBoundary();
        let remoteExpired = false;
        const finishEntered = createDeferred<void>();
        boundary.start.mockImplementation(async () => { remoteExpired = false; });
        boundary.finish.mockImplementation(async () => {
            finishEntered.resolve();
            if (remoteExpired) throw Object.assign(new Error('stream expired'), { code: 'stream_not_found' });
        });
        boundary.finalText = 'before mute';
        const onCaptureError = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError });
        await owner.startCapture({ handsFree: false, provider: 'local_neural', localNeuralExecution: 'daemon', sessionId: 'buffered-input' });
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        await owner.setMuted({ sessionId: 'buffered-input', muted: true });
        // Finalize while the remote stream is still owned. A muted turn must
        // not depend on keeping an idle daemon stream alive until Send.
        await finishEntered.promise;
        expect(boundary.finish).toHaveBeenCalledOnce();
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        remoteExpired = true; // The daemon may reclaim any stream left idle through the mute.
        if (resume) {
            // The real daemon remains online while this client is muted.
            // Refresh its OS/network observation after advancing the clock.
            const { storage } = await import('@/sync/domains/state/storage');
            const onlineMachine = { ...machine, activeAt: Date.now() };
            storage.setState(state => ({ machines: { ...state.machines, [machine.id]: onlineMachine },
                machineListByServerId: { ...state.machineListByServerId, [account.home.id]: [onlineMachine] } }));
            boundary.finalText = 'after unmute';
            await owner.setMuted({ sessionId: 'buffered-input', muted: false });
            nativeAudio.emit();
            await nativeAudio.capture.waitForDrain();
        }
        const result = await owner.stopCapture({ provider: 'local_neural', sessionId: 'buffered-input' });
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(result).toMatchObject({ text: resume ? 'before mute after unmute' : 'before mute' });
        await owner.stopSession();
    });

    it('keeps endpoint signal gating and stopped-capture decisions in the runtime capture owner', async () => {
        sdk.sherpaFinish.mockResolvedValue({ status: 'finalized', text: 'open the latest notes' });
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => neuralSettings, onCaptureStarted() {}, onCaptureError() {} });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', sessionId: ' session-1 ' });
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(1);
        expect(owner.resolveEndpointSignalAction({
            currentSessionId: 'session-1', currentStatus: 'recording', handsFreeEnabled: true,
            inFlight: false, provider: 'local_neural', signal: { detectedAt: 1_000,
                endpoint: { reason: 'acoustic_endpoint', confidence: null }, sessionId: 'session-1',
                source: 'native_stream', transcript: 'open the latest notes' },
        })).toEqual({ kind: 'stop_capture', provider: 'local_neural', sessionId: 'session-1' });
        await expect(owner.stopEndpointDrivenCapture({ adaptiveConfig: { ignoredPhrases: ['yeah'] },
            provider: 'local_neural', sessionId: 'session-1',
        })).resolves.toEqual({ kind: 'submit_turn', followUp: { kind: 'rearm_capture',
            provider: 'local_neural', sessionId: 'session-1' }, transcript: 'open the latest notes' });
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
        await owner.stopSession();
    });

    it('projects daemon endpoint events once through the canonical hands-free stop decision', async () => {
        const { boundary, getSettings } = await installDaemonCaptureBoundary();
        boundary.finalText = 'open the latest notes';
        boundary.events = [
            { type: 'partial', seq: 0, text: boundary.finalText, isEndpoint: true, confidence: null },
            { type: 'endpoint', seq: 0, transcript: boundary.finalText, reason: 'vad' },
        ];
        const endpointReported = createDeferred<void>();
        const onEndpointSignal = vi.fn((_signal: TurnEndpointSignal) => { endpointReported.resolve(); });
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError() {}, onEndpointSignal });
        await owner.startCapture({ handsFree: true, localNeuralExecution: 'daemon', provider: 'local_neural', sessionId: ' control-session ' });
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        await endpointReported.promise;
        expect(onEndpointSignal).toHaveBeenCalledOnce();
        const endpointSignal: TurnEndpointSignal = onEndpointSignal.mock.calls[0][0];
        expect(endpointSignal).toMatchObject({ endpoint: { reason: 'acoustic_endpoint', confidence: null },
            sessionId: 'control-session', source: 'daemon_stream', transcript: boundary.finalText });
        expect(owner.resolveEndpointSignalAction({ currentSessionId: 'control-session', currentStatus: 'recording',
            handsFreeEnabled: true, inFlight: false, provider: 'local_neural', signal: endpointSignal,
        })).toEqual({ kind: 'stop_capture', provider: 'local_neural', sessionId: 'control-session' });
        await owner.stopSession();
    });

    it('keeps manual barge-in decisions and endpoint-controller wiring in the runtime capture owner', async () => {
        vi.useFakeTimers();
        const onEndpointSignal = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => neuralSettings,
            onCaptureStarted() {}, onCaptureError() {}, onEndpointSignal });
        expect(owner.resolveManualBargeInAction({ bargeInEnabled: true, currentSessionId: 'session-1',
            currentStatus: 'speaking', handsFree: true, provider: 'device', requestedSessionId: 'session-1',
        })).toEqual({ kind: 'interrupt_and_rearm', handsFree: true, provider: 'device', sessionId: 'session-1' });
        expect(sdk.recognitionStart).not.toHaveBeenCalled();
        expect(sdk.sherpaCreate).not.toHaveBeenCalled();
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-1' });
        emitRecognition('result', { isFinal: true, results: [{ transcript: 'device endpoint' }] });
        await vi.advanceTimersByTimeAsync(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1', source: 'heuristic', transcript: 'device endpoint',
        }));
        await owner.stopCapture({ provider: 'device', sessionId: 'session-1' });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', sessionId: 'session-1' });
        sdk.sherpaPush.mockResolvedValue({ text: 'neural endpoint', isEndpoint: true });
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1', source: 'native_stream', transcript: 'neural endpoint',
        }));
        await owner.stopSession();
    });

    it('keeps mute plumbing in the runtime capture owner and reapplies it when the same session rearms', async () => {
        const browser = installBrowserCaptureBoundary();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {} });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-1' });
        await owner.setMuted({ muted: true, sessionId: 'session-1' });
        expect(browser.micTrack.enabled).toBe(false);
        sdk.recognitionStart.mockImplementationOnce(() => { throw new Error('device_mute_failed'); });
        await expect(owner.setMuted({ muted: false, sessionId: 'session-1' })).rejects.toThrow('device_mute_failed');
        expect(browser.micTrack.enabled).toBe(false);
        await owner.stopCapture({ provider: 'device', sessionId: 'session-1' });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-1' });
        expect(browser.micTrack.enabled).toBe(false);
        emitRecognition('result', { isFinal: true, results: [{ transcript: 'muted text' }] });
        await expect(owner.stopCapture({ provider: 'device', sessionId: 'session-1' })).resolves.toMatchObject({ text: '' });
        await owner.stopSession();
    });

    it('awaits native recorded-input unmute and keeps the acknowledged mute when resume fails', async () => {
        (Platform as { OS: string }).OS = 'ios';
        const resume = createDeferred<void>();
        const resumeEntered = createDeferred<void>();
        const nativeMute = vi.fn(async ({ muted }: { muted: boolean }) => { if (!muted) { resumeEntered.resolve(); await resume.promise; } });
        const recording = createExpoAudioRecordingMicSession({
            requestPermission: sdk.permission,
            deleteRecordedAudio: vi.fn(async () => {}),
            createNativeFileRecording: () => createVoiceFileRecording({ ...nativeAudio.nativeModule,
                startFileRecording: async () => ({ recordingId: 'resume-failure' }),
                setFileRecordingMuted: nativeMute,
                stopFileRecording: async () => ({ uri: 'file:///tmp/resume-failure.m4a' }),
            }),
        });
        recordingSessions.push(recording);
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {} }, {
            createRecordingMicSession: () => recording,
        });
        await owner.startCapture({ handsFree: false, provider: 'recorded_audio', sessionId: 'recorded-mute' });
        await owner.setMuted({ sessionId: 'recorded-mute', muted: true });
        expect(recording.isMuted()).toBe(true);
        let settled = false;
        const unmuting = owner.setMuted({ sessionId: 'recorded-mute', muted: false });
        const outcome = unmuting.then(() => { settled = true; return null; }, error => { settled = true; return error; });
        await resumeEntered.promise;
        expect(nativeMute).toHaveBeenCalledWith({ recordingId: 'resume-failure', muted: false });
        try {
            expect(settled).toBe(false);
            expect(recording.isMuted()).toBe(true);
        } finally {
            resume.reject(new Error('file_recording_resume_failed'));
        }
        await expect(outcome).resolves.toMatchObject({ message: 'file_recording_resume_failed' });
        expect(recording.isMuted()).toBe(true);
        await owner.stopSession();
    });

    it('surfaces live web mic failures through the runtime capture owner instead of leaving browser track loss local-only', async () => {
        const browser = installBrowserCaptureBoundary();
        const failureReported = createDeferred<void>();
        const onCaptureError = vi.fn(() => { failureReported.resolve(); });
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-web' });
        browser.micTrack.dispatchEvent(new Event('ended'));
        await failureReported.promise;
        expect(onCaptureError).toHaveBeenCalledExactlyOnceWith({
            controlSessionId: 'session-web', kind: 'mic_ended', reason: 'web_mic_track_ended',
        });
        expect(owner.isCaptureActive('session-web')).toBe(false);
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-web' })).toBe(false);
        expect(sdk.recognitionListeners.get('result')?.size).toBe(0);
        expect(browser.audioContext.close).toHaveBeenCalledOnce();
        await owner.stopSession();
    });

    it('ignores a stale live mic failure after the capture owner has restarted', async () => {
        const first = installBrowserCaptureBoundary();
        const onCaptureError = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-web' });
        await owner.stopSession('session-web');
        const retry = installBrowserCaptureBoundary();
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-web' });
        first.micTrack.dispatchEvent(new Event('ended'));
        await Promise.resolve();
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(owner.isCaptureActive('session-web')).toBe(true);
        expect(retry.micTrack.stop).not.toHaveBeenCalled();
        expect(retry.audioContext.close).not.toHaveBeenCalled();
        await owner.stopSession();
    });

    it.each(['live mic failure', 'STT failure'] as const)(
        'retains product admission until failed live mic teardown settles after %s, including concurrent stop',
        async failureSource => {
            const browser = installBrowserCaptureBoundary();
            const teardownSettled = createDeferred<void>();
            const teardownEntered = createDeferred<void>();
            browser.audioContext.close.mockImplementation(() => { teardownEntered.resolve(); return teardownSettled.promise; });
            const admission = createVoiceCaptureAdmissionController();
            let captureOwner!: ReturnType<typeof createVoiceCaptureAdmissionBinding>;
            const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {},
                onCaptureError: error => captureOwner.releaseAdmission(error.controlSessionId),
            });
            captureOwner = createVoiceCaptureAdmissionBinding({ admission, captureOwner: rawCaptureOwner, productOwner: 'dictation' });
            await captureOwner.startCapture({ handsFree: true, provider: 'device', sessionId: 'dictation-session' });
            vi.useFakeTimers();
            if (failureSource === 'live mic failure') browser.micTrack.dispatchEvent(new Event('ended'));
            else emitRecognition('error', { error: 'audio-capture' });
            let stopSettled = false;
            const stopPromise = captureOwner.stopSession('dictation-session').then(() => { stopSettled = true; });
            try {
                await teardownEntered.promise;
                expect(browser.audioContext.close).toHaveBeenCalledOnce();
                // The provider-abandonment budget cannot abandon physical media.
                await vi.advanceTimersByTimeAsync(1_001);
                expect(stopSettled).toBe(false);
                expect(admission.acquire('conversation')).toEqual({ status: 'busy', activeOwner: 'dictation' });
            } finally { teardownSettled.resolve(); await stopPromise; }
            expect(admission.acquire('conversation').status).toBe('acquired');
        },
    );

    it('waits for provider cleanup and live mic teardown before publishing an STT runtime failure', async () => {
        const browser = installBrowserCaptureBoundary();
        const providerCleanup = createDeferred<void>();
        const micCleanup = createDeferred<void>();
        const providerCleanupEntered = createDeferred<void>();
        const micCleanupEntered = createDeferred<void>();
        const failureReported = createDeferred<void>();
        micVadPause.mockImplementation(() => { providerCleanupEntered.resolve(); return providerCleanup.promise; });
        browser.audioContext.close.mockImplementation(() => { micCleanupEntered.resolve(); return micCleanup.promise; });
        const admission = createVoiceCaptureAdmissionController();
        const onCaptureError = vi.fn();
        let captureOwner!: ReturnType<typeof createVoiceCaptureAdmissionBinding>;
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {},
            onCaptureError: error => { onCaptureError(error); captureOwner.releaseAdmission(error.controlSessionId); failureReported.resolve(); },
        });
        captureOwner = createVoiceCaptureAdmissionBinding({ admission, captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        await captureOwner.startCapture({ handsFree: false, provider: 'device', sessionId: 'dictation-session' });
        emitRecognition('error', { error: 'audio-capture' });
        try {
            // DeviceSttController retires its SDK/VAD before forwarding the
            // failure to the capture owner. End can still release the mic now.
            await providerCleanupEntered.promise;
            expect(micVadPause).toHaveBeenCalledOnce();
            expect(browser.audioContext.close).not.toHaveBeenCalled();
            expect(onCaptureError).not.toHaveBeenCalled();
            expect(admission.acquire('conversation')).toEqual({ status: 'busy', activeOwner: 'dictation' });
            providerCleanup.resolve();
            await micCleanupEntered.promise;
            expect(browser.audioContext.close).toHaveBeenCalledOnce();
            expect(browser.micTrack.readyState).toBe('ended');
            expect(onCaptureError).not.toHaveBeenCalled();
            expect(admission.acquire('conversation')).toEqual({ status: 'busy', activeOwner: 'dictation' });
            micCleanup.resolve();
            await failureReported.promise;
            expect(onCaptureError).toHaveBeenCalledWith({ controlSessionId: 'dictation-session',
                kind: 'speech_recognition_unavailable', reason: 'audio-capture' });
        } finally { providerCleanup.resolve(); micCleanup.resolve(); }
        expect(onCaptureError.mock.calls[0]?.[0]).toHaveProperty('cause.reason', 'audio-capture');
        expect(Object.getOwnPropertyDescriptor(onCaptureError.mock.calls[0]?.[0], 'cause')?.enumerable).toBe(false);
        expect(admission.acquire('conversation').status).toBe('acquired');
        await captureOwner.stopSession();
    });

    it.each([
        {
            label: 'recorded audio',
            provider: 'recorded_audio' as const,
            localNeuralExecution: undefined,
        },
        {
            label: 'device recognizer',
            provider: 'device' as const,
            localNeuralExecution: undefined,
        },
        {
            label: 'local neural device PCM',
            provider: 'local_neural' as const,
            localNeuralExecution: 'device' as const,
        },
        {
            label: 'local neural daemon stream',
            provider: 'local_neural' as const,
            localNeuralExecution: 'daemon' as const,
        },
    ])('cancels late $label startup and releases admission only after owned cleanup', async ({
        provider,
        localNeuralExecution,
    }) => {
        const startSettled = createDeferred<void>();
        const startEntered = createDeferred<void>();
        const recording = createRecordingBoundary('file:///late-recording.wav');
        let getSettings: () => unknown = () => neuralSettings;
        if (provider === 'recorded_audio') {
            recording.recorder.prepareToRecordAsync.mockImplementation(async () => {
                startEntered.resolve(); await startSettled.promise;
            });
        } else if (provider === 'device') {
            sdk.permission.mockImplementationOnce(async () => {
                startEntered.resolve(); await startSettled.promise;
                return { granted: true, canAskAgain: true };
            });
        } else if (localNeuralExecution === 'device') {
            sdk.sherpaCreate.mockImplementationOnce(async () => {
                startEntered.resolve(); await startSettled.promise;
            });
        } else {
            const daemon = await installDaemonCaptureBoundary();
            getSettings = daemon.getSettings;
            daemon.boundary.start.mockImplementationOnce(async () => {
                startEntered.resolve(); await startSettled.promise;
            });
        }
        const admission = createVoiceCaptureAdmissionController();
        const onCaptureStarted = vi.fn();
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted, onCaptureError() {} },
            { createRecordingMicSession: () => recording.session });
        const captureOwner = createVoiceCaptureAdmissionBinding({ admission, captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        const startPromise = captureOwner.startCapture({ handsFree: false, provider, sessionId: 'dictation-session',
            ...(localNeuralExecution ? { localNeuralExecution } : {}),
        });
        await startEntered.promise;
        let stopFinished = false;
        const stopPromise = captureOwner.stopSession('dictation-session').then(() => { stopFinished = true; });
        if (provider === 'device' || localNeuralExecution === 'daemon') {
            // DeviceSttController.runSetupStage races cancellation against
            // permission acquisition; no microphone resource exists to join.
            await stopPromise;
            const released = admission.acquire('conversation');
            expect(released.status).toBe('acquired');
            if (released.status === 'acquired') released.lease.release();
        } else {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            expect(stopFinished).toBe(false);
            expect(admission.acquire('conversation')).toEqual({ status: 'busy', activeOwner: 'dictation' });
        }
        startSettled.resolve();
        await Promise.all([startPromise, stopPromise]);
        expect(onCaptureStarted).not.toHaveBeenCalled();
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
        expect(nativeAudio.coordinator.getSnapshot().leaseCount).toBe(0);
        expect(admission.acquire('conversation').status).toBe('acquired');
    });

    it('starts the silent-mic watchdog only after daemon STT startup settles', async () => {
        const { boundary, getSettings } = await installDaemonCaptureBoundary();
        const daemonStart = createDeferred<void>();
        const startEntered = createDeferred<void>();
        boundary.start.mockImplementation(async () => { startEntered.resolve(); await daemonStart.promise; });
        const onCaptureStarted = vi.fn();
        const onCaptureError = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted, onCaptureError }, { micPlateauTimeoutMs: 25 });
        const start = owner.startCapture({ handsFree: false, localNeuralExecution: 'daemon', provider: 'local_neural', sessionId: 'session-daemon-start' });
        await startEntered.promise;
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(25);
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
        daemonStart.resolve();
        await start;
        expect(onCaptureStarted).toHaveBeenCalledWith('session-daemon-start');
        await vi.advanceTimersByTimeAsync(25);
        expect(owner.isCaptureActive('session-daemon-start')).toBe(false);
        await owner.stopSession();
        expect(onCaptureError).toHaveBeenCalledWith({ controlSessionId: 'session-daemon-start',
            kind: 'mic_plateau', reason: 'mic_audio_plateau' });
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
    });

    it.each([
        { execution: 'device' as const, muteBeforeStart: false },
        { execution: 'device' as const, muteBeforeStart: true },
        { execution: 'daemon' as const, muteBeforeStart: false },
        { execution: 'daemon' as const, muteBeforeStart: true },
    ])('suspends the silent-mic watchdog while muted and measures a fresh unmuted window: $execution / before start=$muteBeforeStart', async ({ execution, muteBeforeStart }) => {
        const getSettings = execution === 'daemon'
            ? (await installDaemonCaptureBoundary()).getSettings
            : () => neuralSettings;
        const onCaptureError = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError },
            { micPlateauTimeoutMs: 25 });
        vi.useFakeTimers();
        if (muteBeforeStart) await owner.setMuted({ sessionId: 'muted-capture', muted: true });
        await owner.startCapture({ sessionId: 'muted-capture', provider: 'local_neural',
            localNeuralExecution: execution, handsFree: false });
        if (!muteBeforeStart) {
            await vi.advanceTimersByTimeAsync(10);
            await owner.setMuted({ sessionId: 'muted-capture', muted: true });
        }
        // Muted PCM is intentionally dropped by the real capture boundary.
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        await vi.advanceTimersByTimeAsync(25);
        expect(onCaptureError).not.toHaveBeenCalled();
        expect(owner.isCaptureActive('muted-capture')).toBe(true);

        await owner.setMuted({ sessionId: 'muted-capture', muted: false });
        await vi.advanceTimersByTimeAsync(24);
        expect(onCaptureError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(owner.isCaptureActive('muted-capture')).toBe(false);
        await owner.stopSession();
        expect(onCaptureError).toHaveBeenCalledExactlyOnceWith({ controlSessionId: 'muted-capture',
            kind: 'mic_plateau', reason: 'mic_audio_plateau' });
    });

    it('does not restart the silent-mic watchdog when unmuting a capture handed off for a turn', async () => {
        const { boundary, getSettings } = await installDaemonCaptureBoundary();
        const finishing = createDeferred<void>();
        const finishEntered = createDeferred<void>();
        boundary.finish.mockImplementation(async () => { finishEntered.resolve(); await finishing.promise; });
        const onCaptureError = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError },
            { micPlateauTimeoutMs: 25 });
        vi.useFakeTimers();
        await owner.startCapture({ sessionId: 'turn-handoff', provider: 'local_neural',
            localNeuralExecution: 'daemon', handsFree: false });
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        const mute = owner.setMuted({ sessionId: 'turn-handoff', muted: true });
        await finishEntered.promise;
        const stop = owner.stopEndpointDrivenCapture({ sessionId: 'turn-handoff', provider: 'local_neural',
            adaptiveConfig: { ignoredPhrases: [] } });
        try {
            await owner.setMuted({ sessionId: 'turn-handoff', muted: false });
            await vi.advanceTimersByTimeAsync(25);
            expect(onCaptureError).not.toHaveBeenCalled();
            expect(owner.isCaptureActive('turn-handoff')).toBe(false);
        } finally {
            finishing.resolve();
            await mute;
            await stop;
        }
    });

    it('tracks the latest STT partial for VAD endpoint signals even when no UI partial callback is mounted', async () => {
        installBrowserCaptureBoundary();
        const onEndpointSignal = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {}, onEndpointSignal });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-vad' });
        emitRecognition('result', { isFinal: false, results: [{ transcript: '  interrupt that  ' }] });
        activeOnSpeechEnd?.();
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-vad', source: 'web_vad', transcript: 'interrupt that',
        }));
        await owner.stopSession();
    });

    it('maps VAD candidate edges onto the active control-session owner', async () => {
        installBrowserCaptureBoundary();
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {},
            onSpeechCandidateStart, onSpeechCandidateFalseAlarm });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'control-session' });
        activeOnSpeechStart?.(); activeOnSpeechEnd?.();
        expect(onSpeechCandidateStart).toHaveBeenCalledWith({ controlSessionId: 'control-session', source: 'web_vad' });
        expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledWith({ controlSessionId: 'control-session', source: 'web_vad' });
        await owner.stopCapture({ provider: 'device', sessionId: 'control-session' });
        await owner.stopSession();
    });

    it('forwards finalized device-STT endpoint signals with the active control session id', async () => {
        vi.useFakeTimers();
        const onEndpointSignal = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {}, onEndpointSignal });
        await owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'control-session' });
        emitRecognition('result', { isFinal: true, results: [{ transcript: '  finalized command  ' }] });
        await vi.advanceTimersByTimeAsync(VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs);
        expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'control-session', source: 'heuristic', transcript: 'finalized command',
        }));
        await owner.stopSession();
    });

    it('releases the live mic when an STT start throws so a failed startup never leaks capture', async () => {
        const browser = installBrowserCaptureBoundary();
        sdk.recognitionStart.mockImplementationOnce(() => { throw new Error('device_stt_start_failed'); });
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {} });
        await expect(owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-fail' }))
            .rejects.toThrow('device_stt_start_failed');
        expect(browser.micTrack.stop).toHaveBeenCalledOnce();
        expect(browser.audioContext.close).toHaveBeenCalledOnce();
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-fail' })).toBe(false);
        await owner.stopSession();
    });

    it('treats an external startup abort as cancelled capture instead of confirming a late mic start', async () => {
        const browser = installBrowserCaptureBoundary();
        const acquisition = createDeferred<MediaStream>();
        browser.captureAcquire.mockImplementationOnce(() => acquisition.promise);
        const externalAbort = new AbortController();
        const onCaptureStarted = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted, onCaptureError() {} });
        const start = owner.startCapture({ handsFree: true, provider: 'device', sessionId: 'session-abort', signal: externalAbort.signal });
        await browser.captureEntered;
        expect(browser.captureAcquire).toHaveBeenCalledOnce();
        externalAbort.abort();
        await start;
        expect(sdk.recognitionStart).not.toHaveBeenCalled();
        expect(onCaptureStarted).not.toHaveBeenCalled();
        expect(owner.isHandsFreeCaptureSession({ provider: 'device', sessionId: 'session-abort' })).toBe(false);
        acquisition.resolve(browser.micStream);
        await browser.trackStopped;
        expect(browser.micTrack.stop).toHaveBeenCalledOnce();
        await owner.stopSession();
    });

    it('composes native Silero over the shared local-neural PCM capture for candidate, false-alarm, and one confirmed endpoint', async () => {
        // A recognizer may segment after a shorter pause than the saved VAD policy,
        // or retain its endpoint while the VAD is still confirming resumed speech.
        sdk.sherpaPush.mockResolvedValue({ text: 'interrupt that', isEndpoint: true });
        const pcm = createSharedNativePcmHarness();
        const createVadDetector = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const pushVadAudioFrame = vi
            .fn()
            .mockResolvedValueOnce({ speechStarted: true, speechEnded: false })
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true })
            .mockResolvedValueOnce({ speechStarted: true, speechEnded: false })
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true })
            // A repeated end edge cannot admit the already-confirmed candidate again.
            .mockResolvedValueOnce({ speechStarted: false, speechEnded: true });
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector,
            pushVadAudioFrame,
            cancelVadDetector,
        }, {
            frameSource: pcm.capture,
        });
        expect(bridge).not.toBeNull();

        let clock = 0;
        const duckPlayback = vi.fn();
        const restorePlayback = vi.fn();
        const admittedEndpoints: unknown[] = [];
        let latestPartial = '';
        let owner!: ReturnType<typeof createLocalVoiceCaptureOwner>;
        const onSpeechCandidateStart = vi.fn((input: Readonly<{
            controlSessionId: string;
            source: 'native_vad' | 'web_vad' | 'device_recognizer';
        }>) => {
            duckPlayback();
            expect(input).toEqual({
                controlSessionId: 'local-neural-session',
                source: 'native_vad',
            });
        });
        const onSpeechCandidateFalseAlarm = vi.fn((input: Readonly<{
            controlSessionId: string;
            source: 'native_vad' | 'web_vad' | 'device_recognizer';
        }>) => {
            restorePlayback();
            expect(input).toEqual({
                controlSessionId: 'local-neural-session',
                source: 'native_vad',
            });
        });
        const onEndpointSignal = vi.fn((signal: TurnEndpointSignal) => {
            const action = owner.resolveEndpointSignalAction({
                currentSessionId: 'local-neural-session',
                currentStatus: 'recording',
                handsFreeEnabled: true,
                inFlight: admittedEndpoints.length > 0,
                provider: 'local_neural',
                signal,
            });
            if (action.kind === 'stop_capture') {
                admittedEndpoints.push(action);
            }
        });
        const nativeVadController = createNativeVadController({
            bridge,
            now: () => clock,
            onEndpointSignal: (signal) => onEndpointSignal(signal),
            onSpeechCandidateStart: ({ sessionId, source }) => onSpeechCandidateStart({
                controlSessionId: sessionId,
                source,
            }),
            onSpeechCandidateFalseAlarm: ({ sessionId, source }) => onSpeechCandidateFalseAlarm({
                controlSessionId: sessionId,
                source,
            }),
            turnPolicy: { confirmMs: 800, silenceMs: 700 },
            getLatestPartialTranscript: () => latestPartial,
        });
        owner = createLocalVoiceCaptureOwner({
            getSettings: () => ({ voice: { ...neuralSettings.voice, providers: {
                local_conversation: { schemaVersion: 1, config: {
                    ...neuralSettings.voice.providers.local_conversation.config,
                    handsFree: { enabled: true, endpointing: { silenceMs: 6_000, minSpeechMs: 800 } },
                } },
            } } }),
            onCaptureStarted: vi.fn(),
            onCaptureError: vi.fn(),
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
            onPartialTranscript: ({ transcript }) => {
                latestPartial = transcript;
            },
        }, {
            nativeVadController,
        });

        await owner.startCapture({
            handsFree: true,
            localNeuralExecution: 'device',
            provider: 'local_neural',
            sessionId: 'local-neural-session',
        });

        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: 'native-stream',
            subscriberCount: 2,
        });
        expect(pcm.nativeStart).toHaveBeenCalledTimes(1);
        expect(pcm.platformApply).toHaveBeenCalledTimes(1);
        expect(createVadDetector).toHaveBeenCalledWith(expect.objectContaining({
            minSpeechMs: 800,
            redemptionMs: 6_000,
        }));

        clock = 0;
        pcm.emitFrame('AAE=');
        await pcm.capture.waitForDrain();
        expect(duckPlayback).toHaveBeenCalledTimes(1);
        clock = 300;
        pcm.emitFrame('AAI=');
        await pcm.capture.waitForDrain();
        expect(restorePlayback).toHaveBeenCalledTimes(1);
        expect(admittedEndpoints).toHaveLength(0);

        clock = 1_000;
        pcm.emitFrame('AAM=');
        await pcm.capture.waitForDrain();
        expect(duckPlayback).toHaveBeenCalledTimes(2);
        clock = 2_000;
        pcm.emitFrame('AAQ=');
        await pcm.capture.waitForDrain();
        expect(admittedEndpoints).toHaveLength(1);
        expect(onEndpointSignal).toHaveBeenLastCalledWith(expect.objectContaining({
            durationMs: 1_000,
            sessionId: 'local-neural-session',
            source: 'native_vad',
            transcript: 'interrupt that',
        }));

        pcm.emitFrame('AAU=');
        await pcm.capture.waitForDrain();
        expect(pushVadAudioFrame).toHaveBeenCalledTimes(5);
        expect(admittedEndpoints).toHaveLength(1);

        await owner.stopCapture({
            provider: 'local_neural',
            sessionId: 'local-neural-session',
        });
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);
        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: null,
            subscriberCount: 0,
        });
        expect(pcm.nativeStop).toHaveBeenCalledTimes(1);
        expect(pcm.coordinator.getSnapshot().leaseCount).toBe(0);
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(0);
    });

    it('preserves streaming endpoint fallback when the active native VAD terminates', async () => {
        const onEndpointSignal = vi.fn();
        const pcm = createSharedNativePcmHarness();
        const pushVadAudioFrame = vi.fn(async () => ({ speechStarted: false, speechEnded: false }));
        const detectorCancelled = createDeferred<void>();
        const cancelVadDetector = vi.fn(async () => { detectorCancelled.resolve(); });
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector: vi.fn(async () => {}),
            pushVadAudioFrame,
            cancelVadDetector,
        }, { frameSource: pcm.capture });
        expect(bridge).not.toBeNull();
        const nativeVadController = createNativeVadController({
            bridge,
            onEndpointSignal,
        });
        const owner = createLocalVoiceCaptureOwner({
            getSettings: () => neuralSettings,
            onCaptureStarted() {}, onCaptureError() {}, onEndpointSignal,
        }, { nativeVadController });
        sdk.sherpaPush.mockResolvedValue({ text: 'keep listening', isEndpoint: true });
        await owner.startCapture({ handsFree: true, provider: 'local_neural', sessionId: 'vad-fallback' });
        expect(nativeVadController.isActiveSession('vad-fallback')).toBe(true);
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(2);
        pcm.emitFrame();
        await pcm.capture.waitForDrain();
        expect(onEndpointSignal).not.toHaveBeenCalled();

        // Fail only the external detector SDK, not the physical mic shared with STT.
        pushVadAudioFrame.mockRejectedValueOnce(new Error('native detector stopped'));
        sdk.sherpaPush.mockResolvedValueOnce({ text: 'keep listening', isEndpoint: false });
        pcm.emitFrame();
        await pcm.capture.waitForDrain();
        await detectorCancelled.promise;
        expect(nativeVadController.isActiveSession('vad-fallback')).toBe(false);
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(1);
        expect(pcm.nativeStop).not.toHaveBeenCalled();
        expect(onEndpointSignal).not.toHaveBeenCalled();

        pcm.emitFrame();
        await pcm.capture.waitForDrain();
        expect(onEndpointSignal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            sessionId: 'vad-fallback', source: 'native_stream', transcript: 'keep listening',
        }));
        await owner.stopSession();
        expect(cancelVadDetector).toHaveBeenCalledOnce();
        expect(pcm.nativeStop).toHaveBeenCalledOnce();
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(0);
        expect(pcm.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('releases the native VAD subscriber when local-neural startup is aborted', async () => {
        const pcm = createSharedNativePcmHarness();
        const createVadDetector = vi.fn(async () => {});
        const cancelVadDetector = vi.fn(async () => {});
        const bridge = await resolveNativeSileroVadBridge({ createVadDetector,
            pushVadAudioFrame: vi.fn(async () => ({ speechStarted: false, speechEnded: false })), cancelVadDetector,
        }, { frameSource: pcm.capture });
        const nativeVadController = createNativeVadController({ bridge, onEndpointSignal() {} });
        const recognizerStart = createDeferred<void>();
        const startEntered = createDeferred<void>();
        sdk.sherpaCreate.mockImplementation(async () => { startEntered.resolve(); await recognizerStart.promise; });
        const onCaptureStarted = vi.fn();
        const owner = createLocalVoiceCaptureOwner({ getSettings: () => neuralSettings, onCaptureStarted, onCaptureError() {} },
            { nativeVadController });
        const abortController = new AbortController();
        const start = owner.startCapture({ handsFree: true, localNeuralExecution: 'device', provider: 'local_neural',
            sessionId: 'local-neural-abort', signal: abortController.signal });
        await startEntered.promise;
        // The real recognizer allocates before subscribing; only VAD owns PCM
        // while native recognizer creation is pending.
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(1);
        abortController.abort();
        expect(onCaptureStarted).not.toHaveBeenCalled();
        recognizerStart.resolve();
        await start;
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(0);
        expect(cancelVadDetector).toHaveBeenCalledOnce();
        expect(sdk.sherpaCancel).toHaveBeenCalledOnce();
        expect(onCaptureStarted).not.toHaveBeenCalled();
        await owner.stopSession('local-neural-abort');
        expect(pcm.capture.getSnapshot()).toMatchObject({ streamId: null, subscriberCount: 0 });
        expect(pcm.nativeStop).toHaveBeenCalledOnce();
        expect(pcm.coordinator.getSnapshot().leaseCount).toBe(0);
    });

    it('settles End while native VAD startup is pending and disposes the late detector and PCM lease', async () => {
        vi.useFakeTimers();
        const nativeStartEntered = createDeferred<void>();
        const releaseNativeStart = createDeferred<void>();
        const pcm = createSharedNativePcmHarness({
            nativeStart: async () => {
                nativeStartEntered.resolve();
                await releaseNativeStart.promise;
                return { streamId: 'native-stream' };
            },
        });
        const createVadDetector = vi.fn(async () => {});
        const detectorCancelled = createDeferred<void>();
        const cancelVadDetector = vi.fn(async () => { detectorCancelled.resolve(); });
        const bridge = await resolveNativeSileroVadBridge({
            createVadDetector,
            pushVadAudioFrame: vi.fn(async () => ({
                speechStarted: true,
                speechEnded: true,
            })),
            cancelVadDetector,
        }, {
            frameSource: pcm.capture,
        });
        expect(bridge).not.toBeNull();

        const onCaptureStarted = vi.fn();
        const onEndpointSignal = vi.fn();
        const onSpeechCandidateStart = vi.fn();
        const onSpeechCandidateFalseAlarm = vi.fn();
        const nativeVadController = createNativeVadController({
            bridge,
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
        });
        const owner = createLocalVoiceCaptureOwner({
            getSettings: () => neuralSettings,
            onCaptureStarted,
            onCaptureError: vi.fn(),
            onEndpointSignal,
            onSpeechCandidateStart,
            onSpeechCandidateFalseAlarm,
        }, {
            nativeVadController,
        });

        const startPromise = owner.startCapture({
            handsFree: true,
            localNeuralExecution: 'device',
            provider: 'local_neural',
            sessionId: 'local-neural-pending-vad',
        });
        await nativeStartEntered.promise;
        expect(createVadDetector).toHaveBeenCalledTimes(1);
        expect(pcm.platformApply).toHaveBeenCalledTimes(1);

        const stopPromise = owner.stopSession('local-neural-pending-vad');
        try {
            // End needs neither native startup completion nor advancement of
            // the owner's terminal-abandonment clock to release its authority.
            await stopPromise;
        } finally {
            // Let uncancellable SDK work settle only after observing End.
            releaseNativeStart.resolve();
            await Promise.all([startPromise, stopPromise]);
        }
        await detectorCancelled.promise;
        expect(cancelVadDetector).toHaveBeenCalledTimes(1);

        expect(onCaptureStarted).not.toHaveBeenCalled();
        expect(sdk.sherpaCreate).not.toHaveBeenCalled();
        expect(onEndpointSignal).not.toHaveBeenCalled();
        expect(onSpeechCandidateStart).not.toHaveBeenCalled();
        expect(onSpeechCandidateFalseAlarm).not.toHaveBeenCalled();
        expect(pcm.capture.getSnapshot()).toMatchObject({
            streamId: null,
            subscriberCount: 0,
        });
        expect(pcm.nativeStop).toHaveBeenCalledTimes(1);
        expect(pcm.coordinator.getSnapshot().leaseCount).toBe(0);
        expect(pcm.capture.getSnapshot().subscriberCount).toBe(0);
    });

    it('settles stop and releases capture admission when browser microphone acquisition never settles', async () => {
        const first = installBrowserCaptureBoundary();
        const strandedAcquisition = createDeferred<MediaStream>();
        first.captureAcquire.mockImplementationOnce(() => strandedAcquisition.promise);
        const admission = createVoiceCaptureAdmissionController();
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {} });
        const captureOwner = createVoiceCaptureAdmissionBinding({ admission, captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        const start = captureOwner.startCapture({ handsFree: false, provider: 'device', sessionId: 'dictation-session' });
        await first.captureEntered;
        expect(first.captureAcquire).toHaveBeenCalledOnce();
        await captureOwner.stopSession('dictation-session');
        await start;
        const conversation = admission.acquire('conversation');
        expect(conversation.status).toBe('acquired');
        if (conversation.status === 'acquired') conversation.lease.release();
        const retry = installBrowserCaptureBoundary();
        await captureOwner.startCapture({ handsFree: false, provider: 'device', sessionId: 'dictation-session-2' });
        expect(retry.captureAcquire).toHaveBeenCalledOnce();
        strandedAcquisition.resolve(first.micStream);
        await first.trackStopped;
        expect(first.micTrack.stop).toHaveBeenCalledOnce();
        expect(retry.micTrack.stop).not.toHaveBeenCalled();
        expect(rawCaptureOwner.isCaptureActive('dictation-session-2')).toBe(true);
        await captureOwner.stopSession('dictation-session-2');
    });

    it('abandons a never-settling recorded-audio start so admission and an immediate retry are not pinned', async () => {
        vi.useFakeTimers();
        const firstStart = createDeferred<void>();
        const first = createRecordingBoundary('file:///stale-recording.wav');
        const retry = createRecordingBoundary('file:///retry-recording.wav');
        first.recorder.prepareToRecordAsync.mockImplementation(() => firstStart.promise);
        const recordings = [first.session, retry.session];
        const admission = createVoiceCaptureAdmissionController();
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted() {}, onCaptureError() {} },
            { createRecordingMicSession: () => {
                const session = recordings.shift(); if (!session) throw new Error('unexpected recording acquisition'); return session;
            }, terminalAbandonmentMs: 25 });
        const captureOwner = createVoiceCaptureAdmissionBinding({ admission, captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        const start = captureOwner.startCapture({ handsFree: false, provider: 'recorded_audio', sessionId: 'dictation-session' });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(first.recorder.prepareToRecordAsync).toHaveBeenCalledOnce();
            const stop = captureOwner.stopSession('dictation-session');
            await vi.advanceTimersByTimeAsync(25);
            await stop;
            const conversation = admission.acquire('conversation');
            expect(conversation.status).toBe('acquired');
            if (conversation.status === 'acquired') conversation.lease.release();
            await captureOwner.startCapture({ handsFree: false, provider: 'recorded_audio', sessionId: 'dictation-session-2' });
            expect(retry.recorder.record).toHaveBeenCalledOnce();
            firstStart.resolve();
            await start;
            expect(first.recorder.stop).toHaveBeenCalledOnce();
            expect(retry.recorder.stop).not.toHaveBeenCalled();
            await expect(captureOwner.stopCapture({
                provider: 'recorded_audio', sessionId: 'dictation-session-2',
            })).resolves.toEqual({ provider: 'recorded_audio', uri: 'file:///retry-recording.wav' });
            await captureOwner.stopSession('dictation-session-2');
        } finally {
            firstStart.resolve();
            await start;
            await captureOwner.stopSession();
        }
    });

    it('abandons a never-settling provider stop and fences its late settlement from a retry', async () => {
        vi.useFakeTimers();
        const staleCancel = createDeferred<void>();
        sdk.sherpaCancel.mockImplementationOnce(() => staleCancel.promise);
        const admission = createVoiceCaptureAdmissionController();
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings: () => neuralSettings, onCaptureStarted() {}, onCaptureError() {} },
            { terminalAbandonmentMs: 25 });
        const captureOwner = createVoiceCaptureAdmissionBinding({ admission, captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        await captureOwner.startCapture({ handsFree: false, provider: 'local_neural', sessionId: 'dictation-session' });
        const stop = captureOwner.stopSession('dictation-session');
        await vi.advanceTimersByTimeAsync(25);
        await stop;
        expect(sdk.sherpaCancel).toHaveBeenCalledOnce();
        const conversation = admission.acquire('conversation');
        expect(conversation.status).toBe('acquired');
        if (conversation.status === 'acquired') conversation.lease.release();
        await captureOwner.startCapture({ handsFree: false, provider: 'local_neural', sessionId: 'dictation-session-2' });
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(1);
        const retryJob = sdk.sherpaCreate.mock.calls[1]?.[0].jobId;
        staleCancel.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(rawCaptureOwner.isCaptureActive('dictation-session-2')).toBe(true);
        nativeAudio.emit();
        await nativeAudio.capture.waitForDrain();
        expect(sdk.sherpaPush).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: retryJob }));
        await captureOwner.stopSession('dictation-session-2');
    });

    it('does not let a successful stale local-neural stop clear a same-session retry with a different execution owner', async () => {
        const { getSettings } = await installDaemonCaptureBoundary();
        const staleFinish = createDeferred<Awaited<ReturnType<SherpaNativeModule['finishStreaming']>>>();
        const finishEntered = createDeferred<void>();
        sdk.sherpaFinish.mockImplementationOnce(() => { finishEntered.resolve(); return staleFinish.promise; });
        const onCaptureError = vi.fn();
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError },
            { terminalAbandonmentMs: 25 });
        const captureOwner = createVoiceCaptureAdmissionBinding({ admission: createVoiceCaptureAdmissionController(),
            captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        await captureOwner.startCapture({ handsFree: false, localNeuralExecution: 'device', provider: 'local_neural', sessionId: 'dictation-session' });
        expect(onCaptureError.mock.calls).toEqual([]);
        expect(rawCaptureOwner.isCaptureActive('dictation-session')).toBe(true);
        expect(sdk.sherpaCreate).toHaveBeenCalledOnce();
        const staleResult = captureOwner.stopCapture({ provider: 'local_neural', sessionId: 'dictation-session' });
        await finishEntered.promise;
        vi.useFakeTimers();
        const terminalStop = captureOwner.stopSession('dictation-session');
        await vi.advanceTimersByTimeAsync(25); await terminalStop;
        vi.useRealTimers();
        await captureOwner.startCapture({ handsFree: false, localNeuralExecution: 'daemon', provider: 'local_neural', sessionId: 'dictation-session' });
        staleFinish.resolve({ status: 'finalized', text: 'stale result for old caller' });
        await expect(staleResult).resolves.toMatchObject({ provider: 'local_neural', text: 'stale result for old caller' });
        await rawCaptureOwner.setMuted({ muted: true, sessionId: 'dictation-session' });
        expect(rawCaptureOwner.isCaptureActive('dictation-session')).toBe(true);
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(0);
        const chunksBeforeMutedInput = network.requests.filter(request => request.method === 'daemon.voiceInference.stt.stream.chunk').length;
        nativeAudio.emit(); await nativeAudio.capture.waitForDrain();
        expect(network.requests.filter(request => request.method === 'daemon.voiceInference.stt.stream.chunk')).toHaveLength(chunksBeforeMutedInput);
        await rawCaptureOwner.setMuted({ muted: false, sessionId: 'dictation-session' });
        nativeAudio.emit(); await nativeAudio.capture.waitForDrain();
        await network.waitForRpcRequest((request, requests) => request.method === 'daemon.voiceInference.stt.stream.chunk'
            && requests.filter(request => request.method === 'daemon.voiceInference.stt.stream.chunk').length === chunksBeforeMutedInput + 1);
        expect(network.requests.filter(request => request.method === 'daemon.voiceInference.stt.stream.chunk'))
            .toHaveLength(chunksBeforeMutedInput + 1);
        expect(onCaptureError).not.toHaveBeenCalled();
        await captureOwner.stopSession('dictation-session');
    });

    it('does not let a rejected stale local-neural stop fail a same-session retry', async () => {
        const { getSettings } = await installDaemonCaptureBoundary();
        const staleFinish = createDeferred<Awaited<ReturnType<SherpaNativeModule['finishStreaming']>>>();
        const finishEntered = createDeferred<void>();
        sdk.sherpaFinish.mockImplementationOnce(() => { finishEntered.resolve(); return staleFinish.promise; });
        const onCaptureError = vi.fn();
        const rawCaptureOwner = createLocalVoiceCaptureOwner({ getSettings, onCaptureStarted() {}, onCaptureError },
            { terminalAbandonmentMs: 25 });
        const captureOwner = createVoiceCaptureAdmissionBinding({ admission: createVoiceCaptureAdmissionController(),
            captureOwner: rawCaptureOwner, productOwner: 'dictation' });
        await captureOwner.startCapture({ handsFree: false, localNeuralExecution: 'device', provider: 'local_neural', sessionId: 'dictation-session' });
        expect(onCaptureError.mock.calls).toEqual([]);
        expect(rawCaptureOwner.isCaptureActive('dictation-session')).toBe(true);
        expect(sdk.sherpaCreate).toHaveBeenCalledOnce();
        const staleResult = captureOwner.stopCapture({ provider: 'local_neural', sessionId: 'dictation-session' });
        await finishEntered.promise;
        vi.useFakeTimers();
        const terminalStop = captureOwner.stopSession('dictation-session');
        await vi.advanceTimersByTimeAsync(25); await terminalStop;
        vi.useRealTimers();
        await captureOwner.startCapture({ handsFree: false, localNeuralExecution: 'daemon', provider: 'local_neural', sessionId: 'dictation-session' });
        staleFinish.reject(new Error('native_finalization_failed'));
        await expect(staleResult).resolves.toMatchObject({ provider: 'local_neural', text: '' });
        expect(rawCaptureOwner.isCaptureActive('dictation-session')).toBe(true);
        expect(nativeAudio.capture.getSnapshot().subscriberCount).toBe(1);
        expect(onCaptureError).not.toHaveBeenCalled();
        await captureOwner.stopSession('dictation-session');
    });
});
