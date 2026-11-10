import { mkdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ConnectedServiceIdSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedAccountServiceKey, ConnectedServiceId, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { resolveConnectedServiceAccountHomesDir, resolveConnectedServiceGroupHomeDir } from './resolveConnectedServiceHomeDir';
import { listExistingConnectedServiceHomeSelections, readConnectedServiceHomeDirectoryNames } from './inventory';
import { listNativeHomeCredentialTargets } from './listNativeHomeCredentialTargets';
import { removeConnectedServiceNativeHomeCredentials } from '../stateSharing/materializeConnectedServiceNativeHomeCredentials';

type DeletedGroupCleanupTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
  path: string;
}>;

type DeletedAccountCleanupTarget = Readonly<{
  account: QualifiedConnectedAccountRef;
  path: string;
  activeServerDir: string;
}>;

type DeletedHomeCleanupTarget = DeletedGroupCleanupTarget | DeletedAccountCleanupTarget;

type DeletedHomeCleanupResult = Readonly<{
  cleaned: boolean;
  pending?: boolean;
  path: string;
}>;

type GroupHomeTarget = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  agentId: CatalogAgentId;
}>;

type GroupHomeUseTarget = Omit<GroupHomeTarget, 'serviceId'> & Readonly<{ serviceId: ConnectedServiceId | ConnectedAccountServiceKey }>;

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


function authorityFromLegacyGroupExists(exists: boolean): ConnectedServiceGroupDeletionAuthority {
  return exists ? { status: 'exists' } : { status: 'unknown' };
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

export class ConnectedServiceGroupHomeCleanupScheduler {
  private readonly pendingDeletedTargetsByKey = new Map<string, DeletedHomeCleanupTarget>();
  private readonly removePath: RemoveGroupHomePath;
  private readonly renamePath: typeof rename;
  private readonly nowMs: () => number;

  constructor(private readonly deps: Readonly<{
    activeServerDir: string;
    additionalAccountHomeRoots?: readonly string[];
    runtimeRegistry?: ConnectedServiceRuntimeRegistry;
    hasLiveTarget(input: GroupHomeUseTarget): boolean;
    hasLiveAccountTarget?(account: QualifiedConnectedAccountRef): boolean;
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

  private async removeHome(key: string, target: DeletedHomeCleanupTarget): Promise<boolean> {
    try {
      // Revoked selected credentials are removed, never retained in the group-history quarantine.
      if ('account' in target) {
        if (this.hasLiveAccountTarget(target.account)) return false;
        let pending = false;
        const serviceId = buildQualifiedPluginContributionKey(target.account.service);
        for (const home of await listNativeHomeCredentialTargets({ activeServerDir: target.activeServerDir, account: target.account })) {
          if (home.groupId !== null && this.hasLiveTarget({ serviceId, groupId: home.groupId, agentId: home.agentId })) {
            pending = true;
            continue;
          }
          await removeConnectedServiceNativeHomeCredentials({ targetRoot: home.path, declaredSecretEntries: home.secretEntries });
        }
        if (pending) return false;
      } else {
        await this.removePath(target.path, { recursive: true, force: true });
      }
      this.pendingDeletedTargetsByKey.delete(key);
      return true;
    } catch (error) {
      this.pendingDeletedTargetsByKey.set(key, target);
      throw error;
    }
  }

  private hasLiveAccountTarget(account: QualifiedConnectedAccountRef): boolean {
    const serviceKey = buildQualifiedPluginContributionKey(account.service);
    return this.deps.runtimeRegistry?.listTargets().some(target => target.activeBindings.some(binding => (
      binding.serviceId === serviceKey && binding.profileId === account.accountId
    ))) === true || this.deps.hasLiveAccountTarget?.(account) === true;
  }

  async scheduleDeletedAccountCleanup(input: Readonly<{ account: QualifiedConnectedAccountRef }>): Promise<DeletedHomeCleanupResult> {
    const serviceId = buildQualifiedPluginContributionKey(input.account.service);
    const path = resolveConnectedServiceAccountHomesDir({ activeServerDir: this.deps.activeServerDir,
      serviceId, profileId: input.account.accountId });
    const targets = [this.deps.activeServerDir, ...(this.deps.additionalAccountHomeRoots ?? [])].map(activeServerDir => {
      const path = resolveConnectedServiceAccountHomesDir({ activeServerDir, serviceId, profileId: input.account.accountId });
      return { key: `account\0${path}`, target: { account: input.account, path, activeServerDir } };
    });
    // A failed removal leaves every remaining known root in the existing cleanup queue.
    for (const { key, target } of targets) this.pendingDeletedTargetsByKey.set(key, target);
    let pending = false;
    for (const { key, target } of targets) {
      if (!await this.removeHome(key, target)) pending = true;
    }
    return pending ? { cleaned: false, pending: true, path } : { cleaned: true, path };
  }

  private hasLiveTarget(target: GroupHomeUseTarget): boolean {
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
  }>): Promise<DeletedHomeCleanupResult> {
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
    await this.removeHome(targetKey(input), { ...input, path });
    return { cleaned: true, path };
  }

  private async listExistingGroupHomeTargets(): Promise<ReadonlyArray<GroupHomeTarget>> {
    const targets: GroupHomeTarget[] = [];
    for (const selection of await listExistingConnectedServiceHomeSelections(this.deps.activeServerDir)) {
      if (selection.kind !== 'group') continue;
      const serviceId = ConnectedServiceIdSchema.safeParse(selection.serviceDirectoryName);
      if (!serviceId.success) continue;
      for (const agentDirName of await readConnectedServiceHomeDirectoryNames(selection.directory)) {
        const agentId = resolveCatalogAgentId(agentDirName);
        if (agentId) targets.push({ serviceId: serviceId.data, groupId: selection.selectionId, agentId });
      }
    }
    return targets;
  }

  async reconcileDeletedGroupHomes(input: Readonly<{
    groupExists?: GroupExists;
    resolveGroupDeletionAuthority?: ResolveGroupDeletionAuthority;
  }>): Promise<ReadonlyArray<DeletedHomeCleanupResult>> {
    const resolveGroupDeletionAuthority = input.resolveGroupDeletionAuthority ?? this.deps.resolveGroupDeletionAuthority;
    const groupExists = input.groupExists ?? this.deps.groupExists;
    if (!resolveGroupDeletionAuthority && !groupExists) return [];
    const results: DeletedHomeCleanupResult[] = [];
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
      if ('account' in target) {
        if (!await this.removeHome(key, target)) continue;
        cleaned.push({ cleaned: true, path: target.path });
        continue;
      }
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
      await this.removeHome(key, target);
      cleaned.push({ cleaned: true, path: target.path });
    }
    return cleaned;
  }
}
