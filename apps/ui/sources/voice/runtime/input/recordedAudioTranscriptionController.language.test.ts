import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRecordedAudioTranscriptionController } from './recordedAudioTranscriptionController';

const rpc = vi.hoisted(() => vi.fn());

// Physical OS/audio-file and daemon transport boundaries; capture policy,
// source preparation, upload, schemas, and the actual STT controller stay real.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('expo-file-system', () => ({ File: class {
  open() { return { size: 4, offset: 0, readBytes: () => new Uint8Array([1, 2, 3, 4]), close() {} }; }
} }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: rpc,
}));

const initialState = storage.getState();

beforeEach(() => {
  storage.getState().applySettingsLocal({ experiments: true, featureToggles: { voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true } });
  primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
    status: 'ready', features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } }, capabilities: {} }),
  } });
  const recipient = createTransferRecipientKeyPair();
  rpc.mockReset();
  rpc.mockImplementation(async (input: { method: string; payload: { requestId?: string; language?: string | null; packId?: string } }) => {
    switch (input.method) {
      case 'daemon.voiceInference.stt.upload.init': return { success: true, uploadId: 'language-upload', chunkSizeBytes: 1024, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
      case 'daemon.voiceInference.stt.upload.chunk': return { success: true };
      case 'daemon.voiceInference.stt.upload.finalize': return { success: true, uploadId: 'language-upload', path: '/tmp/language.wav', sizeBytes: 4, sha256: 'abc' };
      case 'daemon.voiceInference.stt.transcribe': return { ok: true, requestId: input.payload.requestId, text: 'recognized', language: input.payload.language, modelPackId: input.payload.packId };
      default: throw new Error(`unexpected RPC: ${input.method}`);
    }
  });
});

afterEach(() => {
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
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.voiceInference.stt.transcribe', machineId: 'captured-machine', payload: expect.objectContaining({ language: null, packId: 'active-pack' }) }));
    rpc.mockClear();
    await expect(controller.transcribe({ ...request, capturePurpose: 'dictation' })).resolves.toBe('recognized');
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.voiceInference.stt.transcribe', payload: expect.objectContaining({ language: 'de' }) }));
  });
});
