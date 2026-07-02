import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_IDS } from '@happier-dev/agents';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';

type DeletedGroupCleanupTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
  path: string;
  cleanupAttempts?: number;
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

type GroupExists = (target: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
}>) => Promise<boolean>;

function targetKey(input: Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
}>): string {
  return `${input.serviceId}\0${input.groupId}\0${input.agentId}`;
}

async function readDirectoryNames(path: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function parseAgentId(value: string): CatalogAgentId | null {
  return (AGENT_IDS as ReadonlyArray<string>).includes(value) ? value as CatalogAgentId : null;
}

export class ConnectedServiceGroupHomeCleanupScheduler {
  private readonly pendingDeletedTargetsByKey = new Map<string, DeletedGroupCleanupTarget>();
  private readonly maxCleanupRetries: number;
  private readonly removePath: typeof rm;

  constructor(private readonly deps: Readonly<{
    activeServerDir: string;
    hasLiveTarget(input: Readonly<{
      serviceId: ConnectedServiceId;
      groupId: string;
      agentId: CatalogAgentId;
    }>): boolean;
    groupExists?: GroupExists;
    maxCleanupRetries?: number;
    removePath?: typeof rm;
  }>) {
    this.maxCleanupRetries = deps.maxCleanupRetries ?? 3;
    this.removePath = deps.removePath ?? rm;
  }

  private async removeGroupHome(key: string, target: DeletedGroupCleanupTarget): Promise<void> {
    try {
      await this.removePath(target.path, { recursive: true, force: true });
      this.pendingDeletedTargetsByKey.delete(key);
    } catch (error) {
      const cleanupAttempts = (target.cleanupAttempts ?? 0) + 1;
      if (cleanupAttempts <= this.maxCleanupRetries) {
        this.pendingDeletedTargetsByKey.set(key, { ...target, cleanupAttempts });
      } else {
        this.pendingDeletedTargetsByKey.delete(key);
      }
      throw error;
    }
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
    if (this.deps.hasLiveTarget(input)) {
      this.pendingDeletedTargetsByKey.set(targetKey(input), { ...input, path });
      return { cleaned: false, pending: true, path };
    }
    await this.removeGroupHome(targetKey(input), { ...input, path });
    return { cleaned: true, path };
  }

  private async listExistingGroupHomeTargets(): Promise<ReadonlyArray<GroupHomeTarget>> {
    const homesRoot = join(this.deps.activeServerDir, 'daemon', 'connected-services', 'homes');
    const targets: GroupHomeTarget[] = [];
    for (const serviceDirName of await readDirectoryNames(homesRoot)) {
      const serviceId = ConnectedServiceIdSchema.safeParse(serviceDirName);
      if (!serviceId.success) continue;
      const groupsRoot = join(homesRoot, serviceDirName, '__groups');
      for (const groupId of await readDirectoryNames(groupsRoot)) {
        const groupRoot = join(groupsRoot, groupId);
        for (const agentDirName of await readDirectoryNames(groupRoot)) {
          const agentId = parseAgentId(agentDirName);
          if (!agentId) continue;
          targets.push({ serviceId: serviceId.data, groupId, agentId });
        }
      }
    }
    return targets;
  }

  async reconcileDeletedGroupHomes(input: Readonly<{
    groupExists?: GroupExists;
  }>): Promise<ReadonlyArray<DeletedGroupCleanupResult>> {
    const groupExists = input.groupExists ?? this.deps.groupExists;
    if (!groupExists) return [];
    const results: DeletedGroupCleanupResult[] = [];
    for (const target of await this.listExistingGroupHomeTargets()) {
      if (await groupExists(target)) continue;
      results.push(await this.scheduleDeletedGroupCleanup(target));
    }
    return results;
  }

  async cleanupPendingDeletedGroupHomes(): Promise<ReadonlyArray<Readonly<{ cleaned: true; path: string }>>> {
    const cleaned: Array<Readonly<{ cleaned: true; path: string }>> = [];
    for (const [key, target] of this.pendingDeletedTargetsByKey.entries()) {
      if (this.deps.hasLiveTarget(target)) continue;
      if (target.cleanupAttempts !== undefined && target.cleanupAttempts >= this.maxCleanupRetries) {
        this.pendingDeletedTargetsByKey.delete(key);
        continue;
      }
      if (this.deps.groupExists && await this.deps.groupExists(target)) {
        this.pendingDeletedTargetsByKey.delete(key);
        continue;
      }
      await this.removeGroupHome(key, target);
      cleaned.push({ cleaned: true, path: target.path });
    }
    return cleaned;
  }
}
