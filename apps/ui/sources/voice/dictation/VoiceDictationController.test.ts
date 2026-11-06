import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred, createMachineFixture, createPlainMachineRowFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import type { RecordedAudioTranscriptionRequest } from '@/voice/runtime/input/recordedAudioTranscriptionController';
import { DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema, DaemonVoiceSpeechTranscribeResponseSchema } from '@happier-dev/protocol/daemon/voiceSpeech';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';

import { createVoiceCaptureAdmissionBinding } from '@/voice/runtime/input/VoiceCaptureAdmissionBinding';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';

const network = await installSessionOpsNetworkBoundary();
const { createVoiceDictationController: createActualVoiceDictationController } = await import('./VoiceDictationController');
const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');
const { storage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resolveVoiceExecutionMachineId } = await import('@/voice/settings/executionMachine');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const controllers: Array<ReturnType<typeof createActualVoiceDictationController>> = [];
const captures: Array<Readonly<{ stopSession(): Promise<void>; dispose(): Promise<void> }>> = [];
function createVoiceDictationController(deps: Parameters<typeof createActualVoiceDictationController>[0]) {
    const controller = createActualVoiceDictationController({ resolveExecutionMachineId: () => resolveVoiceExecutionMachineId(), ...deps });
    controllers.push(controller);
    return controller;
}
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
const { createLocalVoiceCaptureOwner } = await import('@/voice/runtime/input/LocalVoiceCaptureOwner');
const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
const { createNativeMicSession, createExpoAudioRecordingMicSession } = await import('@/voice/runtime/mic/NativeMicSession');
import { createVoiceFileRecording } from '@happier-dev/audio-stream-native';

const physicalRecognition = vi.hoisted(() => ({
    listeners: new Map<string, (event: unknown) => void>(),
    text: (): string => '',
    start: vi.fn(),
}));
let files = createExpoFileSystemFileMock();
vi.mock('expo-file-system', () => ({ File: class {
    constructor(uri: string) { return new files.module.File(uri); }
} }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-audio', () => ({ AudioModule: { requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }) } }));
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    addListener: (name: string, listener: (event: unknown) => void) => {
        physicalRecognition.listeners.set(name, listener);
        return { remove: () => { physicalRecognition.listeners.delete(name); } };
    },
    start: () => {
        physicalRecognition.start();
        physicalRecognition.listeners.get('audiostart')?.({});
    },
    stop: () => {
        physicalRecognition.listeners.get('result')?.({ isFinal: true, results: [{ transcript: physicalRecognition.text() }] });
        physicalRecognition.listeners.get('end')?.({});
    },
} }));

/** Actual capture/microphone/recorder owners above SDK start, stop and OS restore. */
function createRealCaptureBoundary(input: Readonly<{
    recordedUri?: () => string | null;
    recognizedText?: () => string;
    prepare?: () => Promise<void>;
    stop?: () => Promise<string | null>;
    restore?: () => Promise<void>;
}> = {}) {
    const native = createNativeVoicePcmCaptureHarness();
    const preparing = createDeferred<void>();
    const restoring = createDeferred<void>();
    const stopCaptureEntered = createDeferred<void>();
    const stopSessionEntered = createDeferred<void>();
    const restore = input.restore ?? native.restore.getMockImplementation()!;
    native.restore.mockImplementation(async (...args) => { restoring.resolve(); await restore(...args); });
    physicalRecognition.text = input.recognizedText ?? (() => '');
    const finalizeRecording = async () => {
        stopCaptureEntered.resolve();
        const uri = await (input.stop ? input.stop() : input.recordedUri?.() ?? 'file:///dictation.m4a');
        if (uri) files.files.set(uri, [1, 2, 3, 4]);
        return uri;
    };
    const sdk = { ...native.nativeModule,
        startFileRecording: async () => { preparing.resolve(); await input.prepare?.(); return { recordingId: 'dictation-recording' }; },
        setFileRecordingMuted: async () => {},
        stopFileRecording: async () => ({ uri: await finalizeRecording() ?? '' }),
    };
    const real = createLocalVoiceCaptureOwner({ getSettings: () => ({}), onCaptureStarted: () => {}, onCaptureError: () => {} }, {
        createDeviceSttController: deps => createDeviceSttController({ ...deps, getAudioSessionCoordinator: () => native.coordinator }),
        createLiveMicSession: () => createNativeMicSession(),
        createRecordingMicSession: () => createExpoAudioRecordingMicSession({
            requestPermission: async () => ({ granted: true, canAskAgain: true }),
            acquireAudioMode: () => native.coordinator.acquire({ ownerId: 'dictation-test', mode: 'dictation',
                input: true, output: false, aec: 'off', capture: 'provider_managed_exclusive' }),
            createNativeFileRecording: () => createVoiceFileRecording(sdk),
            createRecorder: () => {
                let uri: string | null = null;
                return { get uri() { return uri; },
                    prepareToRecordAsync: async () => { preparing.resolve(); await input.prepare?.(); }, pause() {}, record() {},
                    stop: async () => { uri = await finalizeRecording(); } };
            },
        }),
    });
    captures.push({ stopSession: real.stopSession, dispose: native.coordinator.dispose });
    return {
        coordinator: native.coordinator,
        emitSession: native.emitSession,
        startCapture: vi.fn(real.startCapture),
        stopCapture: vi.fn(real.stopCapture),
        stopSession: vi.fn((...args: Parameters<typeof real.stopSession>) => { stopSessionEntered.resolve(); return real.stopSession(...args); }),
        preparing: preparing.promise, restoring: restoring.promise,
        stopCaptureEntered: stopCaptureEntered.promise, stopSessionEntered: stopSessionEntered.promise,
    };
}

let speechHome: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
let speechReply: (() => Promise<string | null | undefined>) | null = null;
type SpeechFault = 'credential_unavailable' | 'machine_unavailable' | 'transfer_failed' | 'provider_secret_raw_error';
let speechFault: SpeechFault | null = null;
/** The spy observes the public call and delegates every decision to the real owner. */
function createTranscriptionProbe(reply: (observed: RecordedAudioTranscriptionRequest) => Promise<string | null | undefined> = async () => null,
    fault?: SpeechFault) {
    const entered = createDeferred<void>();
    const probe = vi.fn(async (request: RecordedAudioTranscriptionRequest) => {
        speechFault = fault ?? null;
        if (speechFault === 'machine_unavailable') {
            const current = storage.getState().machines['machine-ready-at-start'];
            if (!current) throw new Error('Expected fixture machine');
            const unavailable = { ...current, active: false, activeAt: 0 };
            storage.setState({ machines: { [unavailable.id]: unavailable },
                machineListByServerId: { [speechHome.home.id]: [unavailable] } });
        }
        speechReply = () => { entered.resolve(); return reply(request); };
        return await recordedAudioTranscriptionController.transcribe(request);
    });
    return Object.assign(probe, { entered: entered.promise });
}
beforeEach(async ({ task }) => {
    // Real credentials must be admitted in the SDK store for this case's
    // platform, before the explicit Account/Home fixture starts.
    const webCase = task.name.includes('web Blob recording')
        || task.name === 'records web Auto local-neural Dictation before using the single-shot transcription owner'
        || task.name === 'pins the selected execution machine for the whole recorded-audio attempt';
    (Platform as unknown as { OS: string }).OS = webCase ? 'web' : ORIGINAL_PLATFORM_OS;
    files = createExpoFileSystemFileMock();
    physicalRecognition.start.mockClear();
    speechReply = null; speechFault = null;
    network.resetRequests();
    const serverUrl = 'https://dictation-controller.test';
    await network.addHome(serverUrl, 'artifact-account');
    const features = createRootLayoutFeaturesResponse({ features: {
        voice: { enabled: true },
        machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
    } });
    features.capabilities.machines.liveStream.serverRouted = { disabledReason: null,
        caps: MachineLiveStreamRelayCapsV1Schema.parse({ maxBitrateBps: 64000, maxFramesPerSecond: 50,
            maxFrameBytes: 16000, maxDurationMs: 60000, maxTotalBytes: 1000000,
            maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1 }) };
    speechHome = await createPlainArtifactHomeFixture(serverUrl, { serverFeatures: features,
        handleRequest: async (path, init) => {
            const read = createPlainMachineReadHttpResponseFixture(path, init);
            if (read) return read;
            if (path.startsWith('/v1/machines/')) {
                const id = decodeURIComponent(path.slice('/v1/machines/'.length).split('/')[0]!);
                const row = createPlainMachineRowFixture({ id, accountId: 'artifact-account' });
                return path.endsWith('/access') ? Response.json({ machineId: id, custodian: row.access!.custodian,
                    access: row.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] })
                    : Response.json({ machine: row });
            }
            return null;
        },
    });
    const machine = createMachineFixture({ id: 'machine-ready-at-start', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [speechHome.home.id]: [machine] } });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ experiments: true, featureToggles: {
        voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true },
        voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId: machine.id } } }, storage.getState().settings));
    primeServerFeaturesSnapshot({ serverId: speechHome.home.id, snapshot: { status: 'ready', features } });
    const recipient = createTransferRecipientKeyPair();
    let sizeBytes = 4;
    network.setRpcResponder(async ({ method, payload }) => {
        const request = payload as Record<string, unknown>;
        if (method.endsWith('upload.init')) {
            if (speechFault === 'transfer_failed') return { success: false, error: 'transfer_failed', errorCode: 'transfer_failed' };
            sizeBytes = Number(request.sizeBytes); return {
            success: true, uploadId: 'controller-upload', chunkSizeBytes: 65536, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 }; }
        if (method.endsWith('upload.chunk') || method.endsWith('upload.abort') || method.endsWith('stt.cancel')) return { success: true };
        if (method.endsWith('upload.finalize')) {
            const result = { success: true, uploadId: 'controller-upload', sizeBytes, sha256: '0'.repeat(64) };
            return method.startsWith('daemon.voice.speech') ? DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema.parse(result)
                : { ...result, path: '/tmp/controller.m4a' };
        }
        if (method.endsWith('stt.transcribe') || method === 'daemon.voice.speech.transcribe') {
            if (speechFault === 'credential_unavailable') return DaemonVoiceSpeechTranscribeResponseSchema.parse({ ok: false, errorCode: speechFault });
            if (speechFault === 'provider_secret_raw_error') throw Object.assign(new Error('private provider detail'), { code: speechFault });
            const text = await speechReply?.() ?? '';
            if (method === 'daemon.voice.speech.transcribe') return DaemonVoiceSpeechTranscribeResponseSchema.parse({ ok: true, requestId: request.requestId, text });
            return { ok: true, requestId: request.requestId, text, language: request.language ?? null, modelPackId: request.packId ?? null };
        }
        throw new Error(`Unexpected Dictation SDK request: ${method}`);
    });
});
afterAll(() => network.dispose());

const ORIGINAL_PLATFORM_OS = Platform.OS;

const EXPECTED_DICTATION_LIMITS = {
    // Former cutoffs are regression probes, not current capture/text limits.
    captureDurationMs: 60_000,
    transcriptCharacters: 8_000,
    recordedAudioBytes: 8 * 1024 * 1024,
} as const;

const TEST_RECORDED_AUDIO_BOUNDARY = {
    measureRecordedAudioBytes: async () => 4,
    deleteRecordedAudio: async () => {},
} as const;

function createPendingCaptureStartHarness() {
    const startSettled = createDeferred<void>();
    const teardownSettled = createDeferred<void>();
    let prepareCount = 0;
    const rawCaptureOwner = createRealCaptureBoundary({
        prepare: async () => {
            if (++prepareCount === 1) await startSettled.promise;
        },
        restore: async () => { await teardownSettled.promise; },
    });
    const admission = createVoiceCaptureAdmissionController();
    const captureOwner = createVoiceCaptureAdmissionBinding({
        admission,
        captureOwner: rawCaptureOwner,
        productOwner: 'dictation',
    });
    const controller = createVoiceDictationController({
        captureOwner,
        ...TEST_RECORDED_AUDIO_BOUNDARY,
        getSettings: () => ({
            voice: {
                providerId: 'local_conversation',
                dictation: { sttBinding: 'same_as_local' },
                providers: {
                    local_conversation: {
                        schemaVersion: 1,
                        config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                    },
                },
            },
        }),
        transcribeRecordedAudio: createTranscriptionProbe(),
    });
    return {
        admission,
        controller,
        getObservedSignal: () => rawCaptureOwner.startCapture.mock.calls[0]?.[0].signal ?? null,
        hasEnteredPrepare: () => prepareCount > 0,
        rawCaptureOwner,
        startSettled,
        teardownSettled,
    };
}

afterEach(async () => {
    vi.useRealTimers();
    for (const controller of controllers.splice(0)) await controller.cancel();
    for (const capture of captures.splice(0)) { await capture.stopSession(); await capture.dispose(); }
    await speechHome?.dispose();
    (Platform as unknown as { OS: string }).OS = ORIGINAL_PLATFORM_OS;
});

describe('createVoiceDictationController', () => {
    it('uses explicit Dictation STT instead of silently inheriting conversational Voice', async () => {
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const settings = {
            voice: {
                providerId: 'local_conversation',
                assistantLanguage: 'es',
                providers: {
                    local_conversation: {
                        schemaVersion: 1,
                        config: { stt: { provider: 'device' } },
                    },
                },
                dictation: {
                    sttBinding: 'explicit',
                    language: 'de-CH',
                    stt: {
                        provider: 'happier.voice.openai-compat/stt',
                    },
                },
            },
        };
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'eigenständige Auswahl');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => settings,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'recorded_audio',
            settings: expect.objectContaining({
                voice: expect.objectContaining({
                    assistantLanguage: 'es',
                    dictation: expect.objectContaining({ language: 'de-CH' }),
                    providerId: 'local_conversation',
                    providers: expect.objectContaining({
                        local_conversation: expect.objectContaining({
                            config: expect.objectContaining({
                                stt: expect.objectContaining({
                                    provider: 'happier.voice.openai-compat/stt',
                                }),
                            }),
                        }),
                    }),
                }),
            }),
        }));
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'eigenständige Auswahl',
        });
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            capturePurpose: 'dictation',
            settings: expect.objectContaining({
                voice: expect.objectContaining({
                    assistantLanguage: 'es',
                    dictation: expect.objectContaining({ language: 'de-CH' }),
                }),
            }),
        }));
    });

    it('keeps origin-neutral capture correlation out of Session-targeted transcription routing', async () => {
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'workflow text');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            transcribeRecordedAudio,
        });
        const target = {
            controlId: '["workflowAuthoring","draft-1","step-1","mounted-1"]',
            transcriptionSessionId: null,
        } as const;

        await expect(controller.toggle(target)).resolves.toEqual({ kind: 'started' });
        await expect(controller.toggle(target)).resolves.toEqual({
            kind: 'completed',
            text: 'workflow text',
        });

        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: target.controlId,
        }));
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: null,
        }));
    });

    it('inherits Local Voice STT only through the visible same-as-local binding', async () => {
        const captureOwner = createRealCaptureBoundary({ recognizedText: () => 'bound local choice' });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                    dictation: {
                        sttBinding: 'same_as_local',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'device',
        }));
    });

    it('re-resolves the persisted Dictation selection before every normal start', async () => {
        let provider: 'device' | 'happier.voice.openai-compat/stt' = 'device';
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => null });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider },
                    },
                },
            }),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await controller.toggle('session-1');
        provider = 'happier.voice.openai-compat/stt';
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });

        expect(captureOwner.startCapture.mock.calls.map(([request]) => request.provider))
            .toEqual(['device', 'recorded_audio']);
    });

    it('captures one utterance through the selected recorded-audio STT provider', async () => {
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const transcribeRecordedAudio = createTranscriptionProbe(async () => ' dictated text ');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(controller.getSnapshot()).toEqual({
            sessionId: 'session-1',
            status: 'listening',
        });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            provider: 'recorded_audio',
            handsFree: false,
            signal: expect.any(AbortSignal),
        }));

        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'dictated text',
        });
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            uri: 'file:///dictation.m4a',
            signal: expect.any(AbortSignal),
        }));
        await captureOwner.stopSessionEntered;
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
    });

    it('supersedes pending transcription with a fresh Dictation attempt and drops the stale text', async () => {
        const stale = createDeferred<string>();
        let requestCount = 0;
        let firstSignal: AbortSignal | null | undefined;
        const transcribeRecordedAudio = createTranscriptionProbe(async request => {
            if (++requestCount === 1) {
                firstSignal = request.signal;
                return await stale.promise;
            }
            return 'fresh dictated text';
        });
        const captureOwner = createRealCaptureBoundary();
        const controller = createVoiceDictationController({ captureOwner, ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({ voice: { providerId: 'local_conversation',
                dictation: { sttBinding: 'same_as_local' }, providers: { local_conversation: {
                    schemaVersion: 1, config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                } } } }), transcribeRecordedAudio });
        await controller.toggle('session-1');
        const oldCompletion = controller.toggle('session-1');
        try {
            await transcribeRecordedAudio.entered;
            expect(controller.getSnapshot().status).toBe('transcribing');
            await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
            expect(firstSignal?.aborted).toBe(true);
            expect(controller.getSnapshot().status).toBe('listening');
            stale.resolve('stale text must not enter the composer');
            await expect(oldCompletion).resolves.toEqual({ kind: 'cancelled' });
            await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'completed', text: 'fresh dictated text' });
            expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
            expect(captureOwner.stopSession).toHaveBeenCalledTimes(2);
        } finally {
            stale.resolve('discarded');
            await controller.cancel('session-1');
            await oldCompletion;
        }
    });

    it.each(['retry', 'discard', 'account cleanup', 'native lifecycle'] as const)('retains failed dictation audio until %s without recording again or idle work', async (disposition) => {
        const captureOwner = createRealCaptureBoundary();
        const deletion = createDeferred<void>();
        const deleteRecordedAudio = vi.fn(async () => { deletion.resolve(); });
        let failing = true;
        const transcribeRecordedAudio = createTranscriptionProbe(async () => {
            if (failing) throw new Error('speech service unavailable');
            return 'recovered editable words';
        });
        const controller = createVoiceDictationController({
            captureOwner, ...TEST_RECORDED_AUDIO_BOUNDARY, deleteRecordedAudio,
            nativeAudioSessionCoordinator: captureOwner.coordinator,
            getSettings: () => ({ voice: { dictation: { sttBinding: 'explicit',
                stt: { provider: 'happier.voice.openai-compat/stt' } } } }),
            transcribeRecordedAudio,
        });
        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'cancelled' });
        expect(controller.getSnapshot()).toMatchObject({ status: 'idle', failure: { canRetry: true } });
        expect(deleteRecordedAudio).not.toHaveBeenCalled();
        expect(captureOwner.stopSession).toHaveBeenCalledOnce();
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'cancelled' });
        expect(deleteRecordedAudio).not.toHaveBeenCalled();
        const notifications = vi.fn();
        const unsubscribe = controller.subscribe(notifications);
        // A retained failure is settled, with no scheduled transcription or publication.
        await Promise.resolve();
        expect(transcribeRecordedAudio).toHaveBeenCalledOnce();
        expect(notifications).not.toHaveBeenCalled();
        if (disposition === 'retry') {
            await expect(controller.retry('other-field')).resolves.toEqual({ kind: 'cancelled' });
            await expect(controller.retry('session-1')).resolves.toEqual({ kind: 'cancelled' });
            expect(controller.getSnapshot()).toMatchObject({ failure: { canRetry: true } });
            expect(deleteRecordedAudio).not.toHaveBeenCalled();
            failing = false;
            await expect(controller.retry('session-1')).resolves.toEqual({ kind: 'completed', text: 'recovered editable words' });
            expect(transcribeRecordedAudio.mock.calls.map(([request]) => request.uri))
                .toEqual(['file:///dictation.m4a', 'file:///dictation.m4a', 'file:///dictation.m4a']);
        } else if (disposition === 'discard') {
            await controller.discard('session-1');
        } else if (disposition === 'native lifecycle') {
            captureOwner.emitSession({ generation: captureOwner.coordinator.getSnapshot().generation,
                kind: 'lifecycle_changed', state: 'background' });
            controller.reportCaptureError({ controlSessionId: 'session-1', kind: 'provider_error', reason: 'late_capture_error' });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(deleteRecordedAudio).not.toHaveBeenCalled();
            expect(controller.getSnapshot()).toMatchObject({ failure: { canRetry: true } });
            await controller.discard('session-1');
        } else {
            await controller.cancel();
        }
        await deletion.promise;
        expect(captureOwner.startCapture).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledExactlyOnceWith('file:///dictation.m4a');
        expect(controller.getSnapshot()).toEqual({ sessionId: null, status: 'idle' });
        await expect(controller.retry('session-1')).resolves.toEqual({ kind: 'cancelled' });
        unsubscribe();
    });

    it('surfaces a failed recorded-audio deletion without discarding the completed transcript', async () => {
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation-retained.m4a' });
        const deleteRecordedAudio = vi.fn(async () => {
            throw new Error('recording_delete_failed');
        });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: createTranscriptionProbe(async () => 'usable transcript'),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'usable transcript',
        });

        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///dictation-retained.m4a');
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                sessionId: 'session-1',
                kind: 'provider_error',
                reason: 'capture_failed',
            },
        });
    });

    it('records web Auto local-neural Dictation before using the single-shot transcription owner', async () => {
        (Platform as unknown as { OS: string }).OS = 'web';
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///daemon-dictation.m4a' });
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'daemon transcript');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: {
                            provider: 'local_neural',
                            localNeural: {
                                assetId: 'sherpa-streaming-zipformer-bilingual-zh-en',
                                execution: 'auto',
                            },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'recorded_audio',
        }));

        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'daemon transcript',
        });
        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            uri: 'file:///daemon-dictation.m4a',
        }));
    });

    it('pins the selected execution machine for the whole recorded-audio attempt', async () => {
        (Platform as unknown as { OS: string }).OS = 'web';
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///daemon-dictation.m4a' });
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'open the project settings');
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        stt: {
                            provider: 'local_neural',
                            localNeural: {
                                assetId: 'dummy',
                                execution: 'auto',
                            },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: { ...storage.getState().settings.voice,
            executionMachine: { mode: 'fixed', machineId: null } } }, storage.getState().settings));
        expect(resolveVoiceExecutionMachineId()).toBeNull();
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'open the project settings',
        });

        expect(transcribeRecordedAudio).toHaveBeenCalledWith(expect.objectContaining({
            executionMachineId: 'machine-ready-at-start',
        }));
    });

    it('returns streaming device text without creating a recorded-audio transcription', async () => {
        const captureOwner = createRealCaptureBoundary({ recognizedText: () => ' device transcript ' });
        const transcribeRecordedAudio = createTranscriptionProbe();
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'device transcript',
        });
        expect(transcribeRecordedAudio).not.toHaveBeenCalled();
    });

    it('aborts and discards an in-flight transcription when its session is cancelled', async () => {
        let resolveTranscription: (value: string) => void = () => {};
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const transcribeRecordedAudio = createTranscriptionProbe((params: { signal?: AbortSignal | null }) => (
            new Promise<string>((resolve) => {
                resolveTranscription = resolve;
                params.signal?.addEventListener('abort', () => resolve('late transcript'), { once: true });
            })
        ));
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio,
        });

        await controller.toggle('session-1');
        const completion = controller.toggle('session-1');
        await transcribeRecordedAudio.entered;
        expect(transcribeRecordedAudio).toHaveBeenCalledTimes(1);

        await controller.cancel('session-1');
        resolveTranscription('late transcript');

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot().status).toBe('idle');
    });

    it('removes a recorded-audio artifact that settles after cancellation', async () => {
        let resolveStoppedCapture!: (uri: string) => void;
        const captureOwner = createRealCaptureBoundary({ stop: () => new Promise<string>(resolve => { resolveStoppedCapture = resolve; }) });
        const deleteRecordedAudio = vi.fn(async () => {});
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        const completion = controller.toggle('session-1');
        await captureOwner.stopCaptureEntered;
        expect(captureOwner.stopCapture).toHaveBeenCalledTimes(1);

        await controller.cancel('session-1');
        resolveStoppedCapture('file:///late-dictation.m4a');

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///late-dictation.m4a');
    });

    it.each([
        ['native recording', 'file:///dictation-cancel-before-finish.m4a'],
        ['web Blob recording', 'blob:dictation-cancel-before-finish'],
    ] as const)('releases a cancelled %s session while retaining exact-once late artifact cleanup', async (_surface, uri) => {
        if (uri.startsWith('blob:')) {
            (Platform as unknown as { OS: string }).OS = 'web';
        }
        let resolveStoppedCapture!: (uri: string) => void;
        const captureOwner = createRealCaptureBoundary({ stop: () => new Promise<string>(resolve => { resolveStoppedCapture = resolve; }) });
        const deleted = createDeferred<void>();
        const deleteRecordedAudio = vi.fn(async () => { deleted.resolve(); });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        let cancellationSettled = false;
        const cancellation = controller.cancel('session-1').then(() => {
            cancellationSettled = true;
        });

        await captureOwner.stopCaptureEntered;
        expect(captureOwner.stopCapture).toHaveBeenCalledOnce();
        await cancellation;
        expect(cancellationSettled).toBe(true);
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');

        resolveStoppedCapture(uri);
        await cancellation;
        await deleted.promise;
        expect(deleteRecordedAudio).toHaveBeenCalledWith(uri);
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
    });


    it('retains recording admission through native restore and admits only one simultaneous cancellation retry', async () => {
        const restore = createDeferred<void>();
        let restoreEntered = false;
        const rawCaptureOwner = createRealCaptureBoundary({
            recordedUri: () => 'file:///dictation-pending-restore.m4a',
            restore: async () => {
                restoreEntered = true;
                await restore.promise;
            },
        });
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });
        const deleted = createDeferred<void>();
        const deleteRecordedAudio = vi.fn(async () => { deleted.resolve(); });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({ voice: { dictation: {
                sttBinding: 'explicit', language: null,
                stt: { provider: 'happier.voice.openai-compat/stt' },
            } } }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        try {
            await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
            await controller.cancel('session-1');
            await rawCaptureOwner.restoring;
            expect(restoreEntered).toBe(true);
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledWith('session-1');
            expect(deleteRecordedAudio).not.toHaveBeenCalled();
            expect(admission.acquire('conversation')).toMatchObject({
                status: 'busy', activeOwner: 'dictation',
            });

            let firstRetrySettled = false;
            const firstRetry = controller.toggle('session-1').then((result) => {
                firstRetrySettled = true;
                return result;
            });
            const secondRetry = controller.toggle('session-1');
            await Promise.resolve();
            expect(rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
            expect(firstRetrySettled).toBe(false);

            restore.resolve();
            await expect(firstRetry).resolves.toEqual({ kind: 'started' });
            await expect(secondRetry).resolves.toEqual({ kind: 'cancelled' });
            await deleted.promise;
            expect(deleteRecordedAudio).toHaveBeenCalledOnce();
            expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///dictation-pending-restore.m4a');
            expect(rawCaptureOwner.startCapture).toHaveBeenCalledTimes(2);
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
            expect(controller.getSnapshot()).toEqual({ sessionId: 'session-1', status: 'listening' });
        } finally {
            restore.resolve();
            await controller.cancel('session-1');
        }
    });

    it('waits for prompt cancellation cleanup before restarting the same Dictation session', async () => {
        let resolveStoppedCapture!: (uri: string) => void;
        const captureOwner = createRealCaptureBoundary({ stop: () => new Promise<string>(resolve => { resolveStoppedCapture = resolve; }) });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    dictation: {
                        sttBinding: 'explicit',
                        language: null,
                        stt: { provider: 'happier.voice.openai-compat/stt' },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio: vi.fn(async () => {}),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await controller.cancel('session-1');
        const retry = controller.toggle('session-1');
        await Promise.resolve();
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(1);

        resolveStoppedCapture('file:///dictation-retry-after-cancel.m4a');

        await expect(retry).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('treats End Dictation during capture startup as cancellation', async () => {
        const start = createDeferred<void>();
        let prepareEntered = false;
        const captureOwner = createRealCaptureBoundary({ prepare: async () => {
            prepareEntered = true;
            await start.promise;
        } });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        const starting = controller.toggle('session-1');
        await captureOwner.preparing;
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(1);
        expect(prepareEntered).toBe(true);
        const ending = controller.toggle('session-1');
        start.resolve();

        await expect(ending).resolves.toEqual({ kind: 'cancelled' });
        await expect(starting).resolves.toEqual({ kind: 'cancelled' });
        expect(captureOwner.stopCapture).not.toHaveBeenCalled();
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        expect(controller.getSnapshot().status).toBe('idle');
    });

    it('keeps an uncooperative capture start pending without a deadline and cancels through teardown', async () => {
        vi.useFakeTimers();
        const harness = createPendingCaptureStartHarness();
        try {
            let startResult: unknown;
            let startFinished = false;
            const starting = harness.controller.toggle('session-1').then((result) => {
                startResult = result;
                startFinished = true;
            });
            await harness.rawCaptureOwner.preparing;
            expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(1);
            expect(harness.hasEnteredPrepare()).toBe(true);

            await vi.advanceTimersByTimeAsync(60_001);
            expect(harness.controller.getSnapshot()).toEqual({ sessionId: 'session-1', status: 'starting' });
            expect(startFinished).toBe(false);
            expect(harness.getObservedSignal()?.aborted).toBe(false);
            vi.useRealTimers();

            let cancelSettlementCount = 0;
            const cancellation = harness.controller.cancel('session-1').then(() => {
                cancelSettlementCount += 1;
            });
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(cancelSettlementCount).toBe(0);
            expect(startFinished).toBe(true);
            expect(startResult).toEqual({ kind: 'cancelled' });
            expect(harness.getObservedSignal()?.aborted).toBe(true);
            expect(harness.controller.getSnapshot()).toEqual({
                sessionId: null,
                status: 'idle',
            });
            expect(harness.rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
            expect(harness.admission.acquire('conversation')).toEqual({
                status: 'busy',
                activeOwner: 'dictation',
            });

            harness.startSettled.resolve();
            harness.teardownSettled.resolve();
            await harness.rawCaptureOwner.stopSession.mock.results[0]?.value;
            await Promise.all([starting, cancellation]);
            expect(cancelSettlementCount).toBe(1);
            await expect(harness.controller.toggle('session-1')).resolves.toEqual({
                kind: 'started',
            });
            expect(harness.rawCaptureOwner.startCapture).toHaveBeenCalledTimes(2);
            await harness.controller.cancel('session-1');
        } finally {
            vi.useRealTimers();
            harness.startSettled.resolve();
            harness.teardownSettled.resolve();
            await harness.controller.cancel('session-1');
        }
    });

    it('waits for cross-session teardown to release admission before starting the next session', async () => {
        const teardownSettled = createDeferred<void>();
        let restoreEntered = false;
        const rawCaptureOwner = createRealCaptureBoundary({
            restore: async () => {
                restoreEntered = true;
                await teardownSettled.promise;
            },
        });
        const admission = createVoiceCaptureAdmissionController();
        const captureOwner = createVoiceCaptureAdmissionBinding({
            admission,
            captureOwner: rawCaptureOwner,
            productOwner: 'dictation',
        });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        try {
            await expect(controller.toggle('session-a')).resolves.toEqual({ kind: 'started' });
            expect(physicalRecognition.start).toHaveBeenCalledOnce();

            let switchSettled = false;
            const switching = controller.toggle('session-b').then(
                (result) => ({ status: 'resolved' as const, result }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
            ).then((outcome) => {
                switchSettled = true;
                return outcome;
            });
            await rawCaptureOwner.restoring;
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
            expect(restoreEntered).toBe(true);

            expect(switchSettled).toBe(false);
            expect(physicalRecognition.start).toHaveBeenCalledOnce();
            expect(controller.getSnapshot().status).not.toBe('listening');
            expect(admission.acquire('conversation')).toEqual({
                status: 'busy',
                activeOwner: 'dictation',
            });

            teardownSettled.resolve();

            await expect(switching).resolves.toEqual({
                status: 'resolved',
                result: { kind: 'started' },
            });
            expect(physicalRecognition.start).toHaveBeenCalledTimes(2);
            expect(rawCaptureOwner.startCapture).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({ sessionId: 'session-b' }),
            );
            expect(rawCaptureOwner.stopSession).toHaveBeenCalledTimes(1);
            await controller.cancel('session-b');
        } finally {
            teardownSettled.resolve();
        }
    });

    it('projects capture-owner failure separately from silent cancellation', async () => {
        const captureOwner = createRealCaptureBoundary({ recognizedText: () => '' });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        controller.reportCaptureError({
            controlSessionId: 'session-1',
            kind: 'provider_error',
            reason: 'device_stt_unavailable',
        });

        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                id: 1,
                sessionId: 'session-1',
                kind: 'provider_error',
                reason: 'provider_unavailable',
            },
        });
        await captureOwner.stopSessionEntered;
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');

        controller.dismissFailure(1);
        expect(controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
    });

    it('does not start a retry until failed capture cleanup has completed', async () => {
        const cleanup = createDeferred<void>();
        const captureOwner = createRealCaptureBoundary({
            restore: async () => { await cleanup.promise; },
        });
        const controller = createVoiceDictationController({
            captureOwner,
            ...TEST_RECORDED_AUDIO_BOUNDARY,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await controller.toggle('session-1');
        controller.reportCaptureError({
            controlSessionId: 'session-1',
            kind: 'provider_error',
            reason: 'device_stt_unavailable',
        });
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'cancelled',
        });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(1);

        await captureOwner.stopSessionEntered;
        expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
        cleanup.resolve();
        await captureOwner.stopSession.mock.results[0]?.value;
        await new Promise<void>(resolve => setImmediate(resolve));
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'started',
        });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('retains capture beyond one minute and returns its text with one teardown', async () => {
        vi.useFakeTimers();
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const measureRecordedAudioBytes = vi.fn(async () => 4);
        const deleteRecordedAudio = vi.fn(async () => {});
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'editable long-capture transcript');
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes,
            deleteRecordedAudio,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await vi.advanceTimersByTimeAsync(EXPECTED_DICTATION_LIMITS.captureDurationMs);
        expect(controller.getSnapshot()).toEqual({
            sessionId: 'session-1',
            status: 'listening',
        });

        await vi.advanceTimersByTimeAsync(1);
        expect(controller.getSnapshot()).toEqual({ sessionId: 'session-1', status: 'listening' });
        vi.useRealTimers();
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed', text: 'editable long-capture transcript',
        });

        expect(captureOwner.stopCapture).toHaveBeenCalledTimes(1);
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
        expect(measureRecordedAudioBytes).toHaveBeenCalledOnce();
        expect(transcribeRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(deleteRecordedAudio).toHaveBeenCalledWith('file:///dictation.m4a');

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('keeps provider transcription visibly pending without a deadline and cancels it once', async () => {
        vi.useFakeTimers();
        let transcriptionSignal: AbortSignal | null = null;
        const transcribing = createDeferred<void>();
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const deleteRecordedAudio = vi.fn(async () => {});
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: createTranscriptionProbe((params) => {
                transcriptionSignal = params.signal ?? null;
                transcribing.resolve();
                return new Promise<string>(() => {});
            }),
        });

        await controller.toggle('session-1');
        const completion = controller.toggle('session-1');
        await transcribing.promise;
        expect(transcriptionSignal).not.toBeNull();
        await vi.advanceTimersByTimeAsync(60_001);
        expect(controller.getSnapshot().status).toBe('transcribing');

        const navigationCancel = controller.cancel('session-1');
        await vi.advanceTimersByTimeAsync(1);
        await navigationCancel;

        await expect(completion).resolves.toEqual({ kind: 'cancelled' });
        expect((transcriptionSignal as AbortSignal | null)?.aborted).toBe(true);
        expect(captureOwner.stopCapture).toHaveBeenCalledTimes(1);
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot().status).toBe('idle');

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        expect(captureOwner.startCapture).toHaveBeenCalledTimes(2);
    });

    it('keeps recorder finalization visibly pending until Cancel and still cleans a late recording', async () => {
        vi.useFakeTimers();
        let resolveStoppedCapture!: (uri: string) => void;
        const captureOwner = createRealCaptureBoundary({ stop: () => new Promise<string>(resolve => { resolveStoppedCapture = resolve; }) });
        const deleteRecordedAudio = vi.fn(async () => {});
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'must not start before finalization');
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio,
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        let completionResult: unknown;
        let completionSettled = false;
        const completion = controller.toggle('session-1').then((result) => {
            completionResult = result;
            completionSettled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(captureOwner.stopCapture).toHaveBeenCalledOnce();

        try {
            await vi.advanceTimersByTimeAsync(60_001);
            expect(completionSettled).toBe(false);
            expect(controller.getSnapshot()).toEqual({ sessionId: 'session-1', status: 'transcribing' });

            await controller.cancel('session-1');
            await completion;
            expect(completionSettled).toBe(true);
            expect(completionResult).toEqual({ kind: 'cancelled' });
            expect(captureOwner.startCapture).toHaveBeenCalledWith(expect.objectContaining({
                signal: expect.objectContaining({ aborted: true }),
            }));
            expect(controller.getSnapshot()).toMatchObject({
                sessionId: null,
                status: 'idle',
            });
            expect(controller.getSnapshot().failure).toBeUndefined();
            expect(deleteRecordedAudio).not.toHaveBeenCalled();
            expect(captureOwner.stopSession).toHaveBeenCalledWith('session-1');
            expect(transcribeRecordedAudio).not.toHaveBeenCalled();
        } finally {
            await controller.cancel('session-1');
            resolveStoppedCapture('file:///late-dictation-after-deadline.m4a');
            await completion;
        }

        await vi.advanceTimersByTimeAsync(0);
        expect(deleteRecordedAudio).toHaveBeenCalledWith(
            'file:///late-dictation-after-deadline.m4a',
        );
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(1);
    });

    it('does not project a stale late-artifact cleanup failure into a same-session retry', async () => {
        vi.useFakeTimers();
        let resolveFirstStop!: (uri: string | null) => void;
        const firstStop = new Promise<string | null>((resolve) => {
            resolveFirstStop = resolve;
        });
        let stopCount = 0;
        const captureOwner = createRealCaptureBoundary({
            stop: async () => ++stopCount === 1 ? await firstStop : null,
        });
        const deleted = createDeferred<void>();
        const deleteRecordedAudio = vi.fn(async () => {
            deleted.resolve();
            throw new Error('stale_recording_delete_failed');
        });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio,
            transcribeRecordedAudio: createTranscriptionProbe(async () => 'stale transcript'),
        });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        const staleCompletion = controller.toggle('session-1');
        await captureOwner.stopCaptureEntered;
        await controller.cancel('session-1');
        await expect(staleCompletion).resolves.toEqual({ kind: 'cancelled' });

        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'started' });
        await controller.cancel('session-1');
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(2);

        resolveFirstStop('file:///stale-dictation.m4a');
        await deleted.promise;
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot()).toEqual({
            sessionId: null,
            status: 'idle',
        });
    });

    it.each([
        { label: 'ASCII', scalar: 'a' },
        { label: 'four-byte Unicode', scalar: '😀' },
    ])('retains more than 8,000 $label code points without rejecting text', async ({
        scalar,
    }) => {
        const exact = scalar.repeat(EXPECTED_DICTATION_LIMITS.transcriptCharacters);
        const over = `${exact}${scalar}`;
        const transcripts = [exact, over];
        const captureOwner = createRealCaptureBoundary({ recognizedText: () => transcripts.shift() ?? '' });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'device' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(),
            deleteRecordedAudio: vi.fn(),
            transcribeRecordedAudio: createTranscriptionProbe(),
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: exact,
        });

        await controller.toggle('session-1');
        const result = await controller.toggle('session-1');
        expect(result.kind).toBe('completed');
        expect(result.kind === 'completed' && result.text === over).toBe(true);
        expect(controller.getSnapshot()).toEqual({ sessionId: null, status: 'idle' });
        expect(captureOwner.stopSession).toHaveBeenCalledTimes(2);
    });

    it.each([
        { code: 'credential_unavailable', reason: 'transcription_credentials_required' },
        { code: 'machine_unavailable', reason: 'transcription_machine_unavailable' },
        { code: 'transfer_failed', reason: 'transcription_transfer_failed' },
        { code: 'provider_secret_raw_error', reason: 'transcription_failed' },
    ] as const)('projects recorded-audio $code into bounded Dictation recovery', async ({ code, reason }) => {
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => 'file:///dictation.m4a' });
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => 4),
            deleteRecordedAudio: vi.fn(async () => {}),
            transcribeRecordedAudio: createTranscriptionProbe(async () => '', code),
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'cancelled' });
        expect(controller.getSnapshot()).toMatchObject({
            sessionId: null,
            status: 'idle',
            failure: {
                kind: 'provider_error',
                reason,
            },
        });
    });

    it('accepts the exact upload boundary and retains an oversized failed recording until Discard', async () => {
        const sizes = [
            EXPECTED_DICTATION_LIMITS.recordedAudioBytes,
            EXPECTED_DICTATION_LIMITS.recordedAudioBytes + 1,
        ];
        const captureOwner = createRealCaptureBoundary({ recordedUri: () => `file:///dictation-${sizes.length}.m4a` });
        const deleteRecordedAudio = vi.fn(async () => {});
        const transcribeRecordedAudio = createTranscriptionProbe(async () => 'bounded text');
        const controller = createVoiceDictationController({
            captureOwner,
            getSettings: () => ({
                voice: {
                    providerId: 'local_conversation',
                    dictation: { sttBinding: 'same_as_local' },
                    providers: {
                        local_conversation: {
                            schemaVersion: 1,
                            config: { stt: { provider: 'happier.voice.openai-compat/stt' } },
                        },
                    },
                },
            }),
            measureRecordedAudioBytes: vi.fn(async () => sizes.shift() ?? null),
            deleteRecordedAudio,
            transcribeRecordedAudio,
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({
            kind: 'completed',
            text: 'bounded text',
        });

        await controller.toggle('session-1');
        await expect(controller.toggle('session-1')).resolves.toEqual({ kind: 'cancelled' });
        expect(transcribeRecordedAudio).toHaveBeenCalledTimes(1);
        expect(deleteRecordedAudio).toHaveBeenCalledOnce();
        expect(controller.getSnapshot()).toMatchObject({
            failure: {
                kind: 'provider_error',
                reason: 'recorded_audio_limit_exceeded',
                canRetry: true,
            },
        });
        await controller.discard('session-1');
        expect(deleteRecordedAudio).toHaveBeenCalledTimes(2);
    });
});
