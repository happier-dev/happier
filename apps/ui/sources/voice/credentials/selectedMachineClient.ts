import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveVoiceExecutionMachineId } from '@/voice/settings/executionMachine';

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
  resolveMachineId: () => string | null;
  machineRpc: VoiceCredentialMachineRpc;
}>;

export function createSelectedVoiceMachineClient(deps?: Partial<SelectedVoiceMachineClientDeps>) {
  const resolved: SelectedVoiceMachineClientDeps = {
    resolveMachineId: resolveVoiceExecutionMachineId,
    machineRpc: machineRpcWithServerScope,
    ...deps,
  };

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
      return await resolved.machineRpc({ machineId, method, payload, ...(signal ? { signal } : {}) });
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
