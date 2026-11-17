import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getMachineDisplayName, isMachineDisplayHydrating, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { readTeamSharedMachineRows } from '@/sync/api/machines/machineRowsApi';
import { homeDomainActionFailureFromDomainFailure } from '@/sync/api/home/homeDomainActions';

export async function listMachinesForVoiceTool(params: Readonly<{ serverId?: string; limit?: number; refresh?: boolean; purpose?: 'input'; sharedWithTeamId?: string }>): Promise<unknown> {
  let state = storage.getState();
  if (params.purpose !== 'input' && !readVoicePrivacySettings(state?.settings).shareDeviceInventory) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const activeServerId = getActiveServerSnapshot().serverId;
  const serverId = params.serverId ?? activeServerId;
  if (params.refresh === true && params.sharedWithTeamId === undefined) {
    const { sync } = await import('@/sync/sync');
    await sync.refreshMachines({ serverId });
    state = storage.getState();
  }
  const machines = resolveServerScopedMachines({
    serverId, activeServerId, activeMachines: Object.values(state.machines),
    machineListByServerId: state.machineListByServerId,
    machineListStatusByServerId: state.machineListStatusByServerId,
  }) ?? [];
  const scopeResolution = params.purpose === 'input' || params.sharedWithTeamId !== undefined
    ? await resolveServerCredentialAccountScope(serverId) : null;
  const scope = scopeResolution?.kind === 'bound' ? scopeResolution.scope : null;
  if (params.sharedWithTeamId !== undefined && !scope) {
    return homeDomainActionFailureFromDomainFailure('machines.list', { kind: 'unreachable', retryable: true, code: null });
  }
  const scopedResult = params.sharedWithTeamId !== undefined && scope
    ? await readTeamSharedMachineRows({ scope, sharedWithTeamId: params.sharedWithTeamId }) : null;
  if (scopedResult && !scopedResult.ok) return homeDomainActionFailureFromDomainFailure('machines.list', scopedResult.failure);
  const scopedRows = scopedResult?.ok ? scopedResult.value : null;
  const byId = new Map(machines.map(machine => [machine.id, machine]));
  // Server rows own membership/access; the retained inventory supplies display details only.
  const entries = scopedRows ? scopedRows.map(row => ({ row, machine: byId.get(row.id) }))
    : machines.map(machine => ({ row: machine, machine }));
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : undefined;
  // The machines the Projects list and its widgets name are the ones selection shows; an input row says whether its label
  // is such a name, so a consumer never presents a hidden or still-loading machine's placeholder as one.
  const names = params.purpose === 'input' ? resolveMachineDisplayNames(entries.flatMap(entry => entry.machine && isMachineVisibleForSelection(entry.machine) ? [entry.machine] : [])) : null;

  // Host inputs read the already-loaded Home inventory, not the voice disclosure projection or launch readiness.
  const items = (params.purpose === 'input' || limit === undefined ? entries : entries.slice(0, limit))
    .map(({ row, machine: m }) => ({
      serverId,
      machineId: normalizeNonEmptyString(row.id),
      installationId: normalizeNonEmptyString(row.installationId),
      label: m ? names?.get(m.id) ?? resolveVoiceMachineLabel(m) : getMachineDisplayName({ absence: 'unlisted' }),
      ...(params.purpose === 'input' ? { named: !!m && isMachineVisibleForSelection(m) && !isMachineDisplayHydrating(m),
        presence: (() => {
          if (!m) return 'unknown';
          const verdict = resolveMachineReachability(scope, m);
          return verdict === 'reachable' ? 'online' : verdict === 'unreachable' ? 'offline' : 'unknown';
        })(),
        platform: normalizeNonEmptyString(m?.metadata?.platform), arch: normalizeNonEmptyString(m?.metadata?.arch),
        ...(normalizeNonEmptyString(m?.metadata?.homeDir) ? { homeDir: normalizeNonEmptyString(m?.metadata?.homeDir) } : {}),
        revokedAt: row.revokedAt, replacedByMachineId: row.replacedByMachineId } : {}),
      ...(normalizeNonEmptyString(m?.metadata?.host) ? { host: normalizeNonEmptyString(m?.metadata?.host) } : {}),
      ...(row.access ? { access: row.access } : {}),
      ...('sharedWithTeamScope' in row && row.sharedWithTeamScope ? { sharedWithTeamScope: row.sharedWithTeamScope } : {}),
    }))
    .filter((m) => m.machineId);

  return { items, ...(params.purpose === 'input' ? { unlistedLabel: getMachineDisplayName({ absence: 'unlisted' }) } : {}) };
}
