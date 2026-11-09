import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { AGENT_IDS } from '@happier-dev/agents';
import { ConnectedServiceIdSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';
import { listExistingConnectedServiceHomeSelections, readConnectedServiceHomeDirectoryNames } from './inventory';

type DeletedGroupCleanupTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
  path: string;
}>;

type DeletedGroupCleanupResult = Readonly<{
  cleaned: boolean;
  pending?: boolean;
  path: string;
}>;

type GroupHomeTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
}>;

export type ConnectedServiceGroupDeletionAuthority = Readonly<{
  status: 'exists' | 'deleted' | 'unknown';
}>;

type GroupExists = (target: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => Promise<boolean>;

type ResolveGroupDeletionAuthority = (target: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => Promise<ConnectedServiceGroupDeletionAuthority>;

type RemoveGroupHomePath = (path: string, options: Readonly<{ recursive: true; force: true }>) => Promise<void>;

function targetKey(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
}>): string {
  return `${input.serviceId}\0${input.groupId}\0${input.agentId}`;
}


function parseAgentId(value: string): CatalogAgentId | null {
  return (AGENT_IDS as ReadonlyArray<string>).includes(value) ? value as CatalogAgentId : null;
}

function authorityFromLegacyGroupExists(exists: boolean): ConnectedServiceGroupDeletionAuthority {
  return exists ? { status: 'exists' } : { status: 'unknown' };
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export class ConnectedServiceGroupHomeCleanupScheduler {
  private readonly pendingDeletedTargetsByKey = new Map<string, DeletedGroupCleanupTarget>();
  private readonly removePath: RemoveGroupHomePath;
  private readonly renamePath: typeof rename;
  private readonly nowMs: () => number;

  constructor(private readonly deps: Readonly<{
    activeServerDir: string;
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    hasLiveTarget(input: Readonly<{
      serviceId: ConnectedServiceId;
      groupId: string;
      agentId: CatalogAgentId;
    }>): boolean;
    groupExists?: GroupExists;
    resolveGroupDeletionAuthority?: ResolveGroupDeletionAuthority;
    removePath?: RemoveGroupHomePath;
    renamePath?: typeof rename;
    nowMs?: () => number;
  }>) {
    this.renamePath = deps.renamePath ?? rename;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.removePath = deps.removePath ?? (async (path) => {
      await this.quarantineGroupHome(path);
    });
  }

  private async quarantineGroupHome(path: string): Promise<void> {
    const quarantineRoot = join(dirname(path), '.quarantine');
    const entryBase = `${this.nowMs()}-${basename(path)}`;
    await mkdir(quarantineRoot, { recursive: true });
    for (let attempt = 0; ; attempt += 1) {
      const quarantinePath = join(quarantineRoot, attempt === 0 ? entryBase : `${entryBase}-${attempt}`);
      try {
        await this.renamePath(path, quarantinePath);
        return;
      } catch (error) {
        if (hasNodeErrorCode(error, 'ENOENT')) return;
        if (hasNodeErrorCode(error, 'EEXIST') || hasNodeErrorCode(error, 'ENOTEMPTY')) continue;
        throw error;
      }
    }
  }

  private async removeGroupHome(key: string, target: DeletedGroupCleanupTarget): Promise<void> {
    try {
      await this.removePath(target.path, { recursive: true, force: true });
      this.pendingDeletedTargetsByKey.delete(key);
    } catch (error) {
      this.pendingDeletedTargetsByKey.set(key, target);
      throw error;
    }
  }

  private hasLiveTarget(target: GroupHomeTarget): boolean {
    const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(target.serviceId);
    return this.deps.runtimeRegistry?.listTargets().some(runtimeTarget => (
      runtimeTarget.agentId === target.agentId
      && runtimeTarget.activeBindings.some(binding => (
        binding.serviceId === serviceKey && binding.groupId === target.groupId
      ))
    )) === true || this.deps.hasLiveTarget(target);
  }

  async scheduleDeletedGroupCleanup(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    agentId: CatalogAgentId;
  }>): Promise<DeletedGroupCleanupResult> {
    const path = resolveConnectedServiceGroupHomeDir({
      activeServerDir: this.deps.activeServerDir,
      serviceId: input.serviceId,
      groupId: input.groupId,
      agentId: input.agentId,
    });
    if (this.hasLiveTarget(input)) {
      this.pendingDeletedTargetsByKey.set(targetKey(input), { ...input, path });
      return { cleaned: false, pending: true, path };
    }
    await this.removeGroupHome(targetKey(input), { ...input, path });
    return { cleaned: true, path };
  }

  private async listExistingGroupHomeTargets(): Promise<ReadonlyArray<GroupHomeTarget>> {
    const targets: GroupHomeTarget[] = [];
    for (const selection of await listExistingConnectedServiceHomeSelections(this.deps.activeServerDir)) {
      if (selection.kind !== 'group') continue;
      const serviceId = ConnectedServiceIdSchema.safeParse(selection.serviceDirectoryName);
      if (!serviceId.success) continue;
      for (const agentDirName of await readConnectedServiceHomeDirectoryNames(selection.directory)) {
        const agentId = parseAgentId(agentDirName);
        if (agentId) targets.push({ serviceId: serviceId.data, groupId: selection.selectionId, agentId });
      }
    }
    return targets;
  }

  async reconcileDeletedGroupHomes(input: Readonly<{
    groupExists?: GroupExists;
    resolveGroupDeletionAuthority?: ResolveGroupDeletionAuthority;
  }>): Promise<ReadonlyArray<DeletedGroupCleanupResult>> {
    const resolveGroupDeletionAuthority = input.resolveGroupDeletionAuthority ?? this.deps.resolveGroupDeletionAuthority;
    const groupExists = input.groupExists ?? this.deps.groupExists;
    if (!resolveGroupDeletionAuthority && !groupExists) return [];
    const results: DeletedGroupCleanupResult[] = [];
    for (const target of await this.listExistingGroupHomeTargets()) {
      const authority = resolveGroupDeletionAuthority
        ? await resolveGroupDeletionAuthority(target)
        : authorityFromLegacyGroupExists(await groupExists!(target));
      if (authority.status !== 'deleted') continue;
      results.push(await this.scheduleDeletedGroupCleanup(target));
    }
    return results;
  }

  async cleanupPendingDeletedGroupHomes(): Promise<ReadonlyArray<Readonly<{ cleaned: true; path: string }>>> {
    const cleaned: Array<Readonly<{ cleaned: true; path: string }>> = [];
    for (const [key, target] of this.pendingDeletedTargetsByKey.entries()) {
      if (this.hasLiveTarget(target)) continue;
      if (this.deps.resolveGroupDeletionAuthority) {
        const authority = await this.deps.resolveGroupDeletionAuthority(target);
        if (authority.status === 'exists') {
          this.pendingDeletedTargetsByKey.delete(key);
          continue;
        }
        if (authority.status === 'unknown') continue;
      } else if (this.deps.groupExists) {
        const authority = authorityFromLegacyGroupExists(await this.deps.groupExists(target));
        if (authority.status === 'exists') {
          this.pendingDeletedTargetsByKey.delete(key);
          continue;
        }
        if (authority.status === 'unknown') continue;
      }
      await this.removeGroupHome(key, target);
      cleaned.push({ cleaned: true, path: target.path });
    }
    return cleaned;
  }
}
