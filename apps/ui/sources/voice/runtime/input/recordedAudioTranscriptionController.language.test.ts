import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHash } from 'node:crypto';
import {
  DaemonVoiceInferenceSttUploadInitResponseSchema, DaemonVoiceInferenceSttUploadChunkResponseSchema,
  DaemonVoiceInferenceSttUploadFinalizeResponseSchema, DaemonVoiceInferenceSttTranscribeResponseSchema,
} from '@happier-dev/protocol/daemon/voiceInference';
const { createTransferRecipientKeyPair } = await import("@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption");
const { storage } = await import("@/sync/domains/state/storage");
const { getActiveServerSnapshot } = await import("@/sync/domains/server/serverRuntime");
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { createRecordedAudioTranscriptionController } = await import("./recordedAudioTranscriptionController");

const rpc = vi.fn();

// Physical OS/audio-file and daemon transport boundaries; capture policy,
// source preparation, upload, schemas, and the actual STT controller stay real.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('expo-file-system', () => ({ File: class {
  open() { return { size: 4, offset: 0, readBytes: () => new Uint8Array([1, 2, 3, 4]), close() {} }; }
} }));

const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { createMachineFixture } = await import('@/dev/testkit');
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
const initialState = storage.getState();

beforeEach(async () => {
  network.resetRequests();
  await network.addHome('https://recorded-language.example.test', 'artifact-account');
  account = await createPlainArtifactHomeFixture('https://recorded-language.example.test', {
    serverFeatures: FeaturesResponseSchema.parse({ ...{ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } } }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
    handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
  });
  const machine = createMachineFixture({ id: 'captured-machine', activeAt: Date.now() });
  storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
  network.setRpcResponder(async request => await rpc(request));
  storage.getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true } });
  primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
    status: 'ready', features: FeaturesResponseSchema.parse({ ...{ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } }, capabilities: {} }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
  } });
  const recipient = createTransferRecipientKeyPair();
  rpc.mockReset();
  rpc.mockImplementation(async (input: { method: string; payload: { requestId?: string; language?: string | null; packId?: string } }) => {
    switch (input.method) {
      case 'daemon.voiceInference.stt.upload.init': return DaemonVoiceInferenceSttUploadInitResponseSchema.parse({ success: true, uploadId: 'language-upload', chunkSizeBytes: 1024, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 });
      case 'daemon.voiceInference.stt.upload.chunk': return DaemonVoiceInferenceSttUploadChunkResponseSchema.parse({ success: true });
      case 'daemon.voiceInference.stt.upload.finalize': return DaemonVoiceInferenceSttUploadFinalizeResponseSchema.parse({ success: true, uploadId: 'language-upload', path: '/tmp/language.wav', sizeBytes: 4, sha256: createHash('sha256').update(new Uint8Array([1, 2, 3, 4])).digest('hex') });
      case 'daemon.voiceInference.stt.transcribe': return DaemonVoiceInferenceSttTranscribeResponseSchema.parse({ ok: true, requestId: input.payload.requestId, text: 'recognized', language: input.payload.language, modelPackId: input.payload.packId });
      default: throw new Error(`unexpected RPC: ${input.method}`);
    }
  });
});

afterEach(async () => {
  await account?.dispose();
  storage.setState(initialState, true);
  resetServerFeaturesClientForTests();
});

describe('recorded recognition language at the actual daemon request', () => {
  it('uses the active engine language/default and keeps Dictation independent of Reply in', async () => {
    const controller = createRecordedAudioTranscriptionController();
    const request = { uri: 'file:///language.wav', executionMachineId: 'captured-machine', settings: { voice: {
      providerId: 'local_direct', assistantLanguage: 'es', dictation: { language: 'de' },
      providers: { local_direct: { schemaVersion: 1, config: { stt: { provider: 'local_neural', localNeural: { assetId: 'active-pack', language: null, execution: 'daemon' } } } } },
    } } };
    await expect(controller.transcribe(request)).resolves.toBe('recognized');
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.voiceInference.stt.transcribe', targetId: 'captured-machine', payload: expect.objectContaining({ language: null, packId: 'active-pack' }) }));
    rpc.mockClear();
    await expect(controller.transcribe({ ...request, capturePurpose: 'dictation' })).resolves.toBe('recognized');
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.voiceInference.stt.transcribe', payload: expect.objectContaining({ language: 'de' }) }));
  });

  it.each(['machine_unreachable', 'runtime_unavailable'] as const)(
    'surfaces %s from the actual daemon transcription without changing engine or machine', async code => {
      const successfulBoundary = rpc.getMockImplementation();
      const requests: Array<{ method: string; targetId: string }> = [];
      rpc.mockImplementation(async (input: { method: string; targetId: string; payload: { requestId?: string } }) => {
        requests.push({ method: input.method, targetId: input.targetId });
        if (input.method === 'daemon.voiceInference.stt.transcribe') {
          return DaemonVoiceInferenceSttTranscribeResponseSchema.parse({ ok: false, errorCode: code, error: `daemon_voice_inference_${code}`, retryable: false });
        }
        return await successfulBoundary?.(input);
      });
      const controller = createRecordedAudioTranscriptionController();
      await expect(controller.transcribe({
        sessionId: 'session-1', uri: 'file:///language.wav', executionMachineId: 'captured-machine',
        settings: { voice: { providerId: 'local_direct', assistantLanguage: 'en', providers: {
          local_direct: { schemaVersion: 1, config: { stt: { provider: 'local_neural', localNeural: {
            assetId: 'active-pack', language: 'en', execution: 'daemon',
          } } } },
        } } },
      })).rejects.toMatchObject({ code, message: `daemon_voice_inference_${code}` });
      expect(requests.filter(request => request.method === 'daemon.voiceInference.stt.transcribe'))
        .toEqual([{ method: 'daemon.voiceInference.stt.transcribe', targetId: 'captured-machine' }]);
      expect(new Set(requests.map(request => request.targetId))).toEqual(new Set(['captured-machine']));
    },
  );
});

afterAll(() => network.dispose());
