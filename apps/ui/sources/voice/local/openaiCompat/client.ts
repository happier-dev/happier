import {
  DAEMON_VOICE_OPENAI_COMPAT_AUDIO_MAX_BYTES,
  DaemonVoiceOpenAiCompatChatResponseSchema,
  DaemonVoiceOpenAiCompatDownloadAbortResponseSchema,
  DaemonVoiceOpenAiCompatDownloadChunkResponseSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatModelsListResponseSchema,
  DaemonVoiceOpenAiCompatRequestCancelResponseSchema,
  DaemonVoiceOpenAiCompatSynthesizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema,
  type DaemonVoiceOpenAiCompatConnection,
  type DaemonVoiceOpenAiCompatErrorCode,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
  createTransferRecipientKeyPair,
  downloadInChunks,
  uploadInChunks,
} from '@/sync/domains/transfers/runtime/transferRuntime/carriers/chunkTransferClient';
import { randomUUID } from '@/platform/randomUUID';
import { resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';

type ChatMessage = Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>;
export type OpenAiCompatDaemonConnection = DaemonVoiceOpenAiCompatConnection & Readonly<{
  /** The execution machine on which the user confirmed this insecure origin. */
  insecureLocalConsentMachineId?: string | null;
}>;
type MachineRpc = (params: Readonly<{
  machineId: string;
  method: string;
  payload: unknown;
  signal?: AbortSignal;
}>) => Promise<unknown>;

export class OpenAiCompatDaemonClientError extends Error {
  readonly code:
    | DaemonVoiceOpenAiCompatErrorCode
    | 'machine_unavailable'
    | 'invalid_response'
    | 'transfer_failed'
    | 'legacy_credential_unavailable';

  constructor(code: OpenAiCompatDaemonClientError['code']) {
    super(code);
    this.name = 'OpenAiCompatDaemonClientError';
    this.code = code;
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseResponse<T>(schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OpenAiCompatDaemonClientError('invalid_response');
  return parsed.data;
}

function throwProviderError(response: Readonly<{ ok: boolean; errorCode?: string }>): void {
  if (response.ok !== false) return;
  throw new OpenAiCompatDaemonClientError(
    (response.errorCode ?? 'invalid_response') as OpenAiCompatDaemonClientError['code'],
  );
}

function throwTransferError(response: Readonly<{ success: boolean; errorCode?: string }>): void {
  if (response.success === true) return;
  throw new OpenAiCompatDaemonClientError(response.errorCode === 'cancelled' ? 'cancelled' : 'transfer_failed');
}

function resolveMachineBoundInsecureConsent(
  consent: string | null,
  consentMachineId: string | null | undefined,
  executionMachineId: string,
): string | null {
  return consent && consentMachineId === executionMachineId ? consent : null;
}

export type OpenAiCompatDaemonClientDeps = Readonly<{
  resolveMachineId: () => string | null;
  machineRpc: MachineRpc;
  createRequestId: () => string;
  openUploadSourceReader: typeof openLocalUploadSourceReader;
}>;

export class OpenAiCompatDaemonClient {
  private readonly deps: OpenAiCompatDaemonClientDeps;

  constructor(deps?: Partial<OpenAiCompatDaemonClientDeps>) {
    this.deps = {
      resolveMachineId: resolveVoiceExecutionMachineId,
      machineRpc: machineRpcWithServerScope,
      createRequestId: randomUUID,
      openUploadSourceReader: openLocalUploadSourceReader,
      ...deps,
    };
  }

  private requireMachineId(): string {
    const machineId = this.deps.resolveMachineId();
    if (!machineId) throw new OpenAiCompatDaemonClientError('machine_unavailable');
    return machineId;
  }

  private assertMachineUnchanged(machineId: string): void {
    if (this.deps.resolveMachineId() !== machineId) {
      throw new OpenAiCompatDaemonClientError('machine_unavailable');
    }
  }

  private async invoke(machineId: string, method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown> {
    this.assertMachineUnchanged(machineId);
    const response = await this.deps.machineRpc({
      machineId,
      method,
      payload,
      ...(signal ? { signal } : {}),
    });
    this.assertMachineUnchanged(machineId);
    return response;
  }

  private async invokeCancellable(
    machineId: string,
    requestId: string,
    method: string,
    payload: unknown,
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    const cancel = () => {
      void this.deps.machineRpc({
        machineId,
        method: RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL,
        payload: { requestId },
      }).catch(() => undefined);
    };
    if (signal?.aborted) {
      cancel();
      throw new OpenAiCompatDaemonClientError('cancelled');
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      try {
        return await this.invoke(machineId, method, payload, signal);
      } catch (error) {
        if (
          signal?.aborted
          || (error as { name?: unknown } | null)?.name === 'AbortError'
          || (error as { code?: unknown } | null)?.code === 'MACHINE_RPC_ABORTED'
        ) {
          throw new OpenAiCompatDaemonClientError('cancelled');
        }
        throw error;
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  async listModels(connection: OpenAiCompatDaemonConnection): Promise<readonly Readonly<{ id: string }>[]> {
    const machineId = this.requireMachineId();
    const { insecureLocalConsentMachineId, ...request } = connection;
    const response = parseResponse(DaemonVoiceOpenAiCompatModelsListResponseSchema, await this.invoke(
      machineId,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST,
      {
        ...request,
        insecureLocalOriginConsent: resolveMachineBoundInsecureConsent(
          request.insecureLocalOriginConsent,
          insecureLocalConsentMachineId,
          machineId,
        ),
      },
    ));
    throwProviderError(response);
    if (!response.ok) throw new OpenAiCompatDaemonClientError('invalid_response');
    return response.models;
  }

  async chat(params: OpenAiCompatDaemonConnection & Readonly<{
    model: string;
    messages: readonly ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal | null;
  }>): Promise<string> {
    const machineId = this.requireMachineId();
    const requestId = this.deps.createRequestId();
    const { signal, insecureLocalConsentMachineId, ...request } = params;
    const response = parseResponse(DaemonVoiceOpenAiCompatChatResponseSchema, await this.invokeCancellable(
      machineId,
      requestId,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT,
      {
        ...request,
        insecureLocalOriginConsent: resolveMachineBoundInsecureConsent(
          request.insecureLocalOriginConsent,
          insecureLocalConsentMachineId,
          machineId,
        ),
        requestId,
      },
      signal,
    ));
    throwProviderError(response);
    if (!response.ok) throw new OpenAiCompatDaemonClientError('invalid_response');
    return response.text;
  }

  async transcribe(params: OpenAiCompatDaemonConnection & Readonly<{
    model: string;
    language?: string;
    prompt?: string;
    source: LocalUploadSource;
    mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg';
    fileName: string;
    signal?: AbortSignal | null;
  }>): Promise<string> {
    const machineId = this.requireMachineId();
    const requestId = this.deps.createRequestId();
    const reader = await this.deps.openUploadSourceReader(params.source);
    try {
      const sizeBytes = reader.sizeBytes;
      if (!sizeBytes || sizeBytes > DAEMON_VOICE_OPENAI_COMPAT_AUDIO_MAX_BYTES) {
        throw new OpenAiCompatDaemonClientError('transfer_failed');
      }
      const uploaded = await uploadInChunks({
        totalBytes: sizeBytes,
        readBytes: reader.readBytes,
        init: async () => parseResponse(DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema, await this.invoke(
          machineId,
          RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT,
          { sizeBytes, mimeType: params.mimeType, fileName: params.fileName },
          params.signal,
        )),
        sendChunk: async (payload) => parseResponse(DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema, await this.invoke(
          machineId,
          RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK,
          payload,
          params.signal,
        )),
        finalize: async (payload) => parseResponse(DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema, await this.invoke(
          machineId,
          RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE,
          payload,
          params.signal,
        )),
        abort: async (payload) => parseResponse(DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema, await this.deps.machineRpc({
          machineId,
          method: RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT,
          payload,
        })),
        signal: params.signal ?? null,
      });
      throwTransferError(uploaded);
      if (!uploaded.success) throw new OpenAiCompatDaemonClientError('transfer_failed');
      const response = parseResponse(DaemonVoiceOpenAiCompatTranscribeResponseSchema, await this.invokeCancellable(
        machineId,
        requestId,
        RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE,
        {
          baseUrl: params.baseUrl,
          insecureLocalOriginConsent: resolveMachineBoundInsecureConsent(
            params.insecureLocalOriginConsent,
            params.insecureLocalConsentMachineId,
            machineId,
          ),
          credentialKind: params.credentialKind,
          requestId,
          model: params.model,
          ...(params.language ? { language: params.language } : {}),
          ...(params.prompt ? { prompt: params.prompt } : {}),
          uploadId: uploaded.uploadId,
        },
        params.signal,
      ));
      throwProviderError(response);
      if (!response.ok) throw new OpenAiCompatDaemonClientError('invalid_response');
      return response.text;
    } finally {
      await reader.close();
    }
  }

  async synthesize(params: OpenAiCompatDaemonConnection & Readonly<{
    model: string;
    voice: string;
    text: string;
    responseFormat: 'wav' | 'mp3' | 'opus' | 'aac' | 'flac' | 'pcm';
    speed?: number;
    signal?: AbortSignal | null;
  }>): Promise<Readonly<{ bytes: Uint8Array; mimeType: string }>> {
    const machineId = this.requireMachineId();
    const requestId = this.deps.createRequestId();
    const recipient = createTransferRecipientKeyPair();
    const { signal, insecureLocalConsentMachineId, ...request } = params;
    const started = parseResponse(DaemonVoiceOpenAiCompatSynthesizeResponseSchema, await this.invokeCancellable(
      machineId,
      requestId,
      RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE,
      {
        ...request,
        insecureLocalOriginConsent: resolveMachineBoundInsecureConsent(
          request.insecureLocalOriginConsent,
          insecureLocalConsentMachineId,
          machineId,
        ),
        requestId,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      },
      signal,
    ));
    throwProviderError(started);
    if (!started.ok) throw new OpenAiCompatDaemonClientError('invalid_response');
    const chunks: Uint8Array[] = [];
    const downloaded = await downloadInChunks({
      init: async () => ({ success: true as const, ...started }),
      readChunk: async (payload) => parseResponse(DaemonVoiceOpenAiCompatDownloadChunkResponseSchema, await this.invoke(
        machineId,
        RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK,
        payload,
        signal,
      )),
      finalize: async (payload) => parseResponse(DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema, await this.invoke(
        machineId,
        RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE,
        payload,
        signal,
      )),
      abort: async (payload) => parseResponse(DaemonVoiceOpenAiCompatDownloadAbortResponseSchema, await this.deps.machineRpc({
        machineId,
        method: RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT,
        payload,
      })),
      recipientSecretKeySeed: recipient.recipientSecretKeySeed,
      writeBytes: async (bytes) => { chunks.push(bytes); },
      signal: signal ?? null,
    });
    if (!downloaded.ok) {
      throw new OpenAiCompatDaemonClientError(
        signal?.aborted || downloaded.errorCode === 'cancelled' ? 'cancelled' : 'transfer_failed',
      );
    }
    return { bytes: concatBytes(chunks), mimeType: started.mimeType };
  }
}
