import {
  getMachineRolesV1, mutateMachineRolesV1, readMachineRolesSnapshotFromMetadataV1, resolveActiveMachineRolesV1,
  type MachineRoleCatalogEntryV1, type MachineRolesGetResultV1, type MachineRolesMutationResultV1,
} from '@happier-dev/protocol/machines/roles/machineRolesV1';
import type { MachineMetadataFieldPortV1, MachineMetadataFieldReadV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';

import { updateSettings } from '@/persistence';
import { logger } from '@/ui/logger';

export async function writeAppliedMachineRoles(serverId: string, machineId: string, active: readonly string[] | null): Promise<void> {
  await updateSettings(current => {
    const byMachine = { ...current.machineRolesByServerIdByMachineId?.[serverId] };
    if (active) byMachine[machineId] = [...active];
    else delete byMachine[machineId];
    return { ...current, machineRolesByServerIdByMachineId: { ...current.machineRolesByServerIdByMachineId, [serverId]: byMachine } };
  });
}

/**
 * The daemon's one view of its Machine's role set. The Machine-metadata change
 * hook reloads it; the role registration owner (P03-HANDLER-SPLIT) reads
 * `activeRoles()` and subscribes to real changes. Nothing else decides roles.
 */
export type MachineRolesRuntime = Readonly<{
  read: () => MachineRolesGetResultV1;
  activeRoles: () => ReadonlySet<string>;
  /**
   * The applied set as the metadata shape `resolveActiveMachineRolesV1` reads (no field = the
   * default). Plugin admission resolves its own `machineRoles` against it with the same function.
   */
  appliedMetadata: () => Readonly<{ rolesV1?: unknown }>;
  isActive: (roleId: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  reload: () => Promise<void>;
  /** Accepts a metadata snapshot already opened by the Machine client (boot: before roles activate). */
  observe: (read: MachineMetadataFieldReadV1) => void;
  refreshCatalog: () => void;
  set: (input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<MachineRolesMutationResultV1>;
  stop: () => void;
}>;

export function createMachineRolesRuntime(dependencies: Readonly<{
  port: MachineMetadataFieldPortV1;
  /** Admitted plugin `machineRoles`, qualified; core roles are always in the catalog. */
  readPluginCatalog?: () => readonly MachineRoleCatalogEntryV1[];
  /** Last applied stored set from local settings: a Machine with roles off boots with them off, even offline. */
  initialStoredRoles?: readonly string[] | null;
  /** Records the applied stored set (null = missing field) when it really changes. */
  persistApplied?: (active: readonly string[] | null) => void | Promise<void>;
}>): MachineRolesRuntime {
  let snapshot: MachineRolesGetResultV1 = { status: 'unavailable' };
  // Until the first readable snapshot, and while metadata is unreadable, the
  // last applied set stands; at start that is every core role (today).
  let applied: Readonly<{ rolesV1?: unknown }> = dependencies.initialStoredRoles
    ? { rolesV1: { active: [...dependencies.initialStoredRoles] } } : {};
  let persistedKey = JSON.stringify(dependencies.initialStoredRoles ? [...dependencies.initialStoredRoles].sort() : null);
  let active = resolveActiveMachineRolesV1(applied, dependencies.readPluginCatalog?.());
  let stopped = false;
  const listeners = new Set<() => void>();
  const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    left.size === right.size && [...left].every(id => right.has(id));
  const recompute = () => {
    const next = resolveActiveMachineRolesV1(applied, dependencies.readPluginCatalog?.());
    if (sameSet(next, active)) return;
    active = next;
    for (const listener of listeners) listener();
  };
  const accept = (next: MachineRolesGetResultV1) => {
    if (stopped) return;
    if (next.status !== 'ready') {
      if (snapshot.status !== 'ready') snapshot = next;
      return;
    }
    if (snapshot.status === 'ready' && next.metadataVersion < snapshot.metadataVersion) return;
    snapshot = next;
    applied = next.source === 'stored' ? { rolesV1: next.policy } : {};
    const stored = next.source === 'stored' ? next.policy.active : null;
    const key = JSON.stringify(stored ? [...stored].sort() : null);
    if (key !== persistedKey) {
      persistedKey = key;
      void Promise.resolve(dependencies.persistApplied?.(stored)).catch(error =>
        logger.warn('[DAEMON RUN] Machine roles: failed to record the applied role set', error));
    }
    recompute();
  };
  return {
    read: () => snapshot,
    activeRoles: () => active,
    appliedMetadata: () => applied,
    isActive: roleId => active.has(roleId),
    subscribe(listener) {
      if (!stopped) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    observe(read) {
      accept(read.status === 'ready' ? readMachineRolesSnapshotFromMetadataV1(read) : { status: read.status });
    },
    async reload() {
      if (stopped) return;
      accept(await getMachineRolesV1(dependencies.port));
    },
    refreshCatalog() { if (!stopped) recompute(); },
    async set(input, options) {
      if (stopped) return { status: 'unavailable' };
      const result = await mutateMachineRolesV1(input, dependencies.port, options);
      // CAS (including lost-ACK reconciliation) already returned the canonical field.
      if (result.status === 'applied' || result.status === 'satisfied') accept({ status: 'ready', policy: result.policy, source: 'stored', metadataVersion: result.metadataVersion });
      return result;
    },
    stop() { stopped = true; listeners.clear(); },
  };
}
