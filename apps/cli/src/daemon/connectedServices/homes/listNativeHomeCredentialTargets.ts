import { dirname, join, relative } from 'node:path';
import type { QualifiedConnectedAccountRef, QualifiedConnectedAccountPurposeBindingV1 } from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { readCurrentCatalogHook } from '@/agent/catalog/runtimeEntry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import { CatalogAgentNotInstalledError } from '@/agent/catalog/registry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { readConnectedServiceHomeDirectoryNames } from './inventory';
import { CONNECTED_SERVICE_GROUPS_HOME_SEGMENT, resolveConnectedServiceAccountHomesDir, resolveConnectedServiceGroupHomeDir, resolveConnectedServiceHomeDir } from './resolveConnectedServiceHomeDir';
import { resolveConnectedServiceNativeHomeTargetRoot } from '../materialize/resolveConnectedServiceNativeHomeTarget';

function resolveHomeAgentId(name: string): CatalogAgentId | null {
  const agentId = resolveCatalogAgentId(name);
  if (!agentId && readCurrentContributionRegistry().unavailableAgentPluginsByBackendId?.[name]) {
    throw new CatalogAgentNotInstalledError(name);
  }
  return agentId;
}

/** Old pool homes have no member provenance. Both selected and pool homes retain
 * history and deliberate noncredential configuration when credentials are revoked. */
export async function listNativeHomeCredentialTargets(input: Readonly<{
  activeServerDir: string;
  account: QualifiedConnectedAccountRef;
}>): Promise<readonly Readonly<{
  groupId: string | null;
  agentId: CatalogAgentId;
  path: string;
  secretEntries: readonly string[];
}>[]> {
  const targets: Array<{ groupId: string | null; agentId: CatalogAgentId; path: string; secretEntries: readonly string[] }> = [];
  const serviceId = buildQualifiedPluginContributionKey(input.account.service);
  const accountRoot = resolveConnectedServiceAccountHomesDir({ activeServerDir: input.activeServerDir,
    serviceId, profileId: input.account.accountId });
  const selections: Array<{ directory: string; target: QualifiedConnectedAccountPurposeBindingV1['target'] }> = [
    { directory: accountRoot, target: { kind: 'account', account: input.account } },
  ];
  const groups = join(dirname(accountRoot), CONNECTED_SERVICE_GROUPS_HOME_SEGMENT);
  for (const groupId of await readConnectedServiceHomeDirectoryNames(groups)) {
    selections.push({ directory: join(groups, groupId), target: { kind: 'group', service: input.account.service, groupId } });
  }
  for (const selection of selections) {
    const group = selection.directory;
    const homes: Array<{ agentId: CatalogAgentId; path: string }> = [];
    for (const name of await readConnectedServiceHomeDirectoryNames(group)) {
      if (name === '.quarantine') {
        for (const entry of await readConnectedServiceHomeDirectoryNames(join(group, name))) {
          // The existing quarantine owner writes <time>-<agent>[-<collision>].
          const original = entry.replace(/^\d+-/u, '');
          const agentId = resolveHomeAgentId(original) ?? resolveHomeAgentId(original.replace(/-\d+$/u, ''));
          if (agentId) homes.push({ agentId, path: join(group, name, entry) });
        }
      } else {
        const agentId = resolveHomeAgentId(name);
        if (agentId) homes.push({ agentId, path: join(group, name) });
      }
    }
    for (const home of homes) {
      const descriptor = await readCurrentCatalogHook(home.agentId, entry => entry.getConnectedServiceStateSharingDescriptor?.());
      if (!descriptor) throw new CatalogAgentNotInstalledError(home.agentId);
      if (!descriptor.nativeHome || descriptor.authIsolation.mode !== 'materialized_home') continue;
      const nativeRoot = resolveConnectedServiceNativeHomeTargetRoot({ agentId: home.agentId,
        activeServerDir: input.activeServerDir, nativeHome: descriptor.nativeHome,
        target: selection.target });
      if (!nativeRoot) continue; // Invocation-scoped homes have no durable directory.
      const target = selection.target;
      const homeRoot = target.kind === 'account'
        ? resolveConnectedServiceHomeDir({ activeServerDir: input.activeServerDir, serviceId,
          profileId: target.account.accountId, agentId: home.agentId })
        : resolveConnectedServiceGroupHomeDir({ activeServerDir: input.activeServerDir,
          serviceId, groupId: target.groupId, agentId: home.agentId });
      targets.push({ ...home, groupId: target.kind === 'group' ? target.groupId : null,
        path: join(home.path, relative(homeRoot, nativeRoot)),
        secretEntries: descriptor.authIsolation.secretEntries });
    }
  }
  return targets;
}
