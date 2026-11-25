import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getMachineRolesV1, mutateMachineRolesV1, readMachineRolesSnapshotFromMetadataV1, resolveActiveMachineRolesV1,
  MachineRolesPolicyV1StoredSchema,
  type MachineRoleCatalogEntryV1, type MachineRolesGetResultV1, type MachineRolesMutationResultV1,
} from '@happier-dev/protocol/machines/roles/machineRolesV1';
import type { MachineMetadataFieldPortV1, MachineMetadataFieldReadV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';

import { configuration } from '@/configuration';
import { isServerIdFilesystemSafe } from '@/server/serverId';
import { logger } from '@/ui/logger';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';

function appliedMachineRolesPath(serverId: string, machineId: string): string {
  if (!isServerIdFilesystemSafe(serverId)) throw new Error('Invalid Machine roles Home');
  const machineKey = createHash('sha256').update(machineId).digest('hex');
  return join(configuration.serversDir, serverId.trim(), 'machine-roles', `${machineKey}.json`);
}

async function readAppliedMachineRoles(serverId: string, machineId: string): Promise<readonly string[] | null> {
  try {
    const policy: unknown = JSON.parse(await readFile(appliedMachineRolesPath(serverId, machineId), 'utf8'));
    return policy === null ? null : MachineRolesPolicyV1StoredSchema.parse(policy).active;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[DAEMON RUN] Machine roles: failed to read the applied role set', error);
    }
    return null;
  }
}

export async function writeAppliedMachineRoles(serverId: string, machineId: string, active: readonly string[] | null): Promise<void> {
  // Publish in observation order. Each write replaces only this Machine's record.
  writeJsonAtomicSync(appliedMachineRolesPath(serverId, machineId), active === null ? null : { active });
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

type MachineRolesRuntimeDependencies = Readonly<{
  port: MachineMetadataFieldPortV1;
  /** Admitted plugin `machineRoles`, qualified; core roles are always in the catalog. */
  readPluginCatalog?: () => readonly MachineRoleCatalogEntryV1[];
  /** A Machine with roles off boots with them off, even offline. */
  initialStoredRoles?: readonly string[] | null;
  /** Records the applied stored set (null = missing field) when it really changes. */
  persistApplied?: (active: readonly string[] | null) => void | Promise<void>;
}>;

export async function createDaemonMachineRolesRuntime(dependencies: Readonly<
  Pick<MachineRolesRuntimeDependencies, 'port' | 'readPluginCatalog'> & {
    serverId: string;
    resolveMachineId: () => string | null | undefined;
  }
>): Promise<MachineRolesRuntime> {
  const { serverId, resolveMachineId, ...runtime } = dependencies;
  const machineId = resolveMachineId();
  return createMachineRolesRuntime({
    ...runtime,
    initialStoredRoles: machineId ? await readAppliedMachineRoles(serverId, machineId) : null,
    async persistApplied(active) {
      const currentMachineId = resolveMachineId();
      if (currentMachineId) await writeAppliedMachineRoles(serverId, currentMachineId, active);
    },
  });
}

export function createMachineRolesRuntime(dependencies: MachineRolesRuntimeDependencies): MachineRolesRuntime {
  let snapshot: MachineRolesGetResultV1 = { status: 'unavailable' };
  // Until the first readable snapshot, and while metadata is unreadable, the
  // last applied set stands. With no stored policy the core roles default on.
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
