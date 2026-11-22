import { composeProviderSettingsV1, splitProviderSettingsV1,
  type ProviderConnectionsCatalogV1, type ProviderConnectionsCatalogSnapshotV1 } from '../../providers/connections/connectionRowsV1.js';
import { hasProviderMachineStateV1, removeProviderMachineStateV1 } from '../../providers/settings/operationsV1.js';

export type MachineRevokeWithProviderCleanupResult =
  | (Extract<RetiredMachineProviderCleanupResult, { ok: true }> & Readonly<{ machineAlreadyRevoked: boolean }>)
  | Extract<RetiredMachineProviderCleanupResult, { ok: false }>
  | Readonly<{ ok: false; status: number; error: string }>;

type RetiredMachineProviderCleanupResult =
  | Readonly<{ ok: true; providerCleanup: 'complete' | 'not_needed' }>
  | Readonly<{ ok: false; status: number; error: 'provider_cleanup_pending' | 'provider_settings_unreadable';
      machineRevoked: true; providerCleanup: 'pending'; retryable: boolean }>;
type ProviderCleanupPorts = Readonly<{
  readCatalog(): Promise<ProviderConnectionsCatalogSnapshotV1>;
  writeCatalog(value: { catalog: ProviderConnectionsCatalogV1; expectedRevision: number | 'absent' }): Promise<{ status: string }>;
}>;

function pendingProviderCleanup(unreadable = false): Extract<RetiredMachineProviderCleanupResult, { ok: false }> {
  return { ok: false, status: unreadable ? 409 : 503,
    error: unreadable ? 'provider_settings_unreadable' : 'provider_cleanup_pending',
    machineRevoked: true, providerCleanup: 'pending', retryable: !unreadable };
}

/** One Account-scoped revoke/cleanup sequence; UI and CLI supply their incumbent transports. */
export async function revokeMachineWithProviderCleanup(machineId: string, ports: ProviderCleanupPorts & Readonly<{
  revoke(): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
}>): Promise<MachineRevokeWithProviderCleanupResult> {
  const id = String(machineId ?? '').trim();
  if (!id) return { ok: false, status: 400, error: 'machine_id_required' };
  const revoked = await ports.revoke();
  const machineAlreadyRevoked = !revoked.ok && revoked.status === 410 && revoked.error === 'machine_revoked';
  if (!revoked.ok && !machineAlreadyRevoked) return revoked;
  const cleanup = await retireMachineProviderState(id, ports);
  return cleanup.ok ? { ...cleanup, machineAlreadyRevoked } : cleanup;
}

/** Retire exact Account state after the Machine lifecycle owner confirms removal. */
export async function retireMachineProviderState(machineId: string, ports: ProviderCleanupPorts): Promise<RetiredMachineProviderCleanupResult> {
  try {
    const captured = await ports.readCatalog();
    if (captured.status !== 'ready') {
      return pendingProviderCleanup(captured.status === 'partial'
        || captured.status === 'unavailable' && captured.reason === 'invalid-stored-content');
    }
    const settings = composeProviderSettingsV1(captured.catalog, {});
    if (!hasProviderMachineStateV1(settings, machineId)) {
      return { ok: true, providerCleanup: 'not_needed' };
    }
    const catalog = splitProviderSettingsV1(removeProviderMachineStateV1(settings, machineId)).catalog;
    const mutation = await ports.writeCatalog({ catalog, expectedRevision: captured.revision });
    return mutation.status === 'updated'
      ? { ok: true, providerCleanup: 'complete' }
      : pendingProviderCleanup();
  } catch {
    return pendingProviderCleanup();
  }
}
