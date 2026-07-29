import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTransferRecipientKeyPair, createEncryptedTransferChunkEnvelope } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';

import { OpenAiCompatDaemonClient, OpenAiCompatDaemonClientError } from './client';

const connection = {
  baseUrl: 'https://gateway.example.test/v1',
  insecureLocalOriginConsent: null,
  credentialKind: 'api_key',
} as const;

describe('OpenAiCompatDaemonClient', () => {
  it('resolves the canonical execution machine for every operation and fails closed when absent', async () => {
    let currentMachineId: string | null = 'machine-a';
    const rpc = vi.fn(async ({ method }: { method: string; machineId: string; payload: unknown }) => {
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST) return { ok: true, models: [] };
      throw new Error(`unexpected ${method}`);
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => currentMachineId,
      machineRpc: rpc,
      createRequestId: () => 'request-1',
    });

    await expect(client.listModels(connection)).resolves.toEqual([]);
    currentMachineId = 'machine-b';
    await expect(client.listModels(connection)).resolves.toEqual([]);
    expect(rpc.mock.calls.map(([call]) => call.machineId)).toEqual(['machine-a', 'machine-b']);
    currentMachineId = null;
    await expect(client.listModels(connection)).rejects.toBeInstanceOf(OpenAiCompatDaemonClientError);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('fails an in-flight operation closed when the selected machine changes before the response settles', async () => {
    let currentMachineId: string | null = 'machine-a';
    const rpc = vi.fn(async () => {
      currentMachineId = 'machine-b';
      return { ok: true, models: [{ id: 'must-not-escape' }] };
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => currentMachineId,
      machineRpc: rpc,
      createRequestId: () => 'request-1',
    });

    await expect(client.listModels(connection)).rejects.toMatchObject({ code: 'machine_unavailable' });
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a' }));
  });

  it('does not reuse insecure endpoint consent minted for another execution machine', async () => {
    let modelsPayload: unknown = null;
    const rpc = vi.fn(async ({ method, payload }: { method: string; payload: unknown }) => {
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST) {
        modelsPayload = payload;
        return { ok: true, models: [] };
      }
      throw new Error(`unexpected ${method}`);
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => 'machine-b',
      machineRpc: rpc,
      createRequestId: () => 'request-1',
    });

    await expect(client.listModels({
      baseUrl: 'http://localhost:11434/v1',
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
      credentialKind: 'api_key',
    } as any)).resolves.toEqual([]);
    expect(modelsPayload).toMatchObject({
      insecureLocalOriginConsent: null,
    });
  });

  it('routes chat through the daemon and sends exact request cancellation on abort', async () => {
    let resolveChat!: (value: unknown) => void;
    const rpc = vi.fn(async ({ method }: { method: string }) => {
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL) return { ok: true, cancelled: true };
      return await new Promise((resolve) => { resolveChat = resolve; });
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => 'machine-a',
      machineRpc: rpc,
      createRequestId: () => 'chat-1',
    });
    const abort = new AbortController();
    const pending = client.chat({
      ...connection,
      model: 'chat-model',
      messages: [{ role: 'user', content: 'hello' }],
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    abort.abort();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[1]?.[0]).toMatchObject({
      machineId: 'machine-a',
      method: RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL,
      payload: { requestId: 'chat-1' },
    });
    resolveChat({ ok: false, errorCode: 'cancelled', error: 'cancelled', retryable: false });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('normalizes a caller-aborted machine RPC into the client cancellation error', async () => {
    const abort = new AbortController();
    let rejectChat!: (error: unknown) => void;
    const rpc = vi.fn(async ({ method }: { method: string }) => {
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL) {
        return { ok: true, cancelled: true };
      }
      return await new Promise((_resolve, reject) => {
        rejectChat = reject;
      });
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => 'machine-a',
      machineRpc: rpc,
      createRequestId: () => 'chat-abort',
    });
    const pending = client.chat({
      ...connection,
      model: 'chat-model',
      messages: [{ role: 'user', content: 'hello' }],
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));

    abort.abort();
    rejectChat(Object.assign(new Error('Machine RPC aborted'), {
      name: 'AbortError',
      code: 'MACHINE_RPC_ABORTED',
    }));

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('uploads STT bytes through the encrypted transfer lifecycle and sends no raw/base64 audio in transcribe', async () => {
    const recipient = createTransferRecipientKeyPair();
    const calls: Array<{ method: string; payload: any }> = [];
    const rpc = vi.fn(async ({ method, payload }: { method: string; payload: any }) => {
      calls.push({ method, payload });
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT) {
        return { success: true, uploadId: 'upload-1', chunkSizeBytes: 2, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK) return { success: true };
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE) {
        return { success: true, uploadId: 'upload-1', sizeBytes: 3, sha256: 'a'.repeat(64) };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE) return { ok: true, text: 'heard' };
      throw new Error(`unexpected ${method}`);
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => 'machine-a',
      machineRpc: rpc,
      createRequestId: () => 'stt-1',
    });
    await expect(client.transcribe({
      ...connection,
      model: 'whisper-1',
      source: { kind: 'memory', bytes: new Uint8Array([1, 2, 3]) },
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    })).resolves.toBe('heard');

    expect(calls.map((call) => call.method)).toEqual([
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE,
    ]);
    const transcribePayload = calls.at(-1)?.payload;
    expect(transcribePayload).toMatchObject({ requestId: 'stt-1', uploadId: 'upload-1' });
    expect(JSON.stringify(transcribePayload)).not.toMatch(/bytesBase64|audioBase64/u);
  });

  it('aborts an encrypted STT transfer on its original machine when selection changes mid-upload', async () => {
    const recipient = createTransferRecipientKeyPair();
    let currentMachineId: string | null = 'machine-a';
    const calls: Array<{ machineId: string; method: string }> = [];
    const rpc = vi.fn(async ({ machineId, method }: { machineId: string; method: string }) => {
      calls.push({ machineId, method });
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT) {
        return { success: true, uploadId: 'upload-switch', chunkSizeBytes: 2, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64 };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK) {
        currentMachineId = 'machine-b';
        return { success: true };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT) return { success: true };
      throw new Error(`unexpected ${method}`);
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => currentMachineId,
      machineRpc: rpc,
      createRequestId: () => 'stt-switch',
    });

    await expect(client.transcribe({
      ...connection,
      model: 'whisper-1',
      source: { kind: 'memory', bytes: new Uint8Array([1, 2, 3]) },
      mimeType: 'audio/wav',
      fileName: 'speech.wav',
    })).rejects.toMatchObject({ code: 'machine_unavailable' });
    expect(calls.at(-1)).toEqual({
      machineId: 'machine-a',
      method: RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT,
    });
    expect(calls).not.toContainEqual(expect.objectContaining({ method: RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE }));
  });

  it('downloads encrypted TTS bytes with size validation and finalizes the session', async () => {
    let downloadPublicKey: string | null = null;
    const calls: Array<{ method: string; payload: any }> = [];
    const rpc = vi.fn(async ({ method, payload }: { method: string; payload: any }) => {
      calls.push({ method, payload });
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE) {
        downloadPublicKey = payload.recipientPublicKeyBase64;
        return { ok: true, downloadId: 'download-1', chunkSizeBytes: 64, sizeBytes: 3, mimeType: 'audio/wav' };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK) {
        const encrypted = await createEncryptedTransferChunkEnvelope({
          transferId: 'download-1',
          sequence: 0,
          payload: new Uint8Array([4, 5, 6]),
          recipientPublicKeyBase64: downloadPublicKey!,
        });
        return { success: true, ...encrypted, isLast: true };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE) return { success: true };
      throw new Error(`unexpected ${method}`);
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => 'machine-a',
      machineRpc: rpc,
      createRequestId: () => 'tts-1',
    });
    await expect(client.synthesize({
      ...connection,
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
    })).resolves.toEqual({ bytes: new Uint8Array([4, 5, 6]), mimeType: 'audio/wav' });
    expect(calls.map((call) => call.method)).toEqual([
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE,
    ]);
  });

  it('preserves cancellation when synthesis is aborted before encrypted download starts', async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const rpc = vi.fn(async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE) {
        abort.abort();
        return { ok: true, downloadId: 'download-cancel', chunkSizeBytes: 64, sizeBytes: 3, mimeType: 'audio/wav' };
      }
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT) return { success: true };
      if (method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL) return { ok: true, cancelled: false };
      throw new Error(`unexpected ${method}`);
    });
    const client = new OpenAiCompatDaemonClient({
      resolveMachineId: () => 'machine-a',
      machineRpc: rpc,
      createRequestId: () => 'tts-cancel',
    });

    await expect(client.synthesize({
      ...connection,
      model: 'tts-1',
      voice: 'alloy',
      text: 'hello',
      responseFormat: 'wav',
      signal: abort.signal,
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toContain(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT);
    expect(calls).not.toContain(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK);
  });
});
