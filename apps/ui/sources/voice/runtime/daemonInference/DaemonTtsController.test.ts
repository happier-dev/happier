import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
// Scoped RPC clients reuse their physical sockets across cases. Keep those SDK
// handles while clearing only their observations at the next test boundary.
const rpcSocketBoundaries: typeof network.socketBoundaries = [];
import { getEventListeners } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { createDeferred, createMachineFixture } = await import("@/dev/testkit");
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { storage } = await import("@/sync/domains/state/storage");
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
const { getActiveServerSnapshot } = await import("@/sync/domains/server/serverRuntime");
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
import {
    DaemonVoiceInferenceTtsStreamStartRequestSchema, DaemonVoiceInferenceTtsStreamStartResponseSchema,
    DaemonVoiceInferenceTtsStreamNextResponseSchema, DaemonVoiceInferenceTtsStreamAckResponseSchema,
    DaemonVoiceInferenceTtsStreamCancelResponseSchema, DaemonVoiceInferenceTtsSynthesizeRequestSchema,
    DaemonVoiceInferenceTtsSynthesizeResponseSchema,
} from '@happier-dev/protocol/daemon/voiceInference';
import { SOCKET_RPC_EVENTS, SocketRpcCancellationPayloadSchema, SocketRpcRequestIdSchema } from '@happier-dev/protocol/socketRpc';
const { DaemonVoiceInferenceClient } = await import("./DaemonVoiceInferenceClient");

const { DaemonTtsController } = await import("./DaemonTtsController");


const daemonRpc = vi.fn();
type ServiceRequest = Omit<Parameters<InstanceType<typeof DaemonVoiceInferenceClient>['startSegmentedTts']>[0], 'signal'>;
type DaemonServiceResponses = Readonly<{
    synthesizeText?: (request: ServiceRequest) => Promise<unknown>;
    startSegmentedTts?: (request: ServiceRequest) => Promise<unknown>;
    malformedDaemonAudioOutput?: true;
}>;
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object') throw new Error('invalid daemon fixture');
    return value as Record<string, unknown>;
}
async function callService(stream: Record<string, unknown>, method: string, args: unknown[] = []): Promise<unknown> {
    const callback = stream[method];
    if (typeof callback !== 'function') throw new Error('daemon fixture method missing: ' + method);
    return await Reflect.apply(callback, stream, args);
}
// Responses are produced at the remote daemon RPC boundary; the actual inference
// client parses them, decodes bytes and owns stream cancellation/ACK lifecycle.
function createDaemonClientAtRpcBoundary(service: DaemonServiceResponses) {
    let stream: Record<string, unknown> | null = null;
    let audio: Record<string, unknown> | null = null;
    const segments = new Map<string, Record<string, unknown>>();
    daemonRpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
        const payload = record(request.payload);
        if (request.method.endsWith('.stream.start') || request.method.endsWith('.tts.synthesize')) {
            const parsed = request.method.endsWith('.stream.start')
                ? DaemonVoiceInferenceTtsStreamStartRequestSchema.parse(payload)
                : DaemonVoiceInferenceTtsSynthesizeRequestSchema.parse(payload);
            const input = { sessionId: null, text: parsed.text, packId: parsed.packId, voiceId: parsed.voiceId,
                speed: parsed.speed, output: parsed.output } satisfies ServiceRequest;
            if (request.method.endsWith('.stream.start')) {
                stream = record(await service.startSegmentedTts?.(input));
                return DaemonVoiceInferenceTtsStreamStartResponseSchema.parse({ ok: true, requestId: parsed.requestId,
                    streamId: stream.streamId, generation: stream.generation, segmentCount: stream.segmentCount, output: parsed.output });
            }
            audio = record(await service.synthesizeText?.(input));
            if (audio.ok === false) return DaemonVoiceInferenceTtsSynthesizeResponseSchema.parse(audio);
            const bytes = audio.bytes;
            if (!(bytes instanceof Uint8Array)) throw new Error('daemon audio fixture missing bytes');
            const response = { ok: true, requestId: parsed.requestId,
                downloadId: 'tts-download', chunkSizeBytes: Math.max(1, bytes.byteLength), sizeBytes: bytes.byteLength,
                name: 'tts.wav', output: audio.output };
            // Deliberately malformed remote wire data must reach the real strict reader.
            return service.malformedDaemonAudioOutput ? response : DaemonVoiceInferenceTtsSynthesizeResponseSchema.parse(response);
        }
        if (request.method.endsWith('.tts.chunk')) {
            if (!(audio?.bytes instanceof Uint8Array)) throw new Error('daemon download not started');
            return { success: true, contentBase64: Buffer.from(audio.bytes).toString('base64'), isLast: true };
        }
        if (request.method.endsWith('.tts.finalize')) return { success: true };
        if (!stream) throw new Error('daemon stream not started');
        if (request.method.endsWith('.stream.next')) {
            const event = record(await callService(stream, 'next'));
            let wireEvent: unknown = event;
            if (event.type === 'segment') {
                const bytes = event.bytes;
                if (!(bytes instanceof Uint8Array)) throw new Error('segment audio fixture missing');
                segments.set(String(event.segmentId), event);
                const text = typeof event.text === 'string' && event.text.length > 0
                    ? event.text : 'fixture segment';
                wireEvent = { type: 'segment', streamId: event.streamId, generation: event.generation,
                    segmentId: event.segmentId, segmentIndex: event.segmentIndex, segmentCount: event.segmentCount,
                    text, textRange: { start: 0, end: text.length }, textHash: 'fixture-segment',
                    output: event.output, audio: { contentBase64: Buffer.from(bytes).toString('base64'), sizeBytes: bytes.byteLength },
                    isLastSegment: event.isLastSegment };
            }
            return DaemonVoiceInferenceTtsStreamNextResponseSchema.parse({ ok: true,
                streamId: stream.streamId, generation: stream.generation, event: wireEvent });
        }
        if (request.method.endsWith('.stream.ack')) {
            const segment = segments.get(String(payload.segmentId));
            if (!segment) throw new Error('ACK without delivered segment');
            await callService(stream, 'ackSegment', [segment]);
            return DaemonVoiceInferenceTtsStreamAckResponseSchema.parse({ ok: true,
                streamId: stream.streamId, generation: stream.generation, ackedSegmentIndex: payload.segmentIndex,
                complete: Number(payload.segmentIndex) === Number(stream.segmentCount) - 1 });
        }
        if (request.method.endsWith('.stream.cancel')) {
            await callService(stream, 'cancel');
            return DaemonVoiceInferenceTtsStreamCancelResponseSchema.parse({ ok: true,
                streamId: stream.streamId, generation: stream.generation, cancelled: true });
        }
        throw new Error('unexpected daemon TTS method: ' + request.method);
    });
    const client = new DaemonVoiceInferenceClient();
    // The documented batch-only dependency still runs the real synthesis client.
    return service.startSegmentedTts ? client : { synthesizeText: client.synthesizeText.bind(client) };
}
const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialLists = storage.getState().machineListByServerId;
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
beforeEach(async () => {
    network.resetRequests();
    for (const boundary of rpcSocketBoundaries) {
        boundary.socket.emit.mockClear();
        boundary.socket.emitWithAck.mockClear();
    }
    network.setSocketConfigurator(boundary => rpcSocketBoundaries.push(boundary));
    await network.addHome('https://tts-capture.example.test', 'artifact-account');
    account = await createPlainArtifactHomeFixture('https://tts-capture.example.test', {
        serverFeatures: FeaturesResponseSchema.parse({ ...{ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } } }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
        handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    network.setRpcResponder(async request => await daemonRpc(request));
    const machine = createMachineFixture({ id: 'tts-machine', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
        voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
    }, voice: { ...storage.getState().settings.voice, executionMachine: {
        ...storage.getState().settings.voice.executionMachine, mode: 'fixed', machineId: machine.id,
    } } });
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
        status: 'ready', features: FeaturesResponseSchema.parse({ ...{
            features: { voice: { enabled: true }, execution: { runs: { enabled: true } } },
        }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
    } });
    daemonRpc.mockReset();
});
afterEach(async () => {
    await account?.dispose();
    storage.setState({ settings: initialSettings, machines: initialMachines, machineListByServerId: initialLists });
    resetServerFeaturesClientForTests();
});

describe('DaemonTtsController', () => {
    it('stops audio whose platform target registers after an interruption', async () => {
        const preparing = createDeferred<void>();
        const finishPreparing = createDeferred<void>();
        const playback = createVoicePlaybackController();
        let audioStarted = false;
        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: async () => ({
                bytes: new Uint8Array([1]), output: { codec: 'wav', mimeType: 'audio/wav' },
            }) }),
            // Model asynchronous platform setup before the native player registers its target.
            playAudioBytesWithStopper: async options => {
                preparing.resolve();
                await finishPreparing.promise;
                let stopped = false;
                const clear = options.registerPlaybackStopper(() => { stopped = true; });
                if (!stopped) audioStarted = true;
                clear();
            },
        });
        const speaking = controller.speak({ text: 'Hello.', packId: 'pack', voiceId: null, speed: 1,
            registerPlaybackStopper: playback.registerStopper.captureAttempt!(), onSpeaking: () => {} });
        await preparing.promise;
        playback.interrupt();
        finishPreparing.resolve();

        await speaking;
        expect(audioStarted).toBe(false);
    });
    it('preserves the real segmented client receiver through feature refusal', async () => {
        const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
        storage.getState().applySettingsLocal({ featureToggles: { 'voice.daemonInference': false } });
        const client = new DaemonVoiceInferenceClient();
        let played = false;
        const controller = new DaemonTtsController({
            client,
            // Audio playback is the platform boundary; refusal must never reach it.
            playAudioBytesWithStopper: async () => { played = true; },
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
            registerPlaybackStopper: () => () => {},
            onSpeaking: () => { throw new Error('refused_audio_must_not_speak'); },
        })).rejects.toMatchObject({ code: 'feature_disabled' });
        expect(played).toBe(false);
    });

    it('synthesizes with the daemon client and plays the returned audio bytes', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const onSpeaking = vi.fn();
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            expect(onSpeaking).not.toHaveBeenCalled();
            opts.onPlaybackStarted?.();
            expect(onSpeaking).toHaveBeenCalledTimes(1);
        });
        const registerPlaybackStopper = vi.fn((_stopper: () => void) => () => {});

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText }),
            playAudioBytesWithStopper,
        });

        await controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper,
            onSpeaking,
        });

        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(daemonRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.voiceInference.tts.synthesize',
            payload: expect.objectContaining({
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            }),
        }));
        expect(playAudioBytesWithStopper).toHaveBeenCalledWith(expect.objectContaining({
            format: 'wav',
            onPlaybackStarted: expect.any(Function),
        }));
    });

    it.each(['runtime_unavailable', 'unsupported_codec'] as const)(
        'does not enter speaking when the real daemon reports %s before audio is playable', async (errorCode) => {
        const synthesizeText = vi.fn().mockResolvedValue({ ok: false, errorCode, error: 'boom' });
        const onSpeaking = vi.fn();
        const playAudioBytesWithStopper = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText }),
            playAudioBytesWithStopper,
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toMatchObject({ code: errorCode });

        expect(onSpeaking).not.toHaveBeenCalled();
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    });

    it('does not enter speaking when batch playback fails before start', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText }),
            playAudioBytesWithStopper: vi.fn(async () => {
                throw new Error('decode failed');
            }),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toThrow('decode failed');

        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('plays the first daemon segment before the second segment is ready and acks after playback', async () => {
        const secondSegment = (() => {
            let resolve!: (value: any) => void;
            const promise = new Promise<any>((resolvePromise) => {
                resolve = resolvePromise;
            });
            return { promise, resolve };
        })();
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const next = vi.fn()
            .mockResolvedValueOnce({
                type: 'segment',
                streamId: 'tts-stream-1',
                generation: 0,
                segmentId: 'tts-stream-1:0',
                segmentIndex: 0,
                segmentCount: 2,
                bytes: new Uint8Array(Buffer.from('audio-0')),
                output: { codec: 'wav', mimeType: 'audio/wav' },
                isLastSegment: false,
            })
            .mockReturnValueOnce(secondSegment.promise);
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-1',
            generation: 0,
            segmentCount: 2,
            next,
            ackSegment,
            cancel,
        }));
        const onSpeaking = vi.fn();
        let playCalls = 0;
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            playCalls += 1;
            if (playCalls === 1) {
                expect(onSpeaking).not.toHaveBeenCalled();
            }
            opts.onPlaybackStarted?.();
        });

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            sessionId: 'session-1',
            text: 'Hello. Still synthesizing.',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        });

        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.ack');
        await network.waitForRpcRequest((request, all) => request.method === 'daemon.voiceInference.tts.stream.next' && all.filter(entry => entry.method === request.method).length === 2);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(ackSegment).toHaveBeenCalledWith(expect.objectContaining({
            segmentId: 'tts-stream-1:0',
            segmentIndex: 0,
        }));
        expect(next).toHaveBeenCalledTimes(2);

        secondSegment.resolve({
            type: 'segment',
            streamId: 'tts-stream-1',
            generation: 0,
            segmentId: 'tts-stream-1:1',
            segmentIndex: 1,
            segmentCount: 2,
            bytes: new Uint8Array(Buffer.from('audio-1')),
            output: { codec: 'wav', mimeType: 'audio/wav' },
            isLastSegment: true,
        });
        await speaking;
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(2);
        expect(onSpeaking).toHaveBeenCalledTimes(1);
        expect(ackSegment).toHaveBeenCalledWith(expect.objectContaining({
            segmentId: 'tts-stream-1:1',
            segmentIndex: 1,
        }));
        expect(cancel).not.toHaveBeenCalled();
    });

    it('keeps segmented audio residency bounded while remote confirmations remain asynchronous', async () => {
        let releaseFirstPlayback!: () => void;
        const firstPlayback = new Promise<void>((resolve) => { releaseFirstPlayback = resolve; });
        let markSecondSegmentReturned!: () => void;
        const secondSegmentReturned = new Promise<void>((resolve) => { markSecondSegmentReturned = resolve; });
        const segments = Array.from({ length: 4 }, (_, segmentIndex) => ({
            type: 'segment' as const,
            streamId: 'tts-stream-bounded',
            generation: 0,
            segmentId: `tts-stream-bounded:${segmentIndex}`,
            segmentIndex,
            segmentCount: 4,
            bytes: new Uint8Array(256).fill(segmentIndex),
            output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
            isLastSegment: segmentIndex === 3,
        }));
        const next = vi.fn(async () => {
            const segment = segments.shift()!;
            if (segment.segmentIndex === 1) {
                markSecondSegmentReturned();
            }
            return segment;
        });
        const ackSegment = vi.fn(async () => {});
        const sourceLifetime = new AbortController();
        const startSegmentedTts = vi.fn(async () => {
            return ({
            streamId: 'tts-stream-bounded',
            generation: 0,
            segmentCount: 4,
            next,
            ackSegment,
            cancel: vi.fn(async () => {}),
            });
        });
        let playbackCalls = 0;
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            playbackCalls += 1;
            opts.onPlaybackStarted?.();
            if (playbackCalls === 1) await firstPlayback;
        });
        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });
        const speaking = controller.speak({
            text: 'One. Two. Three. Four.',
            packId: 'pack-1',
            voiceId: 'voice-1',
            speed: 1,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
            signal: sourceLifetime.signal,
        });

        await secondSegmentReturned;
        expect(next).toHaveBeenCalledTimes(2);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        releaseFirstPlayback();
        await speaking;
        expect(next).toHaveBeenCalledTimes(4);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(4);
        expect(ackSegment).toHaveBeenCalledTimes(4);
        expect(getEventListeners(sourceLifetime.signal, 'abort')).toHaveLength(0);
    });

    it('stops the segmented producer when playback fails with later segments still available', async () => {
        const segments = Array.from({ length: 2 }, (_, segmentIndex) => ({
            type: 'segment' as const,
            streamId: 'tts-stream-playback-failure',
            generation: 0,
            segmentId: `tts-stream-playback-failure:${segmentIndex}`,
            segmentIndex,
            segmentCount: 4,
            bytes: new Uint8Array(256).fill(segmentIndex),
            output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
            isLastSegment: false,
        }));
        let markSecondSegmentReturned!: () => void;
        const secondSegmentReturned = new Promise<void>((resolve) => { markSecondSegmentReturned = resolve; });
        const pendingThirdNext = new Promise<never>(() => {});
        const next = vi.fn(async () => {
            const segment = segments.shift();
            if (segment) {
                if (segment.segmentIndex === 1) {
                    markSecondSegmentReturned();
                }
                return segment;
            }
            return pendingThirdNext;
        });
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-playback-failure',
            generation: 0,
            segmentCount: 4,
            next,
            ackSegment,
            cancel,
        }));
        let failFirstPlayback!: () => void;
        const firstPlaybackFailure = new Promise<void>((_resolve, reject) => {
            failFirstPlayback = () => reject(new Error('playback failed'));
        });
        const playAudioBytesWithStopper = vi.fn(async () => {
            await firstPlaybackFailure;
        });
        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });
        const speaking = controller.speak({
            text: 'One. Two. Three. Four.',
            packId: 'pack-1',
            voiceId: 'voice-1',
            speed: 1,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });
        await secondSegmentReturned;
        expect(next).toHaveBeenCalledTimes(2);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        failFirstPlayback();
        await expect(speaking).rejects.toThrow('playback failed');
        // The real client refuses a later next once playback failure retires
        // its lifetime; the old injected client reached a third call instead.
        expect(next).toHaveBeenCalledTimes(2);
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.cancel');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(ackSegment).not.toHaveBeenCalled();
    });

    it('stops active local playback when an asynchronous confirmation fails', async () => {
        const segments = Array.from({ length: 2 }, (_, segmentIndex) => ({
            type: 'segment' as const,
            streamId: 'tts-stream-confirmation-failure',
            generation: 0,
            segmentId: `tts-stream-confirmation-failure:${segmentIndex}`,
            segmentIndex,
            segmentCount: 2,
            bytes: new Uint8Array(16).fill(segmentIndex),
            output: { codec: 'wav' as const, mimeType: 'audio/wav' as const },
            isLastSegment: segmentIndex === 1,
        }));
        let rejectFirstConfirmation!: () => void;
        const firstConfirmation = new Promise<void>((_resolve, reject) => {
            rejectFirstConfirmation = () => reject(new Error('confirmation failed'));
        });
        const ackSegment = vi.fn(async () => await firstConfirmation);
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-confirmation-failure',
            generation: 0,
            segmentCount: 2,
            next: vi.fn(async () => segments.shift()!),
            ackSegment,
            cancel,
        }));
        let releaseSecondPlayback!: () => void;
        const secondPlayback = new Promise<void>((resolve) => { releaseSecondPlayback = resolve; });
        let markSecondPlaybackStarted!: () => void;
        const secondPlaybackStarted = new Promise<void>((resolve) => { markSecondPlaybackStarted = resolve; });
        const stopActivePlayback = vi.fn(() => releaseSecondPlayback());
        let playbackCalls = 0;
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            playbackCalls += 1;
            opts.onPlaybackStarted?.();
            if (playbackCalls !== 2) {
                return;
            }
            const clearStopper = opts.registerPlaybackStopper(stopActivePlayback);
            markSecondPlaybackStarted();
            try {
                await secondPlayback;
            } finally {
                clearStopper();
            }
        });
        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            text: 'One. Two.',
            packId: 'pack-1',
            voiceId: 'voice-1',
            speed: 1,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
        });
        await secondPlaybackStarted;
        rejectFirstConfirmation();
        await expect(speaking).rejects.toThrow('confirmation failed');

        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(2);
        expect(ackSegment).toHaveBeenCalledTimes(1);
        expect(stopActivePlayback).toHaveBeenCalledTimes(1);
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.cancel');
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('does not enter speaking before the first daemon segment is available', async () => {
        const firstSegment = (() => {
            let resolve!: (value: any) => void;
            const promise = new Promise<any>((resolvePromise) => {
                resolve = resolvePromise;
            });
            return { promise, resolve };
        })();
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-pending',
            generation: 0,
            segmentCount: 1,
            next: vi.fn(() => firstSegment.promise),
            ackSegment: vi.fn(async () => {}),
            cancel: vi.fn(async () => {}),
        }));
        const playAudioBytesWithStopper = vi.fn(async (opts: any) => {
            opts.onPlaybackStarted?.();
        });
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            sessionId: 'session-1',
            text: 'Still synthesizing.',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        });

        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.start');
        expect(startSegmentedTts).toHaveBeenCalledTimes(1);
        expect(onSpeaking).not.toHaveBeenCalled();

        firstSegment.resolve({
            type: 'segment',
            streamId: 'tts-stream-pending',
            generation: 0,
            segmentId: 'tts-stream-pending:0',
            segmentIndex: 0,
            segmentCount: 1,
            bytes: new Uint8Array(Buffer.from('audio-0')),
            output: { codec: 'wav', mimeType: 'audio/wav' },
            isLastSegment: true,
        });

        await speaking;
        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(onSpeaking).toHaveBeenCalledTimes(1);
    });

    it('does not enter speaking when first segmented playback fails before start', async () => {
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-play-fail',
            generation: 0,
            segmentCount: 1,
            next: vi.fn(async () => ({
                type: 'segment',
                streamId: 'tts-stream-play-fail',
                generation: 0,
                segmentId: 'tts-stream-play-fail:0',
                segmentIndex: 0,
                segmentCount: 1,
                bytes: new Uint8Array(Buffer.from('audio-0')),
                output: { codec: 'wav', mimeType: 'audio/wav' },
                isLastSegment: true,
            })),
            ackSegment,
            cancel,
        }));
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper: vi.fn(async () => {
                throw new Error('playback failed');
            }),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toThrow('playback failed');

        expect(onSpeaking).not.toHaveBeenCalled();
        expect(ackSegment).not.toHaveBeenCalled();
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.cancel');
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('aborts queued daemon TTS playback when a prefetched segment fails to play', async () => {
        const ackSegment = vi.fn(async () => {});
        const cancel = vi.fn(async () => {});
        const next = vi.fn()
            .mockResolvedValueOnce({
                type: 'segment',
                streamId: 'tts-stream-prefetch-fail',
                generation: 0,
                segmentId: 'tts-stream-prefetch-fail:0',
                segmentIndex: 0,
                segmentCount: 2,
                bytes: new Uint8Array(Buffer.from('audio-0')),
                output: { codec: 'wav', mimeType: 'audio/wav' },
                isLastSegment: false,
            })
            .mockResolvedValueOnce({
                type: 'segment',
                streamId: 'tts-stream-prefetch-fail',
                generation: 0,
                segmentId: 'tts-stream-prefetch-fail:1',
                segmentIndex: 1,
                segmentCount: 2,
                bytes: new Uint8Array(Buffer.from('audio-1')),
                output: { codec: 'wav', mimeType: 'audio/wav' },
                isLastSegment: true,
            });
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-prefetch-fail',
            generation: 0,
            segmentCount: 2,
            next,
            ackSegment,
            cancel,
        }));
        const playAudioBytesWithStopper = vi.fn(async () => {
            throw new Error('playback failed');
        });

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking: vi.fn(),
        })).rejects.toThrow('playback failed');

        expect(playAudioBytesWithStopper).toHaveBeenCalledTimes(1);
        expect(ackSegment).not.toHaveBeenCalled();
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.cancel');
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('does not enter speaking when segmented stream start fails before audio is playable', async () => {
        const startSegmentedTts = vi.fn().mockRejectedValue(Object.assign(new Error('stream start failed'), {
            code: 'runtime_unavailable',
        }));
        const onSpeaking = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper: vi.fn(),
        });

        await expect(controller.speak({
            sessionId: 'session-1',
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking,
        })).rejects.toThrow('stream start failed');

        expect(onSpeaking).not.toHaveBeenCalled();
    });

    it('cancels segmented daemon TTS and discards stale prefetched segments on abort', async () => {
        const abortController = new AbortController();
        const delayedSegment = (() => {
            let resolve!: (value: any) => void;
            const promise = new Promise<any>((resolvePromise) => {
                resolve = resolvePromise;
            });
            return { promise, resolve };
        })();
        const cancel = vi.fn(async () => {});
        const startSegmentedTts = vi.fn(async () => ({
            streamId: 'tts-stream-abort',
            generation: 0,
            segmentCount: 1,
            next: vi.fn(() => delayedSegment.promise),
            ackSegment: vi.fn(async () => {}),
            cancel,
        }));
        const playAudioBytesWithStopper = vi.fn().mockResolvedValue(undefined);

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            text: 'Abort before audio arrives.',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: null,
            speed: null,
            registerPlaybackStopper: (_stopper: () => void) => () => {},
            onSpeaking: vi.fn(),
            signal: abortController.signal,
        });
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.start');
        expect(startSegmentedTts).toHaveBeenCalledTimes(1);
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.next');
        abortController.abort();
        delayedSegment.resolve({
            type: 'segment',
            streamId: 'tts-stream-abort',
            generation: 0,
            segmentId: 'tts-stream-abort:0',
            segmentIndex: 0,
            segmentCount: 1,
            bytes: new Uint8Array(Buffer.from('stale')),
            output: { codec: 'wav', mimeType: 'audio/wav' },
            isLastSegment: true,
        });

        await speaking;
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.cancel');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    });

    it('cancels a pending native segmented-start request and rejects its late reply before playback', async () => {
        const abortController = new AbortController();
        let resolveStream!: (stream: any) => void;
        const streamStarted = new Promise<any>((resolve) => {
            resolveStream = resolve;
        });
        const cancel = vi.fn(async () => {});
        const next = vi.fn(async () => ({
            type: 'done' as const,
            streamId: 'tts-stream-late-start',
            generation: 0,
        }));
        const startSegmentedTts = vi.fn(() => streamStarted);
        const playAudioBytesWithStopper = vi.fn();
        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        const speaking = controller.speak({
            text: 'Abort before the daemon start reply arrives.',
            packId: 'pack-1',
            voiceId: null,
            speed: null,
            registerPlaybackStopper: () => () => {},
            onSpeaking: vi.fn(),
            signal: abortController.signal,
        });
        const cancelled = expect(speaking).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.tts.stream.start');
        expect(startSegmentedTts).toHaveBeenCalledTimes(1);

        abortController.abort();
        resolveStream({
            streamId: 'tts-stream-late-start',
            generation: 0,
            segmentCount: 1,
            next,
            ackSegment: vi.fn(async () => {}),
            cancel,
        });

        await cancelled;
        const startedWireRequest = rpcSocketBoundaries.flatMap(boundary => boundary.socket.emitWithAck.mock.calls)
            .find(([event, payload]) => event === SOCKET_RPC_EVENTS.CALL
                && record(payload).method === 'tts-machine:daemon.voiceInference.tts.stream.start');
        if (!startedWireRequest) throw new Error('native segmented-start request missing');
        const admittedRequestId = SocketRpcRequestIdSchema.parse(record(startedWireRequest[1]).requestId);
        const cancellations = rpcSocketBoundaries.flatMap(boundary => boundary.socket.emit.mock.calls)
            .filter(([event]) => event === SOCKET_RPC_EVENTS.CANCEL)
            .map(([, payload]) => SocketRpcCancellationPayloadSchema.parse(payload));
        expect(cancellations).toEqual([{ requestId: admittedRequestId }]);
        expect(next).not.toHaveBeenCalled();
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
        expect(getEventListeners(abortController.signal, 'abort')).toHaveLength(0);
    });

    it('does not materialize segmented synthesis when the source signal is already aborted', async () => {
        const abortController = new AbortController();
        abortController.abort();
        const startSegmentedTts = vi.fn(async () => {
            throw new Error('segmented_start_should_not_be_materialized');
        });
        const registerPlaybackStopper = vi.fn(() => () => {});
        const playAudioBytesWithStopper = vi.fn();
        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText: vi.fn(), startSegmentedTts }),
            playAudioBytesWithStopper,
        });

        await expect(controller.speak({
            text: 'Do not start this synthesizer.',
            packId: 'pack-1',
            voiceId: null,
            speed: null,
            registerPlaybackStopper,
            onSpeaking: vi.fn(),
            signal: abortController.signal,
        })).resolves.toBeUndefined();

        expect(registerPlaybackStopper).not.toHaveBeenCalled();
        expect(startSegmentedTts).not.toHaveBeenCalled();
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    });

    it('rejects an unsupported daemon wire codec through the real strict reader before playback', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'opus', mimeType: 'audio/opus' },
        });
        const playAudioBytesWithStopper = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText, malformedDaemonAudioOutput: true }),
            playAudioBytesWithStopper,
        });

        await expect(controller.speak({
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper) => () => {},
            onSpeaking: vi.fn(),
        })).rejects.toMatchObject({
            code: 'internal_error',
        });
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    });

    it('rejects a mismatched daemon wire codec and mime type through the real strict reader', async () => {
        const synthesizeText = vi.fn().mockResolvedValue({
            bytes: new Uint8Array(Buffer.from('voice-audio')),
            output: { codec: 'mp3', mimeType: 'audio/wav' },
        });
        const playAudioBytesWithStopper = vi.fn();

        const controller = new DaemonTtsController({
            client: createDaemonClientAtRpcBoundary({ synthesizeText, malformedDaemonAudioOutput: true }),
            playAudioBytesWithStopper,
        });

        await expect(controller.speak({
            text: 'hello daemon',
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: 'af_heart',
            speed: 1,
            registerPlaybackStopper: (_stopper) => () => {},
            onSpeaking: vi.fn(),
        })).rejects.toMatchObject({
            code: 'internal_error',
        });
        expect(playAudioBytesWithStopper).not.toHaveBeenCalled();
    });
});

afterAll(() => network.dispose());
