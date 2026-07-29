import {
  VoiceSpeechDiagnosticArtifactDownloadChunkRequestV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadCloseRequestV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema,
  VoiceSpeechDiagnosticsConfigureRequestV1Schema,
  VoiceSpeechDiagnosticsDeleteAllResponseV1Schema,
  VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema,
  VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema,
  VoiceSpeechDiagnosticsStatusResponseV1Schema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { VoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';
import { parseTransferRecipientPublicKeyBase64 } from '@/machines/transfer/transferChunkEncryption';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

export function registerMachineVoiceDiagnosticsRpcHandlers(input: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  diagnostics: VoiceDiagnosticsController;
}>): Readonly<{ dispose(): Promise<void> }> {
  const downloadStore = new TransferSessionStore({ ttlMs: 5 * 60_000 });
  const downloads = createTransferSessionLifecycle({ store: downloadStore, chunkSizeBytes: 256 * 1024 });
  const internalError = () => ({ ok: false as const, error: 'internal_error', errorCode: 'internal_error' });
  const invalidParameters = () => ({ success: false as const, error: 'invalid_parameters', errorCode: 'invalid_parameters' });
  const transferNotFound = () => ({ success: false as const, error: 'transfer_not_found', errorCode: 'transfer_not_found' });
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE, async (raw: unknown) => {
    const parsed = VoiceSpeechDiagnosticsConfigureRequestV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters', errorCode: 'invalid_parameters' };
    try {
      await input.diagnostics.configure(parsed.data.settings);
      const status = await input.diagnostics.status();
      return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ok: true, root: input.diagnostics.root, ...status });
    } catch {
      return internalError();
    }
  });
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS, async () => {
    try {
      const status = await input.diagnostics.status();
      return VoiceSpeechDiagnosticsStatusResponseV1Schema.parse({ ok: true, root: input.diagnostics.root, ...status });
    } catch {
      return internalError();
    }
  });
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL, async () => {
    try {
      downloadStore.cleanupExpiredBestEffort();
      await Promise.all(downloadStore.listDownloadSessionIds().map(async (downloadId) => {
        await downloads.abortDownloadTransferSession({ downloadId });
      }));
      await input.diagnostics.deleteAll();
      return VoiceSpeechDiagnosticsDeleteAllResponseV1Schema.parse({ ok: true });
    } catch {
      return internalError();
    }
  });
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE, async (raw: unknown) => {
    const parsed = VoiceSpeechDiagnosticsRevokeCaptureRequestV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid_parameters', errorCode: 'invalid_parameters' };
    try {
      await input.diagnostics.revokeCaptureAuthorization(parsed.data.authorizationId);
      return VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema.parse({ ok: true });
    } catch {
      return internalError();
    }
  });
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT, async (raw: unknown) => {
    const parsed = VoiceSpeechDiagnosticArtifactDownloadInitRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidParameters();
    try {
      parseTransferRecipientPublicKeyBase64(parsed.data.recipientPublicKeyBase64);
    } catch {
      return invalidParameters();
    }
    try {
      downloadStore.cleanupExpiredBestEffort();
      const artifact = await input.diagnostics.resolveArtifactForExport(parsed.data.artifactId);
      if (!artifact) return transferNotFound();
      const session = await downloads.openDownloadTransferSession({
        source: {
          filePath: artifact.audioPath,
          deleteFileOnClose: false,
          sizeBytes: artifact.byteLength,
          name: `voice-diagnostic-${artifact.createdAtMs}-${artifact.direction}.${artifact.format}`,
        },
        recipientPublicKeyBase64: parsed.data.recipientPublicKeyBase64,
      });
      return VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema.parse({
        success: true,
        downloadId: session.downloadId,
        chunkSizeBytes: session.chunkSizeBytes,
        sizeBytes: artifact.byteLength,
        name: `voice-diagnostic-${artifact.createdAtMs}-${artifact.direction}.${artifact.format}`,
      });
    } catch {
      return { success: false as const, error: 'internal_error', errorCode: 'internal_error' };
    }
  });
  input.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK, async (raw: unknown) => {
    const parsed = VoiceSpeechDiagnosticArtifactDownloadChunkRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidParameters();
    try {
      const response = await downloads.readDownloadTransferChunk(parsed.data);
      if (!response.success || !('payloadBase64' in response)) return transferNotFound();
      return VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema.parse(response);
    } catch {
      return { success: false as const, error: 'internal_error', errorCode: 'internal_error' };
    }
  });
  const closeDownload = async (raw: unknown, abort: boolean) => {
    const parsed = VoiceSpeechDiagnosticArtifactDownloadCloseRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidParameters();
    if (!downloadStore.getDownloadSession(parsed.data.downloadId)) return transferNotFound();
    try {
      if (abort) await downloads.abortDownloadTransferSession(parsed.data);
      else await downloads.finalizeDownloadTransferSession(parsed.data);
      return VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema.parse({ success: true });
    } catch {
      return { success: false as const, error: 'internal_error', errorCode: 'internal_error' };
    }
  };
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_FINALIZE,
    async (raw: unknown) => await closeDownload(raw, false),
  );
  input.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_ABORT,
    async (raw: unknown) => await closeDownload(raw, true),
  );

  return Object.freeze({
    dispose: async () => {
      await downloadStore.dispose();
    },
  });
}
