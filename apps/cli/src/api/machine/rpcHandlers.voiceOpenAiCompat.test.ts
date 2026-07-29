import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { configuration } from '@/configuration';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import {
  createEncryptedTransferChunkEnvelope,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';

import { registerMachineVoiceOpenAiCompatRpcHandlers } from './rpcHandlers.voiceOpenAiCompat';

describe('OpenAI-compatible voice machine RPC registration', () => {
  const client = {
    chat: vi.fn(async () => ({ ok: true as const, text: 'reply' })),
    modelsList: vi.fn(async () => ({ ok: true as const, models: [] })),
    transcribe: vi.fn(async () => ({ ok: true as const, text: 'heard' })),
    synthesize: vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' as const })),
    cancel: vi.fn(() => true),
  };
  let handlers: Map<string, (raw: unknown) => Promise<unknown>>;
  let registration: ReturnType<typeof registerMachineVoiceOpenAiCompatRpcHandlers>;

  beforeEach(() => {
    handlers = new Map();
    vi.clearAllMocks();
    registration = registerMachineVoiceOpenAiCompatRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      client,
    });
  });

  afterEach(async () => {
    await registration.dispose();
    vi.useRealTimers();
  });

  it('registers only the closed operations and their transfer lifecycle', () => {
    expect([...handlers.keys()].sort()).toEqual([
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT,
    ].sort());
  });

  it('caps configured transfer chunks to the encrypted RPC envelope capacity', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(configuration, 'filesTransferChunkBytes');
    await registration.dispose();
    Object.defineProperty(configuration, 'filesTransferChunkBytes', {
      configurable: true,
      value: 5_000_000,
    });
    registration = registerMachineVoiceOpenAiCompatRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      client,
    });

    try {
      const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT)!({
        sizeBytes: 4_000_000,
        mimeType: 'audio/wav',
        fileName: 'speech.wav',
      }) as { success: boolean; chunkSizeBytes?: number };
      expect(init).toMatchObject({ success: true });
      expect(init.chunkSizeBytes).toBe(DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES);
    } finally {
      await registration.dispose();
      if (descriptor) Object.defineProperty(configuration, 'filesTransferChunkBytes', descriptor);
    }
  });

  it('rejects malformed input before dispatching', async () => {
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST)!({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'api_key',
      arbitraryUrl: 'https://attacker.example',
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(client.modelsList).not.toHaveBeenCalled();
  });

  it('uploads encrypted audio once and consumes the finalized upload exactly once', async () => {
    const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT)!({
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    }) as any;
    expect(init.success).toBe(true);
    const encrypted = createEncryptedTransferChunkEnvelope({
      transferId: init.uploadId,
      sequence: 0,
      payload: Buffer.from([7, 8, 9]),
      recipientPublicKeyBase64: init.recipientPublicKeyBase64,
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK)!({
      uploadId: init.uploadId,
      index: 0,
      ...encrypted,
    })).resolves.toEqual({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE)!({ uploadId: init.uploadId }))
      .resolves.toMatchObject({ success: true, uploadId: init.uploadId, sizeBytes: 3 });

    const request = {
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'stt_api_key',
      requestId: 'stt-1',
      model: 'whisper-1',
      uploadId: init.uploadId,
    };
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE)!(request))
      .resolves.toEqual({ ok: true, text: 'heard' });
    expect(client.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stt-1',
      audio: { bytes: new Uint8Array([7, 8, 9]), mimeType: 'audio/wav', fileName: 'speech.wav' },
    }));
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE)!(request))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await registration.dispose();
  });

  it('returns a typed safe error when finalized upload bytes disappear before transcription', async () => {
    const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT)!({
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    }) as any;
    const encrypted = createEncryptedTransferChunkEnvelope({
      transferId: init.uploadId,
      sequence: 0,
      payload: Buffer.from([7, 8, 9]),
      recipientPublicKeyBase64: init.recipientPublicKeyBase64,
    });
    await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK)!({
      uploadId: init.uploadId,
      index: 0,
      ...encrypted,
    });
    await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE)!({ uploadId: init.uploadId });

    const transferRoots = await readdir(join(tmpdir(), 'happier', 'file-transfers'), { withFileTypes: true });
    await Promise.all(transferRoots
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        await rm(join(tmpdir(), 'happier', 'file-transfers', entry.name, `${init.uploadId}.upload`), { force: true });
      }));

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE)!({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'stt_api_key',
      requestId: 'stt-missing-file',
      model: 'whisper-1',
      uploadId: init.uploadId,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'internal_error',
      retryable: false,
    });
    expect(client.transcribe).not.toHaveBeenCalled();
  });

  it('downloads synthesized audio only as encrypted transfer chunks and disposes it', async () => {
    const recipient = createTransferRecipientKeyPair();
    const started = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE)!({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'tts_api_key',
      requestId: 'tts-1',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }) as any;
    expect(started).toMatchObject({ ok: true, sizeBytes: 3, mimeType: 'audio/wav' });
    expect(started).not.toHaveProperty('audioBase64');
    const chunk = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK)!({
      downloadId: started.downloadId,
      index: 0,
    }) as any;
    expect(chunk.success).toBe(true);
    expect(chunk).not.toHaveProperty('contentBase64');
    expect([...decryptEncryptedTransferChunkEnvelope({
      transferId: started.downloadId,
      sequence: 0,
      payloadBase64: chunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
      recipientSecretKeySeed: recipient.recipientSecretKeySeed,
    })]).toEqual([1, 2, 3]);
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE)!({ downloadId: started.downloadId }))
      .resolves.toEqual({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK)!({ downloadId: started.downloadId, index: 1 }))
      .resolves.toMatchObject({ success: false, errorCode: 'transfer_not_found' });
    await registration.dispose();
  });

  it('rejects an invalid download recipient key before contacting the provider', async () => {
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE)!({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'tts_api_key',
      requestId: 'tts-invalid-recipient',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      recipientPublicKeyBase64: 'not-a-recipient-key',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      retryable: false,
    });
    expect(client.synthesize).not.toHaveBeenCalled();
  });

  it('contains unexpected synthesis failures behind the typed RPC error contract', async () => {
    const recipient = createTransferRecipientKeyPair();
    client.synthesize.mockRejectedValueOnce(new Error('sensitive dependency failure'));

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE)!({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'tts_api_key',
      requestId: 'tts-unexpected-failure',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'internal_error',
      retryable: false,
    });
  });

  it('aborts transfer sessions and forwards request cancellation by exact id', async () => {
    const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT)!({
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    }) as any;
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT)!({ uploadId: init.uploadId }))
      .resolves.toEqual({ success: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE)!({ uploadId: init.uploadId }))
      .resolves.toMatchObject({ success: false, errorCode: 'transfer_not_found' });
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL)!({ requestId: 'chat-1' }))
      .resolves.toEqual({ ok: true, cancelled: true });
    expect(client.cancel).toHaveBeenCalledWith('chat-1');
    await registration.dispose();
  });

  it('expires abandoned upload metadata with its transfer session', async () => {
    vi.useFakeTimers();
    const init = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT)!({
      sizeBytes: 3,
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    }) as any;

    await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs + 1);

    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE)!({
      uploadId: init.uploadId,
    })).resolves.toMatchObject({ success: false, errorCode: 'transfer_not_found' });
  });

  it('refreshes synthesized download expiry after each successful chunk', async () => {
    vi.useFakeTimers();
    const recipient = createTransferRecipientKeyPair();
    const started = await handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE)!({
      baseUrl: 'https://example.test/v1',
      insecureLocalOriginConsent: null,
      credentialKind: 'tts_api_key',
      requestId: 'tts-refresh',
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
    }) as any;

    await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs - 1);
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK)!({
      downloadId: started.downloadId,
      index: 0,
    })).resolves.toMatchObject({ success: true });

    await vi.advanceTimersByTimeAsync(2);
    await expect(handlers.get(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK)!({
      downloadId: started.downloadId,
      index: 1,
    })).resolves.toMatchObject({ success: true });
  });
});
