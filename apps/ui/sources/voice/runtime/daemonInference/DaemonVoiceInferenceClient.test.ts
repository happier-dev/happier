import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';

const ensureVoiceConversationSessionForVoiceHomeMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());
const openLocalUploadSourceReaderMock = vi.hoisted(() => vi.fn());

vi.mock('@/voice/persistence/voiceConversationSession', () => ({
  ensureVoiceConversationSessionForVoiceHome: (...args: any[]) => ensureVoiceConversationSessionForVoiceHomeMock(...args),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: (...args: any[]) => readMachineTargetForSessionMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: any[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  isRuntimeFeatureEnabled: (...args: any[]) => isRuntimeFeatureEnabledMock(...args),
}));

vi.mock('@/sync/runtime/files/localUploadSourceReader', () => ({
  openLocalUploadSourceReader: (...args: any[]) => openLocalUploadSourceReaderMock(...args),
}));

describe('DaemonVoiceInferenceClient', () => {
  beforeEach(() => {
    vi.resetModules();
    ensureVoiceConversationSessionForVoiceHomeMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    machineRpcWithServerScopeMock.mockReset();
    isRuntimeFeatureEnabledMock.mockReset();
    openLocalUploadSourceReaderMock.mockReset();

    ensureVoiceConversationSessionForVoiceHomeMock.mockResolvedValue('voice-home-session');
    readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/voice-home' });
    isRuntimeFeatureEnabledMock.mockResolvedValue(true);
  });

  it('fails closed with feature_disabled before resolving machine scope when daemon inference is not enabled', async () => {
    isRuntimeFeatureEnabledMock.mockResolvedValue(false);

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).rejects.toMatchObject({
      code: 'feature_disabled',
      message: 'daemon_voice_inference_feature_disabled',
    });

    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('downloads synthesized daemon TTS bytes via the machine-scoped voice-home target', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.synthesize') {
        return {
          ok: true,
          requestId: 'tts-1',
          output: { codec: 'wav', mimeType: 'audio/wav' },
          downloadId: 'download-1',
          chunkSizeBytes: 1024,
          sizeBytes: 9,
          name: 'tts.wav',
        };
      }
      if (input.method === 'daemon.voiceInference.tts.chunk') {
        return {
          success: true,
          contentBase64: Buffer.from('voice-out').toString('base64'),
          isLast: true,
        };
      }
      if (input.method === 'daemon.voiceInference.tts.finalize') {
        return { success: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();
    const result = await client.synthesizeText({
      text: 'hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    expect(result.output).toEqual({ codec: 'wav', mimeType: 'audio/wav' });
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('voice-out');
    expect(ensureVoiceConversationSessionForVoiceHomeMock).toHaveBeenCalledTimes(1);
    expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('voice-home-session');
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.tts.synthesize',
      payload: expect.objectContaining({
        text: 'hello from daemon',
        packId: 'kokoro-tts-en-v1',
        output: { codec: 'wav', mimeType: 'audio/wav' },
      }),
    }));
  });

  it('returns daemon status snapshots with progress and degraded service state intact', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({
      ok: true,
      serviceState: 'degraded',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      models: [{
        packId: 'kokoro-tts-en-v1',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState: 'installing',
        progress: {
          phase: 'downloading',
          progress: 0.5,
          bytesDownloaded: 512,
          totalBytes: 1024,
          message: 'warming',
        },
        lastError: 'runtime_warmup_slow',
        updatedAtMs: 99,
      }],
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).resolves.toEqual({
      ok: true,
      serviceState: 'degraded',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      models: [{
        packId: 'kokoro-tts-en-v1',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState: 'installing',
        progress: {
          phase: 'downloading',
          progress: 0.5,
          bytesDownloaded: 512,
          totalBytes: 1024,
          message: 'warming',
        },
        lastError: 'runtime_warmup_slow',
        updatedAtMs: 99,
      }],
    });
  });

  it('uploads recorded audio and returns daemon STT transcription', async () => {
    const recipientKeyPair = createTransferRecipientKeyPair();
    openLocalUploadSourceReaderMock.mockResolvedValue({
      sizeBytes: 5,
      readBytes: async () => Buffer.from('hello'),
      close: async () => {},
    });
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        return {
          success: true,
          uploadId: 'upload-1',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-1',
          path: '/tmp/upload-1.wav',
          sizeBytes: 5,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-1',
          text: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();
    const result = await client.transcribeRecordedAudio({
      source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-1',
      language: 'en',
    });

    expect(result).toEqual({
      text: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.transcribe',
      payload: expect.objectContaining({
        packId: 'stt-pack-1',
        language: 'en',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
      }),
    }));
  });

  it('keeps recorded-audio STT pinned to the voice-home machine even when a session id is provided', async () => {
    readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
      if (sessionId === 'qa-session-target') {
        return { machineId: 'machine-qa', basePath: '/qa-session' };
      }
      return { machineId: 'machine-1', basePath: '/voice-home' };
    });
    openLocalUploadSourceReaderMock.mockResolvedValue({
      sizeBytes: 5,
      readBytes: async () => Buffer.from('hello'),
      close: async () => {},
    });
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        const recipientKeyPair = createTransferRecipientKeyPair();
        return {
          success: true,
          uploadId: 'upload-qa',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-qa',
          path: '/tmp/upload-qa.wav',
          sizeBytes: 5,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-qa',
          text: 'hello voice-home daemon',
          language: 'en',
          modelPackId: 'stt-pack-qa',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.transcribeRecordedAudio({
      sessionId: 'qa-session-target',
      source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-qa',
      language: 'en',
    })).resolves.toEqual({
      text: 'hello voice-home daemon',
      language: 'en',
      modelPackId: 'stt-pack-qa',
    });

    expect(ensureVoiceConversationSessionForVoiceHomeMock).toHaveBeenCalledTimes(1);
    expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('voice-home-session');
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalledWith('qa-session-target');
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.transcribe',
    }));
  });

  it('throws a machine-unreachable style error when the voice-home machine target cannot be resolved', async () => {
    readMachineTargetForSessionMock.mockReturnValue(null);

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).rejects.toMatchObject({
      message: 'daemon_voice_inference_machine_unreachable',
      code: 'machine_unreachable',
    });
  });

  it('lists, installs, removes, and refreshes daemon model status through the machine-scoped RPC namespace', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.models.list') {
        return {
          ok: true,
          models: [
            {
              packId: 'kokoro-tts-en-v1',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '2026-04-17',
              executionSupport: ['daemon'],
              installState: 'not_installed',
              progress: null,
              lastError: null,
              updatedAtMs: 1,
            },
          ],
        };
      }
      if (input.method === 'daemon.voiceInference.models.status') {
        return {
          ok: true,
          models: [
            {
              packId: 'kokoro-tts-en-v1',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '2026-04-17',
              executionSupport: ['daemon'],
              installState: 'installing',
              progress: { phase: 'downloading', progress: 0.5, bytesDownloaded: 5, totalBytes: 10, message: null },
              lastError: null,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (input.method === 'daemon.voiceInference.models.install') {
        return {
          ok: true,
          model: {
            packId: 'kokoro-tts-en-v1',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '2026-04-17',
            executionSupport: ['daemon'],
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 3,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.models.remove') {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        packId: 'kokoro-tts-en-v1',
        installState: 'not_installed',
      }),
    ]);
    await expect(client.getModelsStatus(['kokoro-tts-en-v1'])).resolves.toEqual([
      expect.objectContaining({
        packId: 'kokoro-tts-en-v1',
        installState: 'installing',
      }),
    ]);
    await expect(client.installModel({ packId: 'kokoro-tts-en-v1' })).resolves.toMatchObject({
      packId: 'kokoro-tts-en-v1',
      installState: 'installed',
    });
    await expect(client.removeModel('kokoro-tts-en-v1')).resolves.toBeUndefined();
  });
});
