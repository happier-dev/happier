import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PluginVoiceSpeechRuntimeRegistration } from '@happier-dev/plugin-sdk/runtime';
import {
  GoogleCloudSynthesizeRequestSchema,
  GoogleCloudSynthesizeResponseSchema,
  GoogleGeminiTranscribeRequestSchema,
  GoogleGeminiTranscribeResponseSchema,
  GOOGLE_VOICE_TRANSFER_CHUNK_MAX_BYTES,
} from '@happier-dev/plugins-google/protocol/voice';
import { configuration } from '@/configuration';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
} from '@/machines/transfer/transferChunkEncryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

const runtimeLeaseMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  activateContributionsOnDemand: vi.fn(async () => []),
  release: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: runtimeLeaseMocks.acquire,
}));

import { registerMachineVoiceSpeechRpcHandlers } from './rpcHandlers.voiceSpeech';

const GOOGLE_SPEECH_TARGET = Object.freeze({
  pluginId: 'happier.voice.google',
  localId: 'speech',
});
const GOOGLE_STT_CONTEXT = Object.freeze({
  target: GOOGLE_SPEECH_TARGET,
  providerId: 'google_gemini',
});
const GOOGLE_TTS_CONTEXT = Object.freeze({
  target: GOOGLE_SPEECH_TARGET,
  providerId: 'google_cloud',
});

function speechRuntime(overrides?: Partial<PluginVoiceSpeechRuntimeRegistration>): PluginVoiceSpeechRuntimeRegistration {
  return {
    catalogProviders: [],
    operations: { transcribe: vi.fn(), synthesize: vi.fn() },
    speechProviderIds: { transcribe: 'google_gemini', synthesize: 'google_cloud' },
    schemas: {
      transcribeRequest: GoogleGeminiTranscribeRequestSchema,
      transcribeResponse: GoogleGeminiTranscribeResponseSchema,
      synthesizeRequest: GoogleCloudSynthesizeRequestSchema,
      synthesizeResponse: GoogleCloudSynthesizeResponseSchema,
    },
    ...overrides,
  };
}

function resolveRuntime(runtime: PluginVoiceSpeechRuntimeRegistration) {
  return vi.fn(async () => ({ runtime, release: vi.fn(async () => undefined) }));
}

function createRealRpcHandlerManager(): RpcHandlerManager {
  return new RpcHandlerManager({
    scopePrefix: 'machine-test',
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'dataKey',
    encryptionMode: 'plain',
    logger: () => undefined,
  });
}

function abortError(): Error {
  return Object.assign(new Error('speech operation aborted'), { name: 'AbortError' });
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(abortError());
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

async function findUploadPaths(uploadId: string): Promise<readonly string[]> {
  const root = join(tmpdir(), 'happier', 'file-transfers');
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, `${uploadId}.upload`));
  const existing = await Promise.all(candidates.map(async (path) => (
    await stat(path).then(() => true, () => false) ? path : null
  )));
  return existing.filter((path): path is string => path !== null);
}

describe('public speech machine RPC registration', () => {
  it('activates the exact speech contribution before reading its generation-bound runtime', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const runtime = speechRuntime({
      catalogProviders: [{
        providerId: 'google_gemini',
        catalogOperations: { fetchCatalog: vi.fn(async () => []) },
      }],
    });
    runtimeLeaseMocks.acquire.mockResolvedValueOnce({
      registry: {
        activateContributionsOnDemand: runtimeLeaseMocks.activateContributionsOnDemand,
        voiceSpeechProviders: {
          read: vi.fn(() => ({ runtime, isCurrent: () => true })),
        },
      },
      release: runtimeLeaseMocks.release,
    });
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
      } as never,
      credentialResolver: { withSecret: vi.fn() } as never,
    });

    await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target: GOOGLE_SPEECH_TARGET,
      providerId: 'google_gemini',
      catalog: 'models',
    });

    expect(runtimeLeaseMocks.activateContributionsOnDemand).toHaveBeenCalledWith([{
      pluginId: 'happier.voice.google',
      family: 'voiceProviders.speech',
      localId: 'speech',
    }]);
    await registration.dispose();
  });

  it('registers only resolver-backed catalog and fixed binary-transfer speech operations', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
      } as never,
      credentialResolver: { withSecret: vi.fn() } as never,
      resolveSpeechRuntime: resolveRuntime(speechRuntime()),
    });

    expect([...handlers.keys()].sort()).toEqual([
      'daemon.voice.speech.catalog',
      'daemon.voice.speech.download.abort',
      'daemon.voice.speech.download.chunk',
      'daemon.voice.speech.download.finalize',
      'daemon.voice.speech.synthesize',
      'daemon.voice.speech.transcribe',
      'daemon.voice.speech.transcribe.upload.abort',
      'daemon.voice.speech.transcribe.upload.chunk',
      'daemon.voice.speech.transcribe.upload.finalize',
      'daemon.voice.speech.transcribe.upload.init',
    ].sort());
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({ input: 'missing fields' }))
      .resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
    await registration.dispose();
  });

  it('resolves catalog credentials inside the daemon and returns only bounded catalog rows', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const fetchCatalog = vi.fn(async ({ credential, catalog }: Parameters<PluginVoiceSpeechRuntimeRegistration['catalogProviders'][number]['catalogOperations']['fetchCatalog']>[0]) => {
      expect(catalog).toBe('models');
      return await credential(async (secret) => {
        expect(secret).toBe('daemon-materialized-secret');
        return [{ id: 'gemini-test', name: 'Gemini Test', metadata: { family: 'gemini' } }];
      });
    });
    const withSecret = vi.fn(async ({ providerId, credentialSlotId, use }: {
      providerId: string;
      credentialSlotId: string;
      use: (secret: string) => Promise<unknown>;
    }) => {
      expect(providerId).toBe('google_gemini');
      expect(credentialSlotId).toBe('api_key');
      return await use('daemon-materialized-secret');
    });
    const resolveSpeechRuntime = resolveRuntime(speechRuntime({
      catalogProviders: [{ providerId: 'google_gemini', catalogOperations: { fetchCatalog } }],
    }));
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
      } as never,
      credentialResolver: { withSecret } as never,
      resolveSpeechRuntime,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target: { pluginId: 'happier.voice.google', localId: 'speech' },
      providerId: 'google_gemini',
      catalog: 'models',
    })).resolves.toEqual({
      ok: true,
      items: [{ id: 'gemini-test', name: 'Gemini Test', metadata: { family: 'gemini' } }],
    });
    expect(withSecret).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(resolveSpeechRuntime).toHaveBeenCalledWith({
      pluginId: 'happier.voice.google',
      localId: 'speech',
    });
    await registration.dispose();
  });

  it('fails closed when the public speech contribution is unavailable after retirement', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
      } as never,
      credentialResolver: { withSecret: vi.fn() } as never,
      resolveSpeechRuntime: vi.fn(async () => {
        throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG)?.({
      target: GOOGLE_SPEECH_TARGET,
      providerId: 'google_gemini',
      catalog: 'models',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'provider_unavailable',
      retryable: false,
    });
    await registration.dispose();
  });

  it('never advertises chunks larger than the encrypted voice RPC envelope can encode', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<any>>();
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
      } as never,
      credentialResolver: { withSecret: vi.fn() } as never,
      resolveSpeechRuntime: resolveRuntime(speechRuntime()),
    });

    const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT)?.({
      ...GOOGLE_STT_CONTEXT,
      sizeBytes: 1,
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
    });
    expect(init.success).toBe(true);
    expect(init.chunkSizeBytes).toBeLessThanOrEqual(GOOGLE_VOICE_TRANSFER_CHUNK_MAX_BYTES);
    await registration.dispose();
  });

  it('keeps encrypted transfer ownership in the host while passing bytes, signal, and credential access to the leaf', async () => {
    const handlers = new Map<string, (raw: unknown) => Promise<any>>();
    const withSecret = vi.fn(async ({ use }: { use: (secret: string) => Promise<unknown> }) => await use('daemon-secret'));
    const transcribe = vi.fn(async ({ credential, request, signal }: Parameters<PluginVoiceSpeechRuntimeRegistration['operations']['transcribe']>[0]) => {
      expect(request.bytes).toBeInstanceOf(Uint8Array);
      expect([...request.bytes]).toEqual([1, 2, 3]);
      expect(signal.aborted).toBe(false);
      return await credential(async (secret) => ({ requestId: request.requestId, text: `${secret}:${request.bytes.byteLength}` }));
    });
    const release = vi.fn(async () => undefined);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
      } as never,
      credentialResolver: { withSecret } as never,
      resolveSpeechRuntime: vi.fn(async () => ({
        runtime: speechRuntime({ operations: { transcribe, synthesize: vi.fn() } }),
        release,
      })),
    });
    const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT)?.({
      ...GOOGLE_STT_CONTEXT,
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'recording.wav',
    });
    const encrypted = createEncryptedTransferChunkEnvelope({
      transferId: init.uploadId,
      sequence: 0,
      payload: Buffer.from([1, 2, 3]),
      recipientPublicKeyBase64: init.recipientPublicKeyBase64,
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK)?.({
      uploadId: init.uploadId,
      index: 0,
      ...encrypted,
    })).resolves.toMatchObject({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE)?.({
      uploadId: init.uploadId,
    })).resolves.toMatchObject({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
      ...GOOGLE_STT_CONTEXT,
      target: { pluginId: 'happier.voice.google', localId: 'other-speech' },
      requestId: 'wrong-target',
      model: 'gemini-2.5-flash',
      language: null,
      mimeType: 'audio/wav',
      uploadId: init.uploadId,
    })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
    expect(withSecret).not.toHaveBeenCalled();
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
      ...GOOGLE_STT_CONTEXT,
      requestId: 'r1',
      model: 'gemini-2.5-flash',
      language: null,
      mimeType: 'audio/wav',
      uploadId: init.uploadId,
    })).resolves.toEqual({ ok: true, requestId: 'r1', text: 'daemon-secret:3' });
    expect(withSecret).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(2);
    await registration.dispose();
  });

  it('expires finalized transcription uploads before vendor credentials can consume stale audio', async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (raw: unknown) => Promise<any>>();
      const withSecret = vi.fn(async ({ use }: { use: (secret: string) => Promise<unknown> }) => await use('secret'));
      const registration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager: {
          registerHandler(method: string, handler: (raw: unknown) => Promise<unknown>) { handlers.set(method, handler); },
        } as never,
        credentialResolver: { withSecret } as never,
        resolveSpeechRuntime: resolveRuntime(speechRuntime({
          operations: {
            transcribe: vi.fn(async () => ({ requestId: 'r', text: 'stale' })),
            synthesize: vi.fn(),
          },
        })),
      });
      const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT)?.({
        ...GOOGLE_STT_CONTEXT,
        sizeBytes: 3, mimeType: 'audio/wav', fileName: 'recording.wav',
      });
      expect(init.success).toBe(true);
      const encrypted = createEncryptedTransferChunkEnvelope({
        transferId: init.uploadId,
        sequence: 0,
        payload: Buffer.from([1, 2, 3]),
        recipientPublicKeyBase64: init.recipientPublicKeyBase64,
      });
      await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK)?.({
        uploadId: init.uploadId, index: 0, ...encrypted,
      });
      const finalized = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE)?.({ uploadId: init.uploadId });
      expect(finalized.success).toBe(true);

      await vi.advanceTimersByTimeAsync(Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs || 60_000)) + 1);
      await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE)?.({
        ...GOOGLE_STT_CONTEXT,
        requestId: 'r', model: 'gemini-2.5-flash', language: null, mimeType: 'audio/wav', uploadId: init.uploadId,
      })).resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
      expect(withSecret).not.toHaveBeenCalled();
      await registration.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the RpcHandlerManager transport timeout into catalog work and drains the authoritative lease', async () => {
    vi.useFakeTimers();
    try {
      const rpcHandlerManager = createRealRpcHandlerManager();
      const leafSignal: { current: AbortSignal | null } = { current: null };
      let leafStarted!: () => void;
      const started = new Promise<void>((resolve) => { leafStarted = resolve; });
      const fetchCatalog = vi.fn(async ({ signal }: Parameters<PluginVoiceSpeechRuntimeRegistration['catalogProviders'][number]['catalogOperations']['fetchCatalog']>[0]) => {
        leafSignal.current = signal;
        leafStarted();
        return await rejectWhenAborted(signal);
      });
      const release = vi.fn(async () => undefined);
      const registration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager,
        credentialResolver: { withSecret: vi.fn() } as never,
        resolveSpeechRuntime: vi.fn(async () => ({
          runtime: speechRuntime({
            catalogProviders: [{ providerId: 'google_gemini', catalogOperations: { fetchCatalog } }],
          }),
          release,
        })),
      });

      const pending = rpcHandlerManager.handleRequest({
        method: `machine-test:${RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG}`,
        params: { target: GOOGLE_SPEECH_TARGET, providerId: 'google_gemini', catalog: 'models' },
        timeoutMs: 5,
      });
      await started;
      await vi.advanceTimersByTimeAsync(5);
      const abortedAtTransportDeadline = leafSignal.current?.aborted ?? false;
      if (!abortedAtTransportDeadline) await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({
        ok: false,
        errorCode: 'request_timeout',
        error: 'request_timeout',
        retryable: true,
      });
      await rpcHandlerManager.waitForIdle();
      expect(abortedAtTransportDeadline).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
      expect(rpcHandlerManager.getInFlightRequestCount()).toBe(0);
      await registration.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates transport disconnect into transcription, removes the consumed upload, and drains cleanup', async () => {
    vi.useFakeTimers();
    try {
      const rpcHandlerManager = createRealRpcHandlerManager();
      const leafSignal: { current: AbortSignal | null } = { current: null };
      let leafStarted!: () => void;
      const started = new Promise<void>((resolve) => { leafStarted = resolve; });
      const transcribe = vi.fn(async ({ signal }: Parameters<PluginVoiceSpeechRuntimeRegistration['operations']['transcribe']>[0]) => {
        leafSignal.current = signal;
        leafStarted();
        return await rejectWhenAborted(signal);
      });
      const release = vi.fn(async () => undefined);
      const registration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager,
        credentialResolver: { withSecret: vi.fn() } as never,
        resolveSpeechRuntime: vi.fn(async () => ({
          runtime: speechRuntime({ operations: { transcribe, synthesize: vi.fn() } }),
          release,
        })),
      });
      const init = await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT, {
        ...GOOGLE_STT_CONTEXT,
        sizeBytes: 3,
        mimeType: 'audio/wav',
        fileName: 'recording.wav',
      }) as Readonly<{
        success: true;
        uploadId: string;
        recipientPublicKeyBase64: string;
      }>;
      const encrypted = createEncryptedTransferChunkEnvelope({
        transferId: init.uploadId,
        sequence: 0,
        payload: Buffer.from([1, 2, 3]),
        recipientPublicKeyBase64: init.recipientPublicKeyBase64,
      });
      await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK, {
        uploadId: init.uploadId,
        index: 0,
        ...encrypted,
      });
      await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE, {
        uploadId: init.uploadId,
      });
      expect(await findUploadPaths(init.uploadId)).toHaveLength(1);

      const request = {
        ...GOOGLE_STT_CONTEXT,
        requestId: 'disconnect-transcribe',
        model: 'gemini-2.5-flash',
        language: null,
        mimeType: 'audio/wav',
        uploadId: init.uploadId,
      };
      const pending = rpcHandlerManager.handleRequest({
        method: `machine-test:${RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE}`,
        params: request,
      });
      await started;
      rpcHandlerManager.onSocketDisconnect();
      const abortedAtDisconnect = leafSignal.current?.aborted ?? false;
      if (!abortedAtDisconnect) await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({ ok: false, errorCode: 'request_timeout' });
      await rpcHandlerManager.waitForIdle();
      expect(abortedAtDisconnect).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
      expect(await findUploadPaths(init.uploadId)).toEqual([]);
      await expect(rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE, request))
        .resolves.toEqual({ ok: false, errorCode: 'invalid_parameters' });
      expect(release).toHaveBeenCalledTimes(2);
      await registration.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates transport timeout into synthesis without publishing a download and releases its lease once', async () => {
    vi.useFakeTimers();
    try {
      const rpcHandlerManager = createRealRpcHandlerManager();
      const leafSignal: { current: AbortSignal | null } = { current: null };
      let leafStarted!: () => void;
      const started = new Promise<void>((resolve) => { leafStarted = resolve; });
      const synthesize = vi.fn(async ({ signal }: Parameters<PluginVoiceSpeechRuntimeRegistration['operations']['synthesize']>[0]) => {
        leafSignal.current = signal;
        leafStarted();
        return await rejectWhenAborted(signal);
      });
      const release = vi.fn(async () => undefined);
      const registration = registerMachineVoiceSpeechRpcHandlers({
        rpcHandlerManager,
        credentialResolver: { withSecret: vi.fn() } as never,
        resolveSpeechRuntime: vi.fn(async () => ({
          runtime: speechRuntime({ operations: { transcribe: vi.fn(), synthesize } }),
          release,
        })),
      });
      const recipient = createTransferRecipientKeyPair();
      const pending = rpcHandlerManager.handleRequest({
        method: `machine-test:${RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE}`,
        params: {
          ...GOOGLE_TTS_CONTEXT,
          requestId: 'timeout-synthesize',
          input: 'hello',
          voiceName: 'en-US-Standard-A',
          languageCode: 'en-US',
          format: 'wav',
          speakingRate: null,
          pitch: null,
          recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
        },
        timeoutMs: 5,
      });
      await started;
      await vi.advanceTimersByTimeAsync(5);
      const abortedAtTransportDeadline = leafSignal.current?.aborted ?? false;
      if (!abortedAtTransportDeadline) await vi.advanceTimersByTimeAsync(30_000);

      const response = await pending;
      expect(response).toEqual({ ok: false, errorCode: 'request_timeout' });
      expect(response).not.toHaveProperty('downloadId');
      await rpcHandlerManager.waitForIdle();
      expect(abortedAtTransportDeadline).toBe(true);
      expect(release).toHaveBeenCalledTimes(1);
      expect(rpcHandlerManager.getInFlightRequestCount()).toBe(0);
      await registration.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish synthesized audio when transport cancellation wins after leaf completion', async () => {
    const handlers = new Map<string, (
      raw: unknown,
      context?: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>>();
    const transport = new AbortController();
    const synthesize = vi.fn(async () => {
      transport.abort(new Error('RPC target transport disconnected'));
      return {
        requestId: 'cancel-after-leaf',
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav' as const,
      };
    });
    const release = vi.fn(async () => undefined);
    const registration = registerMachineVoiceSpeechRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method: string, handler: (
          raw: unknown,
          context?: Readonly<{ signal: AbortSignal }>,
        ) => Promise<unknown>) {
          handlers.set(method, handler);
        },
      } as never,
      credentialResolver: { withSecret: vi.fn() } as never,
      resolveSpeechRuntime: vi.fn(async () => ({
        runtime: speechRuntime({ operations: { transcribe: vi.fn(), synthesize } }),
        release,
      })),
    });
    const recipient = createTransferRecipientKeyPair();

    const response = await handlers.get(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE)?.({
      ...GOOGLE_TTS_CONTEXT,
      requestId: 'cancel-after-leaf',
      input: 'hello',
      voiceName: 'en-US-Standard-A',
      languageCode: 'en-US',
      format: 'wav',
      speakingRate: null,
      pitch: null,
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }, { signal: transport.signal });
    await registration.dispose();

    expect(response).toEqual({ ok: false, errorCode: 'request_timeout' });
    expect(response).not.toHaveProperty('downloadId');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
