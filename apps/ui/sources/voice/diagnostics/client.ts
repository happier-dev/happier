import {
  VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema,
  VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema,
  VoiceSpeechDiagnosticsDeleteAllResponseV1Schema,
  VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema,
  VoiceSpeechDiagnosticsStatusResponseV1Schema,
  type VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  createSelectedVoiceMachineClient,
  VoiceCredentialClientError,
} from '@/voice/credentials/selectedMachineClient';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { downloadBulkPayloadViaMachineRpcToDestination } from '@/sync/domains/transfers/runtime/transferRuntime/carriers/downloadBulkPayloadViaMachineRpcToDestination';
import type { BulkTransferFileDestination } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/bulkTransferFileDestination';

type VoiceDiagnosticsMachineClient = Readonly<{
  invoke(method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown>;
  /**
   * Optional on the injected shape so an already-pinned client (see
   * `createVoiceDiagnosticsClientForMachine`) can omit it; the artifact export
   * falls back to that client's single target when it is absent.
   */
  bindOperation?: (originMachineId?: string | null) => Readonly<{
    invoke(method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown>;
  }>;
}>;

function parseResponse<T>(
  schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>,
  raw: unknown,
): T {
  if (raw && typeof raw === 'object' && (raw as { ok?: unknown }).ok === false) {
    throw new VoiceCredentialClientError(String((raw as { errorCode?: unknown }).errorCode ?? 'provider_error'));
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new VoiceCredentialClientError('invalid_response');
  return parsed.data;
}

export function createVoiceDiagnosticsClient(
  machine: VoiceDiagnosticsMachineClient = createSelectedVoiceMachineClient(),
) {
  return Object.freeze({
    async status(signal?: AbortSignal | null) {
      return parseResponse(
        VoiceSpeechDiagnosticsStatusResponseV1Schema,
        await machine.invoke(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_STATUS, {}, signal),
      );
    },
    async configure(settings: VoiceSpeechDiagnosticsSettingsV1, signal?: AbortSignal | null) {
      return parseResponse(
        VoiceSpeechDiagnosticsStatusResponseV1Schema,
        await machine.invoke(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_CONFIGURE, { settings }, signal),
      );
    },
    async deleteAll(signal?: AbortSignal | null): Promise<void> {
      parseResponse(
        VoiceSpeechDiagnosticsDeleteAllResponseV1Schema,
        await machine.invoke(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_DELETE_ALL, {}, signal),
      );
    },
    async revokeCaptureAuthorization(authorizationId: string, signal?: AbortSignal | null): Promise<void> {
      parseResponse(
        VoiceSpeechDiagnosticsRevokeCaptureResponseV1Schema,
        await machine.invoke(RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_REVOKE_CAPTURE, { authorizationId }, signal),
      );
    },
    async downloadArtifact(input: Readonly<{
      artifactId: string;
      destination: BulkTransferFileDestination;
      signal?: AbortSignal | null;
      onInit?: ((input: Readonly<{ name: string; sizeBytes: number }>) => Promise<void>) | null;
      onProgress?: ((input: Readonly<{ downloadedBytes: number; totalBytes: number }>) => void) | null;
    }>) {
      // Init publishes a `downloadId` that only the resolving daemon can serve;
      // chunk, finalize and abort stay on that machine for the whole export.
      const bound = machine.bindOperation?.() ?? machine;
      return await downloadBulkPayloadViaMachineRpcToDestination({
        destination: input.destination,
        init: async ({ recipientPublicKeyBase64 }) => parseResponse(
          VoiceSpeechDiagnosticArtifactDownloadInitResponseV1Schema,
          await bound.invoke(
            RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_INIT,
            {
              artifactId: input.artifactId,
              intent: 'user_confirmed_export',
              recipientPublicKeyBase64,
            },
            input.signal,
          ),
        ),
        readChunk: async (request) => parseResponse(
          VoiceSpeechDiagnosticArtifactDownloadChunkResponseV1Schema,
          await bound.invoke(
            RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_CHUNK,
            request,
            input.signal,
          ),
        ),
        finalize: async (request) => parseResponse(
          VoiceSpeechDiagnosticArtifactDownloadCloseResponseV1Schema,
          await bound.invoke(
            RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_FINALIZE,
            request,
            input.signal,
          ),
        ),
        abort: async (request) => await bound.invoke(
          RPC_METHODS.DAEMON_VOICE_DIAGNOSTICS_ARTIFACT_DOWNLOAD_ABORT,
          request,
          input.signal,
        ),
        onInit: input.onInit ?? null,
        onProgress: input.onProgress ?? null,
        signal: input.signal ?? null,
      });
    },
  });
}

/**
 * Deliberately targets one already-resolved machine. Diagnostics runtime sync
 * uses this only to revoke an old machine's capture policy during selection
 * changes; ordinary callers must keep using the replacement-aware selected
 * machine client above.
 */
export function createVoiceDiagnosticsClientForMachine(
  machineId: string,
  machineRpc: typeof machineRpcWithServerScope = machineRpcWithServerScope,
) {
  return createVoiceDiagnosticsClient({
    invoke: async (method, payload, signal) => await machineRpc({
      machineId,
      method,
      payload,
      ...(signal ? { signal } : {}),
    }),
  });
}

export type VoiceDiagnosticsClient = ReturnType<typeof createVoiceDiagnosticsClient>;
