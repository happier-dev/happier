import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
  resolveVoiceExecutionMachineId,
  type VoiceExecutionMachineOverride,
} from '@/voice/settings/executionMachine';

export type VoiceCredentialMachineRpc = typeof machineRpcWithServerScope;

export class VoiceCredentialClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'VoiceCredentialClientError';
    this.code = code;
  }
}

export type SelectedVoiceMachineClientDeps = Readonly<{
  /**
   * Resolves the Voice daemon target. The optional override asks the resolver
   * for a specific origin machine, still replacement-aware and fail-closed on
   * reachability; injected pins that deliberately ignore it stay exact.
   */
  resolveMachineId: (override?: VoiceExecutionMachineOverride | null) => string | null;
  machineRpc: VoiceCredentialMachineRpc;
}>;

/**
 * One composite Voice operation pinned to the machine it started on.
 *
 * Every phase of an upload, a synthesis download, or a diagnostics export names
 * daemon-side state (`uploadId`, `downloadId`) that exists only on the machine
 * that produced it. Re-reading the mutable automatic target between phases can
 * send `chunk` to a machine that never saw `init`, which answers
 * `transfer_not_found` while the real temporary state stays behind on the
 * initiating machine until its TTL expires.
 */
export type BoundVoiceMachineOperation = Readonly<{
  machineId: string;
  invoke(method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown>;
}>;

export function createSelectedVoiceMachineClient(deps?: Partial<SelectedVoiceMachineClientDeps>) {
  const resolved: SelectedVoiceMachineClientDeps = {
    resolveMachineId: resolveVoiceExecutionMachineId,
    machineRpc: machineRpcWithServerScope,
    ...deps,
  };

  const dispatch = async (
    machineId: string,
    method: string,
    payload: unknown,
    signal?: AbortSignal | null,
  ): Promise<unknown> => await resolved.machineRpc({
    machineId,
    method,
    payload,
    ...(signal ? { signal } : {}),
  });

  return Object.freeze({
    /**
     * The dispatched machine is the authority for this call.
     *
     * The automatic Voice target is re-derived from mutable ordering (recent
     * machine paths, liveness) on every read, so with more than one online
     * machine two reads seconds apart can disagree with no user action. Reading
     * it a second time after the call discarded an answer the dispatched
     * machine had already produced successfully, which surfaced as
     * `credential_unavailable` — an absent credential — for a purely local
     * ordering change. Attempt currency is enforced by the caller's
     * `isCurrent()`, not by re-resolving the target.
     */
    async invoke(method: string, payload: unknown, signal?: AbortSignal | null): Promise<unknown> {
      const machineId = resolved.resolveMachineId();
      if (!machineId) throw new VoiceCredentialClientError('machine_unavailable');
      return await dispatch(machineId, method, payload, signal);
    },

    /**
     * Resolve the target once for a whole multi-phase operation.
     *
     * `originMachineId` replays a target an earlier phase of the same user
     * attempt already captured (a dictation attempt, for example) through the
     * same resolver, so a replaced machine is followed and an offline one fails
     * closed here rather than mid-transfer.
     */
    bindOperation(originMachineId?: string | null): BoundVoiceMachineOperation {
      const requested = typeof originMachineId === 'string' && originMachineId.trim()
        ? originMachineId.trim()
        : null;
      const machineId = resolved.resolveMachineId(requested ? { machineId: requested } : null);
      if (!machineId) throw new VoiceCredentialClientError('machine_unavailable');
      return Object.freeze({
        machineId,
        invoke: async (
          method: string,
          payload: unknown,
          signal?: AbortSignal | null,
        ): Promise<unknown> => await dispatch(machineId, method, payload, signal),
      });
    },
  });
}

export function parseCredentialResponse<T>(
  schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new VoiceCredentialClientError('invalid_response');
  if ((parsed.data as { ok?: boolean }).ok === false) {
    throw new VoiceCredentialClientError(String((parsed.data as { errorCode?: unknown }).errorCode ?? 'provider_error'));
  }
  return parsed.data;
}
