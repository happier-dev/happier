import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES as VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES,
  DaemonVoiceOpenAiCompatDownloadAbortRequestSchema as VoiceSpeechDownloadAbortRequestSchema,
  DaemonVoiceOpenAiCompatDownloadAbortResponseSchema as VoiceSpeechDownloadAbortResponseSchema,
  DaemonVoiceOpenAiCompatDownloadChunkRequestSchema as VoiceSpeechDownloadChunkRequestSchema,
  DaemonVoiceOpenAiCompatDownloadChunkResponseSchema as VoiceSpeechDownloadChunkResponseSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema as VoiceSpeechDownloadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema as VoiceSpeechDownloadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema as VoiceSpeechTranscribeUploadAbortRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema as VoiceSpeechTranscribeUploadAbortResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema as VoiceSpeechTranscribeUploadChunkRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema as VoiceSpeechTranscribeUploadChunkResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema as VoiceSpeechTranscribeUploadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema as VoiceSpeechTranscribeUploadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema as VoiceSpeechTranscribeUploadInitRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema as VoiceSpeechTranscribeUploadInitResponseSchema,
  PluginContributionLocalIdSchema,
  PluginIdSchema,
  VoiceProviderCatalogResponseSchema,
  VoiceProviderIdSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  PluginVoiceSpeechCredentialAccess,
  PluginVoiceSpeechRuntimeRegistration,
} from '@happier-dev/plugin-sdk/runtime';

import { configuration } from '@/configuration';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import type { VoiceCredentialResolver } from '@/daemon/voice/credentials/resolver';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';

type VoiceSpeechTargetRef = Readonly<{ pluginId: string; localId: string }>;
type UploadMetadata = Readonly<{
  target: VoiceSpeechTargetRef;
  providerId: string;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
}>;
type FinalizedUpload = Readonly<UploadMetadata & { path: string }>;

const invalid = Object.freeze({ ok: false as const, errorCode: 'invalid_parameters' as const });
const transferInvalid = Object.freeze({ success: false as const, error: 'invalid_parameters' as const, errorCode: 'invalid_parameters' as const });
function transferFailure(code: 'transfer_not_found' | 'transfer_failed' | 'cancelled') {
  return Object.freeze({ success: false as const, error: code, errorCode: code });
}

export type MachineVoiceSpeechRpcRegistration = Readonly<{ dispose(): Promise<void> }>;

type VoiceSpeechRuntimeLease = Readonly<{
  runtime: PluginVoiceSpeechRuntimeRegistration;
  release(): Promise<void>;
}>;

export function registerMachineVoiceSpeechRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  credentialResolver: VoiceCredentialResolver;
  resolveSpeechRuntime?(target: VoiceSpeechTargetRef): Promise<VoiceSpeechRuntimeLease>;
}>): MachineVoiceSpeechRpcRegistration {
  const ttlMs = Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs || 60_000));
  const chunkSizeBytes = Math.min(
    VOICE_SPEECH_TRANSFER_CHUNK_MAX_BYTES,
    Math.max(1, Math.trunc(configuration.filesTransferChunkBytes)),
  );
  const uploadStore = new TransferSessionStore({ ttlMs });
  const downloadStore = new TransferSessionStore({ ttlMs });
  const uploads = createTransferSessionLifecycle({ store: uploadStore, chunkSizeBytes });
  const downloads = createTransferSessionLifecycle({ store: downloadStore, chunkSizeBytes });
  const uploadMetadata = new Map<string, UploadMetadata>();
  const finalizedUploads = new Map<string, FinalizedUpload>();
  const finalizedUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const downloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const downloadFiles = new Map<string, string>();
  const outputFiles = new Set<string>();
  let outputRootPromise: Promise<string> | null = null;
  let disposed = false;

  const resolveSpeechRuntime = params.resolveSpeechRuntime ?? (async (target: VoiceSpeechTargetRef): Promise<VoiceSpeechRuntimeLease> => {
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    try {
      await lease.registry.activateContributionsOnDemand([{
        pluginId: target.pluginId,
        family: 'voiceProviders.speech',
        localId: target.localId,
      }]);
      const speech = lease.registry.voiceSpeechProviders?.read(target) ?? null;
      if (!speech?.isCurrent()) {
        throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
      }
      return Object.freeze({ runtime: speech.runtime, release: lease.release });
    } catch (error) {
      await lease.release();
      throw error;
    }
  });
  const credential = (providerId: string): PluginVoiceSpeechCredentialAccess => async (use) => (
    await params.credentialResolver.withSecret({ providerId, credentialSlotId: 'api_key', use })
  );

  const outputRoot = async () => outputRootPromise ??= mkdtemp(join(tmpdir(), 'happier-voice-speech-'));
  const clearUpload = async (uploadId: string) => {
    const timer = finalizedUploadTimers.get(uploadId);
    if (timer) clearTimeout(timer);
    finalizedUploadTimers.delete(uploadId);
    const finalized = finalizedUploads.get(uploadId);
    finalizedUploads.delete(uploadId);
    uploadMetadata.delete(uploadId);
    await uploads.abortUploadTransferSession({ uploadId }).catch(() => undefined);
    if (finalized) await rm(finalized.path, { force: true }).catch(() => undefined);
  };
  const scheduleUploadExpiry = (uploadId: string) => {
    const existing = finalizedUploadTimers.get(uploadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void clearUpload(uploadId); }, ttlMs);
    timer.unref?.();
    finalizedUploadTimers.set(uploadId, timer);
  };
  const clearDownload = async (downloadId: string) => {
    const timer = downloadTimers.get(downloadId);
    if (timer) clearTimeout(timer);
    downloadTimers.delete(downloadId);
    await downloads.abortDownloadTransferSession({ downloadId }).catch(() => undefined);
    const filePath = downloadFiles.get(downloadId);
    downloadFiles.delete(downloadId);
    if (filePath) outputFiles.delete(filePath);
  };
  const scheduleDownloadExpiry = (downloadId: string) => {
    const existing = downloadTimers.get(downloadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void clearDownload(downloadId); }, ttlMs);
    timer.unref?.();
    downloadTimers.set(downloadId, timer);
  };
  const runBounded = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    transportSignal?: AbortSignal,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    const signal = transportSignal
      ? AbortSignal.any([transportSignal, controller.signal])
      : controller.signal;
    try { return await operation(signal); } finally { clearTimeout(timer); }
  };
  const throwIfTransportCancelled = (signal?: AbortSignal) => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('RPC request cancelled'), { name: 'AbortError' });
  };
  const classify = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'credential_unavailable') return { ok: false as const, errorCode: 'credential_unavailable' as const };
    if (code === 'provider_unavailable') return { ok: false as const, errorCode: 'provider_unavailable' as const };
    if ((error as { name?: unknown } | null)?.name === 'AbortError') return { ok: false as const, errorCode: 'request_timeout' as const };
    if (code === 'provider_response_invalid') return { ok: false as const, errorCode: 'provider_response_invalid' as const };
    return { ok: false as const, errorCode: 'internal_error' as const };
  };
  const parseTarget = (value: unknown): VoiceSpeechTargetRef | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const pluginId = PluginIdSchema.safeParse(candidate.pluginId);
    const localId = PluginContributionLocalIdSchema.safeParse(candidate.localId);
    if (!pluginId.success || !localId.success) return null;
    return Object.freeze({ pluginId: pluginId.data, localId: localId.data });
  };
  const sameTarget = (left: VoiceSpeechTargetRef, right: VoiceSpeechTargetRef) => (
    left.pluginId === right.pluginId && left.localId === right.localId
  );
  const parseProviderId = (value: unknown): string | null => {
    const parsed = VoiceProviderIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_CATALOG, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    const request = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const target = parseTarget(request?.target);
    const providerId = parseProviderId(request?.providerId);
    const catalog = request?.catalog === 'models' || request?.catalog === 'voices' ? request.catalog : null;
    if (!target || !providerId || !catalog) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', retryable: false };
    let lease: VoiceSpeechRuntimeLease | null = null;
    try {
      lease = await resolveSpeechRuntime(target);
      const provider = lease.runtime.catalogProviders.find((candidate) => candidate.providerId === providerId);
      if (!provider) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters', retryable: false };
      const items = await runBounded(async (signal) => await provider.catalogOperations.fetchCatalog({
        credential: credential(providerId),
        catalog,
        signal,
      }), context?.signal);
      return VoiceProviderCatalogResponseSchema.parse({ ok: true, items });
    } catch (error) {
      const failure = classify(error);
      return VoiceProviderCatalogResponseSchema.parse({ ok: false, errorCode: failure.errorCode, error: failure.errorCode, retryable: failure.errorCode === 'request_timeout' });
    } finally { await lease?.release(); }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT, async (raw: unknown) => {
    const request = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const target = parseTarget(request?.target);
    const providerId = parseProviderId(request?.providerId);
    const parsed = VoiceSpeechTranscribeUploadInitRequestSchema.safeParse({
      sizeBytes: request?.sizeBytes,
      mimeType: request?.mimeType,
      fileName: request?.fileName,
    });
    if (!target || !providerId || !parsed.success || disposed) return transferInvalid;
    try {
      const recipient = createTransferRecipientKeyPair();
      const session = await uploads.openUploadTransferSession({
        target: {
          destPath: 'voice-speech-transcribe', destDisplayPath: 'voice-speech-transcribe',
          expectedSizeBytes: parsed.data.sizeBytes, overwrite: true,
          finalizeUpload: async ({ tempPath, sizeBytes }) => ({ success: true, path: tempPath, sizeBytes }),
        },
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      uploadMetadata.set(session.uploadId, { target, providerId, ...parsed.data });
      scheduleUploadExpiry(session.uploadId);
      return VoiceSpeechTranscribeUploadInitResponseSchema.parse({
        success: true,
        uploadId: session.uploadId,
        chunkSizeBytes: session.chunkSizeBytes,
        recipientPublicKeyBase64: session.recipientPublicKeyBase64,
      });
    } catch {
      return transferFailure('transfer_failed');
    }
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK, async (raw: unknown) => {
    const parsed = VoiceSpeechTranscribeUploadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    const response = await uploads.writeUploadTransferChunk(parsed.data);
    if (!response.success) return uploadMetadata.has(parsed.data.uploadId) ? transferFailure('transfer_failed') : transferFailure('transfer_not_found');
    scheduleUploadExpiry(parsed.data.uploadId);
    return VoiceSpeechTranscribeUploadChunkResponseSchema.parse({ success: true });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = VoiceSpeechTranscribeUploadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    const metadata = uploadMetadata.get(parsed.data.uploadId);
    if (!metadata) return transferFailure('transfer_not_found');
    const result = await uploads.finalizeUploadTransferSession(parsed.data);
    if (!result.success) return transferFailure('transfer_failed');
    uploadMetadata.delete(parsed.data.uploadId);
    finalizedUploads.set(parsed.data.uploadId, { ...metadata, path: result.finalized.path, sizeBytes: result.finalized.sizeBytes });
    scheduleUploadExpiry(parsed.data.uploadId);
    return VoiceSpeechTranscribeUploadFinalizeResponseSchema.parse({ success: true, uploadId: parsed.data.uploadId, sizeBytes: result.finalized.sizeBytes, sha256: result.sha256 });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_ABORT, async (raw: unknown) => {
    const parsed = VoiceSpeechTranscribeUploadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    await clearUpload(parsed.data.uploadId);
    return VoiceSpeechTranscribeUploadAbortResponseSchema.parse({ success: true });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    let lease: VoiceSpeechRuntimeLease | null = null;
    let uploaded: FinalizedUpload | undefined;
    const request = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const target = parseTarget(request?.target);
    const providerId = parseProviderId(request?.providerId);
    if (!target || !providerId) return invalid;
    try {
      lease = await resolveSpeechRuntime(target);
    } catch (error) {
      return classify(error);
    }
    const parsed = lease.runtime.schemas.transcribeRequest.safeParse({
      requestId: request?.requestId,
      model: request?.model,
      language: request?.language,
      mimeType: request?.mimeType,
      uploadId: request?.uploadId,
    });
    if (!parsed.success || lease.runtime.speechProviderIds.transcribe !== providerId) {
      await lease.release();
      return invalid;
    }
    uploaded = finalizedUploads.get(parsed.data.uploadId);
    if (
      !uploaded
      || uploaded.mimeType !== parsed.data.mimeType
      || uploaded.providerId !== providerId
      || !sameTarget(uploaded.target, target)
    ) {
      await lease.release();
      return invalid;
    }
    finalizedUploads.delete(parsed.data.uploadId);
    const uploadTimer = finalizedUploadTimers.get(parsed.data.uploadId);
    if (uploadTimer) clearTimeout(uploadTimer);
    finalizedUploadTimers.delete(parsed.data.uploadId);
    try {
      const bytes = new Uint8Array(await readFile(uploaded.path));
      const result = await runBounded(async (signal) => await lease!.runtime.operations.transcribe({
          credential: credential(providerId),
          request: { requestId: parsed.data.requestId, model: parsed.data.model, language: parsed.data.language, mimeType: parsed.data.mimeType, bytes },
          signal,
        }), context?.signal);
      return lease.runtime.schemas.transcribeResponse.parse({ ok: true, ...result });
    } catch (error) { return classify(error); }
    finally {
      await lease.release();
      await rm(uploaded.path, { force: true }).catch(() => undefined);
    }
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_SYNTHESIZE, async (
    raw: unknown,
    context?: RpcHandlerContext,
  ) => {
    let lease: VoiceSpeechRuntimeLease | null = null;
    let filePath: string | null = null;
    let downloadId: string | null = null;
    const request = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const target = parseTarget(request?.target);
    const providerId = parseProviderId(request?.providerId);
    if (!target || !providerId) return invalid;
    try {
      lease = await resolveSpeechRuntime(target);
      const parsed = lease.runtime.schemas.synthesizeRequest.safeParse({
        requestId: request?.requestId,
        input: request?.input,
        voiceName: request?.voiceName,
        languageCode: request?.languageCode,
        format: request?.format,
        speakingRate: request?.speakingRate,
        pitch: request?.pitch,
        recipientPublicKeyBase64: request?.recipientPublicKeyBase64,
      });
      if (!parsed.success || lease.runtime.speechProviderIds.synthesize !== providerId) return invalid;
      const synthesized = await runBounded(async (signal) => await lease!.runtime.operations.synthesize({
        credential: credential(providerId),
        request: parsed.data,
        signal,
      }), context?.signal);
      throwIfTransportCancelled(context?.signal);
      const root = await outputRoot();
      throwIfTransportCancelled(context?.signal);
      filePath = join(root, `${randomUUID()}.audio`);
      await writeFile(filePath, synthesized.bytes, {
        mode: 0o600,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      outputFiles.add(filePath);
      throwIfTransportCancelled(context?.signal);
      const session = await downloads.openDownloadTransferSession({
        source: { filePath, deleteFileOnClose: true, sizeBytes: synthesized.bytes.byteLength, name: 'voice-speech-audio' },
        recipientPublicKeyBase64: parsed.data.recipientPublicKeyBase64,
      });
      downloadId = session.downloadId;
      downloadFiles.set(session.downloadId, filePath);
      scheduleDownloadExpiry(session.downloadId);
      throwIfTransportCancelled(context?.signal);
      return lease.runtime.schemas.synthesizeResponse.parse({
        ok: true, requestId: parsed.data.requestId, downloadId: session.downloadId,
        chunkSizeBytes: session.chunkSizeBytes, sizeBytes: synthesized.bytes.byteLength, mimeType: synthesized.mimeType,
      });
    } catch (error) {
      if (downloadId) await clearDownload(downloadId);
      else if (filePath) {
        outputFiles.delete(filePath);
        await rm(filePath, { force: true }).catch(() => undefined);
      }
      return classify(error);
    } finally { await lease?.release(); }
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_CHUNK, async (raw: unknown) => {
    const parsed = VoiceSpeechDownloadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    const response = await downloads.readDownloadTransferChunk(parsed.data);
    if (!response.success) return transferFailure('transfer_not_found');
    if (!('payloadBase64' in response)) return transferFailure('transfer_failed');
    scheduleDownloadExpiry(parsed.data.downloadId);
    return VoiceSpeechDownloadChunkResponseSchema.parse(response);
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = VoiceSpeechDownloadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    if (!downloadStore.getDownloadSession(parsed.data.downloadId)) return transferFailure('transfer_not_found');
    await clearDownload(parsed.data.downloadId);
    return VoiceSpeechDownloadFinalizeResponseSchema.parse({ success: true });
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_SPEECH_DOWNLOAD_ABORT, async (raw: unknown) => {
    const parsed = VoiceSpeechDownloadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalid;
    await clearDownload(parsed.data.downloadId);
    return VoiceSpeechDownloadAbortResponseSchema.parse({ success: true });
  });

  return Object.freeze({
    async dispose() {
      disposed = true;
      for (const timer of finalizedUploadTimers.values()) clearTimeout(timer);
      finalizedUploadTimers.clear();
      for (const timer of downloadTimers.values()) clearTimeout(timer);
      downloadTimers.clear();
      for (const uploadId of [...finalizedUploads.keys()]) await clearUpload(uploadId);
      await uploadStore.dispose();
      await downloadStore.dispose();
      for (const path of outputFiles) await rm(path, { force: true }).catch(() => undefined);
      outputFiles.clear();
      if (outputRootPromise) await rm(await outputRootPromise, { recursive: true, force: true }).catch(() => undefined);
    },
  });
}
