import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingsV1 } from './connectedAccountPurposeBindings.js';
import type { QualifiedConnectedAccountPurposeV1 } from './connectedAccountPurposeIdentity.js';
import { sameQualifiedConnectedAccountRef } from './qualifiedConnectedAccountPersistence.js';
import { isQualifiedConnectedAccountProfileActiveV4, resolveQualifiedConnectedAccountGroupActiveAccountV4, type QualifiedConnectedAccountProfileV4, type QualifiedConnectedAccountGroupV4 } from './qualifiedConnectedAccountsV4.js';
import type { PluginConnectedAccountAuthenticationV2 } from './pluginConnectedAccountAuthenticationV2.js';
import type { PluginProjectedResourceV2, PluginProjectionInstalledPackageV2 } from '../daemon/contributionRegistryProjection.js';

/** The installed Resource is the declaration authority, shared by setup and Action admission. */
export function readDeclaredConnectedAccountResourcePurposeV1(input: Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  projection: Readonly<{
    installedPackagesById: Readonly<Record<string, Pick<PluginProjectionInstalledPackageV2, 'enabled'>>>;
    resourcesById: Readonly<Record<string, PluginProjectedResourceV2>>;
  }>;
}>) {
  const consumer = input.purpose.consumer;
  if (input.projection.installedPackagesById[consumer.pluginId]?.enabled !== true) return null;
  const resources = Object.values(input.projection.resourcesById).filter(resource =>
    resource.pluginId === consumer.pluginId && resource.id === consumer.localId);
  const declarations = resources.length === 1 ? resources[0]!.connectedAccountPurposes?.filter(declaration =>
    declaration.purpose === input.purpose.purpose) ?? [] : [];
  return declarations.length === 1 ? declarations[0]! : null;
}

/** Read-only projection of one existing selected purpose, never a selection writer. */
export function resolveConnectedAccountPurposeSelectedAccountV1(input: Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  serviceRefs: readonly Readonly<{ pluginId: string; localId: string }>[];
  bindings: QualifiedConnectedAccountPurposeBindingsV1;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  readAuthentication?(service: Readonly<{ pluginId: string; localId: string }>): PluginConnectedAccountAuthenticationV2 | null;
  now: number;
}>): QualifiedConnectedAccountProfileV4 | null {
  const key = qualifiedPurposeKey(input.purpose);
  const target = input.bindings.bindings.find(binding => qualifiedPurposeKey(binding.purpose) === key)?.target;
  if (!target) return null;
  const service = target.kind === 'account' ? target.account.service : target.service;
  if (!input.serviceRefs.some(candidate => candidate.pluginId === service.pluginId && candidate.localId === service.localId)) return null;
  if (target.kind === 'account') return input.accounts.find(account => sameQualifiedConnectedAccountRef(account.ref, target.account)
    && isQualifiedConnectedAccountProfileActiveV4(account, input.now)) ?? null;
  const group = input.groups.find(group => group.ref.service.pluginId === service.pluginId
    && group.ref.service.localId === service.localId && group.ref.groupId === target.groupId);
  const authentication = input.readAuthentication?.(service);
  return group && authentication ? resolveQualifiedConnectedAccountGroupActiveAccountV4({ group, authentication, accounts: input.accounts, now: input.now }) : null;
}
