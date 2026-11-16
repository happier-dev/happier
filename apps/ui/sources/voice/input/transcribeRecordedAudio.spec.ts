import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createMachineFixture, createPlainMachineRowFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import { DaemonVoiceInferenceSttTranscribeResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { DaemonVoiceSpeechTranscribeResponseSchema, DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema } from '@happier-dev/protocol/daemon/voiceSpeech';
import { createHash } from 'node:crypto';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';

const ORIGINAL_PLATFORM_OS = Platform.OS;
const ORIGINAL_PLATFORM_SELECT = Platform.select;

class FakeAudioBuffer {
  numberOfChannels = 1;
  sampleRate = 16_000;
  private readonly channelData = new Float32Array([0, 0.25, -0.25, 0]);

  getChannelData(_channel: number) {
    return this.channelData;
  }
}

let filesystem = createExpoFileSystemFileMock();
const openedNativeUris: string[] = [];
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(uri: string) { openedNativeUris.push(uri); return new filesystem.module.File(uri); }
  },
  readAsStringAsync: () => {
    throw new Error('deprecated_readAsStringAsync_called');
  },
}));

vi.mock('expo-audio', () => ({
  RecordingPresets: {
    HIGH_QUALITY: {
      extension: '.m4a',
    },
  },
}));

afterEach(async () => {
  // Roll back through the same physical store in which this case was admitted.
  await account?.dispose();
  openAiCompatTranscribeSpy.mockClear();
  googleGeminiTranscribeSpy.mockClear();
  resetRuntimeFetch();
  (Platform as any).OS = ORIGINAL_PLATFORM_OS;
  (Platform as any).select = ORIGINAL_PLATFORM_SELECT;
});

const daemonSttControllerTranscribeSpy = vi.fn();
const openAiCompatTranscribeSpy = vi.fn(async (_params: unknown) => 'hello openai compat');
const googleGeminiTranscribeSpy = vi.fn(async (_params: unknown) => 'hello gemini');
// Only framed daemon replies are substituted. Both STT clients, policy,
// selected-machine authority and encrypted upload remain real.
let selectedSpeechPlugin = '';
let uploadedSize = 0;
let uploadedChunks: Uint8Array[] = [];
const rpcRequests = installSessionActionRpcBoundary(async request => {
  const method = request.method.slice(request.method.indexOf(':') + 1);
  const payload = request.params as Record<string, unknown>;
  if (method.endsWith('upload.init')) {
    uploadedSize = Number(payload.sizeBytes);
    uploadedChunks = [];
    selectedSpeechPlugin = typeof payload.target === 'object' && payload.target !== null && 'pluginId' in payload.target
      ? String(payload.target.pluginId) : '';
    return { success: true, uploadId: 'recorded-upload', chunkSizeBytes: 65536,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
  }
  if (method.endsWith('upload.chunk')) {
    uploadedChunks.push(await decryptEncryptedTransferChunkEnvelope({ transferId: 'recorded-upload', sequence: Number(payload.index),
      payloadBase64: String(payload.payloadBase64), encryptedDataKeyEnvelopeBase64: String(payload.encryptedDataKeyEnvelopeBase64),
      recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
    return { success: true };
  }
  if (method.endsWith('upload.abort')) return { success: true };
  if (method.endsWith('upload.finalize')) {
    const hash = createHash('sha256');
    for (const bytes of uploadedChunks) hash.update(bytes);
    const finalized = { success: true, uploadId: 'recorded-upload', sizeBytes: uploadedSize, sha256: hash.digest('hex') };
    return selectedSpeechPlugin ? DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema.parse(finalized)
      : { ...finalized, path: '/tmp/recorded-audio' };
  }
  if (method === 'daemon.voice.speech.transcribe') return DaemonVoiceSpeechTranscribeResponseSchema.parse({
    ok: true, requestId: payload.requestId,
    text: await (selectedSpeechPlugin === 'happier.voice.openai-compat' ? openAiCompatTranscribeSpy : googleGeminiTranscribeSpy)(payload),
  });
  if (method === 'daemon.voiceInference.stt.transcribe') return DaemonVoiceInferenceSttTranscribeResponseSchema.parse({
    ok: true, requestId: payload.requestId, ...await daemonSttControllerTranscribeSpy(payload),
  });
  throw new Error(`Unexpected recorded-audio RPC: ${method}`);
});
const recipient = createTransferRecipientKeyPair();
const { storage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { recordedAudioTranscriptionController } = await import('@/voice/runtime/input/recordedAudioTranscriptionController');
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
const machineId = 'machine-ready-at-start';
const features = createRootLayoutFeaturesResponse({ features: {
  voice: { enabled: true }, machines: { enabled: true, liveStream: { ...createRootLayoutFeaturesResponse().features.machines.liveStream, enabled: true, serverRouted: { enabled: true } } },
} });
// An authored external deployment vector, validated by its wire schema.
features.capabilities.machines.liveStream.serverRouted = { disabledReason: null,
  caps: MachineLiveStreamRelayCapsV1Schema.parse({ maxBitrateBps: 64000, maxFramesPerSecond: 50,
    maxFrameBytes: 16000, maxDurationMs: 60000, maxTotalBytes: 1000000,
    maxConcurrentStreamsPerAccount: 2, maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1 }) };
async function answerHome(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(url)).pathname;
  if (path === '/health') return Response.json({ status: 'ok' });
  if (path === '/v1/account/encryption') return Response.json(AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 0 }));
  if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
  if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
  const row = createPlainMachineRowFixture({ id: machineId, accountId: 'artifact-account' });
  if (path === '/v1/machines') return Response.json([row]);
  if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
    id => id === machineId ? row : null);
  if (path === '/v1/machines/' + machineId) return Response.json({ machine: row });
  if (path === '/v1/machines/' + machineId + '/access') return Response.json({ machineId,
    custodian: row.access!.custodian, access: row.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
  return new Response('{}', { status: 404 });
}
function installRecordingFetch(fetchRecording: (input: string, init?: RequestInit) => Promise<Response>) {
  setRuntimeFetch((url, init) => String(url).startsWith('blob:') ? fetchRecording(String(url), init) : answerHome(url, init));
}
beforeEach(async ({ task }) => {
  // Platform is a fixture input: admit credentials in its real SDK store before
  // a web case runs, rather than changing stores after a native admission.
  const webCase = /\bweb\b|Chrome WebM/i.test(task.name);
  (Platform as unknown as { OS: string }).OS = webCase ? 'web' : ORIGINAL_PLATFORM_OS;
  (Platform as unknown as { select: (spec: Record<string, unknown>) => unknown }).select = webCase
    ? spec => spec.web ?? spec.default
    : ORIGINAL_PLATFORM_SELECT;
  filesystem = createExpoFileSystemFileMock();
  for (const uri of ['file:///rec.m4a', 'file:///rec.wav']) filesystem.files.set(uri, [1, 2, 3, 4]);
  openedNativeUris.length = 0;
  rpcRequests.length = 0;
  account = await createPlainArtifactHomeFixture('https://recorded-capture.test', { serverFeatures: features,
    handleRequest: (path, init) => answerHome(`https://recorded-capture.test${path}`, init) });
  primeServerFeaturesSnapshot({ serverId: account.home.id, snapshot: { status: 'ready', features } });
  const machine = createMachineFixture({ id: machineId, active: true, activeAt: Date.now() });
  publishMachineActivityForTest([machine]);
  storage.setState({ machines: { [machineId]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
  storage.getState().applySettingsLocal({ experiments: true,
    featureToggles: { ...storage.getState().settings.featureToggles, voice: true, 'voice.agent': true,
      'execution.runs': true, 'voice.daemonInference': true },
    voice: { ...storage.getState().settings.voice, executionMachine: { mode: 'fixed', machineId } } });
});

describe('recordedAudioTranscriptionController', () => {
  it('routes qualified OpenAI-compatible recorded audio through the generic selected-daemon speech client', async () => {
    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'happier.voice.openai-compat/stt',
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            } },
            'happier.voice.openai-compat/stt': {
              schemaVersion: 2,
              config: {
                baseUrl: 'https://openai-compat.example/api',
                insecureLocalOriginConsent: '',
                insecureLocalConsentMachineId: '',
                model: 'whisper-1',
                language: 'en',
              },
            },
          },
        },
      },
    });

    expect(text).toBe('hello openai compat');
    expect(openAiCompatTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: { pluginId: 'happier.voice.openai-compat', localId: 'stt' },
    }));
    expect(openedNativeUris).toContain('file:///rec.m4a');
    expect(openAiCompatTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('baseUrl');
    expect(openAiCompatTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
    expect(openAiCompatTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(openAiCompatTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('language');
  });

  it('routes canonical qualified Google STT settings through the selected-daemon credential client without a synced key', async () => {
    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'happier.voice.google/gemini-stt',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
              },
              networkTimeoutMs: 15000,
            } },
            'happier.voice.google/gemini-stt': {
              schemaVersion: 2,
              config: { model: 'gemini-2.5-flash', language: 'en' },
            },
          },
        },
      },
    });

    expect(googleGeminiTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
      mimeType: 'audio/mp4',
    }));
    expect(openedNativeUris).toContain('file:///rec.m4a');
    expect(googleGeminiTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
    expect(googleGeminiTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('model');
    expect(googleGeminiTranscribeSpy.mock.calls[0]?.[0]).not.toHaveProperty('language');
    expect(text).toBe('hello gemini');
  });

  it('normalizes the released secret-bearing Google adapter shape without disclosing the secret', async () => {
    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          adapters: {
            local_direct: {
              stt: {
                provider: 'google_gemini',
                googleGemini: {
                  apiKey: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'legacy-google-secret-ciphertext' },
                  },
                  model: 'gemini-2.5-flash',
                  language: 'en',
                },
              },
            },
          },
        },
      },
    });

    expect(text).toBe('hello gemini');
    expect(googleGeminiTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(googleGeminiTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      target: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
    }));
    expect(openedNativeUris).toContain('file:///rec.m4a');
    const dispatch = googleGeminiTranscribeSpy.mock.calls[0]?.[0];
    expect(dispatch).not.toHaveProperty('apiKey');
    expect(dispatch).not.toHaveProperty('model');
    expect(dispatch).not.toHaveProperty('language');
    expect(JSON.stringify(dispatch)).not.toContain('legacy-google-secret-ciphertext');
  });

  it('trims the voice provider id before selecting the local adapter', async () => {
    googleGeminiTranscribeSpy.mockResolvedValueOnce('hello trimmed provider');

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          providers: {
            'happier.voice.google/gemini-stt': {
              schemaVersion: 2,
              config: { model: 'gemini-2.5-flash', language: 'en' },
            },
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'happier.voice.google/gemini-stt',
              },
              networkTimeoutMs: 15000,
            } },
            local_conversation: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                providers: {},
                localNeural: { assetId: 'dummy', language: 'en' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(googleGeminiTranscribeSpy).toHaveBeenCalledTimes(1);
    expect(text).toBe('hello trimmed provider');
  });

  it('treats local_neural STT as non-file-based on web and returns null', async () => {
    const fetchSpy = vi.fn();
    setRuntimeFetch(fetchSpy as any);

    const text = await recordedAudioTranscriptionController.transcribe({
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'device' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(text).toBeNull();
  });

  it('routes local_neural daemon execution to the daemon STT controller', async () => {
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon stt',
      language: 'en',
      modelPackId: 'dummy',
    });

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'file:///rec.wav',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon stt');
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      packId: 'dummy',
      language: 'en',
    }));
    expect(openedNativeUris).toContain('file:///rec.wav');
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: 'machine-ready-at-start:daemon.voiceInference.stt.upload.init',
      params: expect.objectContaining({ inputMimeType: 'audio/wav', sizeBytes: 4 }) }));
  });

  it('routes blob recordings through a web file source for daemon local_neural STT', async () => {
    (Platform as any).OS = 'web';
    (Platform as any).select = (spec: Record<string, unknown>) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'blob:voice-recording') {
        return {
          blob: async () => new Blob(['webm-bytes'], { type: 'audio/webm' }),
        };
      }
      return await (globalThis.fetch as any)(input, init);
    });
    installRecordingFetch(runtimeFetchSpy as unknown as Parameters<typeof installRecordingFetch>[0]);
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon web',
      language: 'en',
      modelPackId: 'dummy',
    });

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon web');
    expect(runtimeFetchSpy).toHaveBeenCalledWith('blob:voice-recording', undefined);
    const call = daemonSttControllerTranscribeSpy.mock.calls.at(-1)?.[0];
    expect(call).toEqual(expect.objectContaining({
      packId: 'dummy',
      language: 'en',
    }));
    expect(openedNativeUris).toEqual([]);
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: 'machine-ready-at-start:daemon.voiceInference.stt.upload.init',
      params: expect.objectContaining({ inputMimeType: 'audio/webm', sizeBytes: new Blob(['webm-bytes']).size }) }));
  });

  it('reuses the admitted web recording blob instead of reading its object URL again before daemon upload', async () => {
    (Platform as unknown as { OS: string }).OS = 'web';
    (Platform as unknown as {
      select: (spec: Record<string, unknown>) => unknown;
    }).select = (spec) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async () => {
      throw new Error('recording_blob_refetched');
    });
    installRecordingFetch(runtimeFetchSpy);
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello admitted daemon web',
      language: 'en',
      modelPackId: 'dummy',
    });
    const webBlob = new Blob(['already-admitted-webm-bytes'], { type: 'audio/webm' });
    (globalThis as unknown as {
      AudioContext?: new () => unknown;
    }).AudioContext = class {
      constructor() {
        throw new Error('web_audio_context_unavailable');
      }
    };

    const request: Parameters<typeof recordedAudioTranscriptionController.transcribe>[0] & Readonly<{
      webBlob: Blob;
    }> = {
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      webBlob,
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    };

    await expect(recordedAudioTranscriptionController.transcribe(request)).resolves.toBe(
      'hello admitted daemon web',
    );
    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'dummy',
    }));
    expect(openedNativeUris).toEqual([]);
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: 'machine-ready-at-start:daemon.voiceInference.stt.upload.init',
      params: expect.objectContaining({ inputMimeType: 'audio/webm', sizeBytes: webBlob.size }) }));
    (globalThis as unknown as {
      AudioContext?: unknown;
    }).AudioContext = undefined;
  });

  it('falls back to daemon decode for an admitted Chrome WebM recording that Web Audio cannot decode', async () => {
    (Platform as unknown as { OS: string }).OS = 'web';
    (Platform as unknown as {
      select: (spec: Record<string, unknown>) => unknown;
    }).select = (spec) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async () => {
      throw new Error('recording_blob_refetched');
    });
    installRecordingFetch(runtimeFetchSpy);
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'open the project settings',
      language: 'en',
      modelPackId: 'dummy',
    });
    const webBlob = new Blob(
      [new Uint8Array(1_080)],
      { type: 'audio/webm;codecs=opus' },
    );
    const close = vi.fn(async () => {});
    (globalThis as unknown as {
      AudioContext?: new () => unknown;
    }).AudioContext = class {
      decodeAudioData = vi.fn(async () => {
        throw new DOMException('Unable to decode audio data', 'EncodingError');
      });
      close = close;
    };

    const request: Parameters<typeof recordedAudioTranscriptionController.transcribe>[0] = {
      sessionId: 'session-1',
      uri: 'blob:chrome-recording',
      webBlob,
      executionMachineId: 'machine-ready-at-start',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    };

    await expect(recordedAudioTranscriptionController.transcribe(request)).resolves.toBe(
      'open the project settings',
    );
    expect(runtimeFetchSpy).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      normalization: expect.objectContaining({ strategy: 'daemon_decode' }),
    }));
    expect(rpcRequests.every(request => request.method.startsWith('machine-ready-at-start:'))).toBe(true);
    expect(openedNativeUris).toEqual([]);
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: 'machine-ready-at-start:daemon.voiceInference.stt.upload.init',
      params: expect.objectContaining({ inputMimeType: 'audio/webm;codecs=opus', sizeBytes: 1_080 }) }));
    (globalThis as unknown as {
      AudioContext?: unknown;
    }).AudioContext = undefined;
  });

  it('pretranscodes web recordings to wav before daemon local_neural STT when browser decode is available', async () => {
    (Platform as any).OS = 'web';
    (Platform as any).select = (spec: Record<string, unknown>) => spec.web ?? spec.default;
    const runtimeFetchSpy = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === 'blob:voice-recording') {
        return {
          blob: async () => new Blob(['webm-bytes'], { type: 'audio/webm' }),
        };
      }
      return await (globalThis.fetch as any)(input, init);
    });
    installRecordingFetch(runtimeFetchSpy as unknown as Parameters<typeof installRecordingFetch>[0]);
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon web wav',
      language: 'en',
      modelPackId: 'dummy',
    });
    const decodeAudioData = vi.fn(async () => new FakeAudioBuffer());
    (globalThis as any).AudioContext = class {
      decodeAudioData = decodeAudioData;
    };

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'blob:voice-recording',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon web wav');
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    const call = daemonSttControllerTranscribeSpy.mock.calls.at(-1)?.[0];
    expect(call).toEqual(expect.objectContaining({
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
      packId: 'dummy',
      language: 'en',
    }));
    expect(openedNativeUris).toEqual([]);
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: 'machine-ready-at-start:daemon.voiceInference.stt.upload.init',
      params: expect.objectContaining({ inputMimeType: 'audio/wav', sizeBytes: 44 + 4 * 2 }) }));
    (globalThis as any).AudioContext = undefined;
  });

  it('guesses audio/mp4 for native m4a recordings when routing daemon local_neural STT', async () => {
    daemonSttControllerTranscribeSpy.mockResolvedValue({
      text: 'hello daemon m4a',
      language: 'en',
      modelPackId: 'dummy',
    });

    const text = await recordedAudioTranscriptionController.transcribe({
      sessionId: 'session-1',
      uri: 'file:///rec.m4a',
      settings: {
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          providers: {
            local_direct: { schemaVersion: 1, config: {
              stt: {
                provider: 'local_neural',
                openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      },
    });

    expect(text).toBe('hello daemon m4a');
    expect(daemonSttControllerTranscribeSpy).toHaveBeenCalledWith(expect.objectContaining({
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    }));
    expect(openedNativeUris).toContain('file:///rec.m4a');
    expect(rpcRequests).toContainEqual(expect.objectContaining({ method: 'machine-ready-at-start:daemon.voiceInference.stt.upload.init',
      params: expect.objectContaining({ inputMimeType: 'audio/mp4' }) }));
  });

  it('preserves daemon local_neural STT unavailability details instead of flattening them to null', async () => {
    daemonSttControllerTranscribeSpy.mockRejectedValueOnce(
      Object.assign(new Error('daemon_voice_inference_runtime_unavailable'), {
        code: 'runtime_unavailable',
      }),
    );

    await expect(
      recordedAudioTranscriptionController.transcribe({
        sessionId: 'session-1',
        uri: 'file:///rec.wav',
        settings: {
          voice: {
            providerId: 'local_direct',
            assistantLanguage: 'en',
            providers: {
              local_direct: { schemaVersion: 1, config: {
                stt: {
                  provider: 'local_neural',
                  openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                  googleGemini: { apiKey: null, model: 'gemini-2.5-flash', language: null },
                  localNeural: { assetId: 'dummy', language: 'en', execution: 'daemon' },
                },
                networkTimeoutMs: 15000,
              } },
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'runtime_unavailable',
      message: 'daemon_voice_inference_runtime_unavailable',
    });
  });
});
