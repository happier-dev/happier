import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingsV1, type QualifiedConnectedAccountPurposeBindingTargetV1 } from './connectedAccountPurposeBindings.js';
import type { QualifiedConnectedAccountPurposeV1 } from './connectedAccountPurposeIdentity.js';
import { sameQualifiedConnectedAccountRef } from './qualifiedConnectedAccountPersistence.js';
import { isQualifiedConnectedAccountProfileActiveV4, resolveQualifiedConnectedAccountGroupActiveAccountV4 } from './qualifiedConnectedAccountProjectionsV4.js';
import type { QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountGroupV4 } from './qualifiedConnectedAccountsV4.js';
import type { PluginConnectedAccountAuthenticationV2 } from './pluginConnectedAccountAuthenticationV2.js';
import type { PluginProjectedActionV2, PluginProjectedMachineProvisionerEntryV1, PluginProjectedResourceV2, PluginProjectionInstalledPackageV2 } from '../daemon/contributionRegistryProjection.js';
import type { PluginAccountExecutionSelectionV1 } from '../plugins/availability/accountExecution.js';
import { resolvePluginActionConnectedAccountUseRequestsV2, resolvePluginResourceConnectedAccountUseRequestsV2 } from '../plugins/manifest/v2.js';
import { qualifyPluginContributionReferenceV1 } from '../plugins/contributionKey.js';

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

export type ConnectedAccountNativePurposeDeclarationInputV1 = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  machineProvisionersById: Readonly<Record<string, PluginProjectedMachineProvisionerEntryV1>>;
  projection: Parameters<typeof readDeclaredConnectedAccountResourcePurposeV1>[0]['projection'] & Readonly<{
    actionsById?: Readonly<Record<string, PluginProjectedActionV2>>;
  }>;
}>;

/** Canonical declaration lookup for host setup and default-target admission. */
export function readDeclaredConnectedAccountPurposeV1(input: ConnectedAccountNativePurposeDeclarationInputV1 | Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  accountSelection: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
}>) {
  if ('accountSelection' in input) {
    const manifest = input.accountSelection.manifest;
    const { consumer, purpose } = input.purpose;
    if (manifest.id !== consumer.pluginId) return null;
    const projectUseRequests = (requests: ReturnType<typeof resolvePluginActionConnectedAccountUseRequestsV2>,
      consumerKind: 'resource' | 'action' | 'machineProvisioner') => (
      requests?.filter(entry => entry.request.id === purpose)
        .map(entry => ({ purpose, consumerKind,
          serviceRefs: entry.request.scope.serviceRefs.map(reference => qualifyPluginContributionReferenceV1(reference, manifest.id)) })) ?? []
    );
    const provisioners = manifest.contributes.machineProvisioners.filter(entry => entry.id === consumer.localId);
    const candidates = [
      ...projectUseRequests(resolvePluginResourceConnectedAccountUseRequestsV2(manifest, consumer.localId), 'resource'),
      ...(provisioners.length === 1 ? projectUseRequests(
        resolvePluginActionConnectedAccountUseRequestsV2(manifest, provisioners[0]!.actions.acquire), 'machineProvisioner') : []),
      ...projectUseRequests(resolvePluginActionConnectedAccountUseRequestsV2(manifest, consumer.localId), 'action'),
    ];
    // Account and native origins share the same one-consumer purpose identity.
    return candidates.length === 1 ? candidates[0]! : null;
  }
  const resource = readDeclaredConnectedAccountResourcePurposeV1(input);
  const consumer = input.purpose.consumer;
  if (input.projection.installedPackagesById[consumer.pluginId]?.enabled !== true) return null;
  const provisioners = Object.values(input.machineProvisionersById).filter(entry =>
    entry.pluginId === consumer.pluginId && entry.definition.id === consumer.localId);
  const declarations = provisioners.length === 1 ? provisioners[0]!.connectedAccountPurposes?.filter(declaration =>
    declaration.purpose === input.purpose.purpose) ?? [] : [];
  const actions = Object.values(input.projection.actionsById ?? {}).filter(entry =>
    entry.pluginId === consumer.pluginId && entry.id === consumer.localId && entry.available !== false);
  const actionDeclarations = actions.length === 1 ? actions[0]!.connectedAccountPurposes?.filter(declaration =>
    declaration.purpose === input.purpose.purpose) ?? [] : [];
  // A qualified purpose identifies one consumer, including across contribution families.
  if (Number(Boolean(resource)) + declarations.length + actionDeclarations.length !== 1) return null;
  return resource ? { ...resource, consumerKind: 'resource' as const }
    : declarations.length === 1 ? { ...declarations[0]!, consumerKind: 'machineProvisioner' as const }
    : { ...actionDeclarations[0]!, consumerKind: 'action' as const };
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

/** Configuration admission shares one declaration/target decision across Account and Machine hosts. */
export function resolveConnectedAccountPurposeDefaultTargetV1(input: Readonly<{
  declaration: Parameters<typeof readDeclaredConnectedAccountPurposeV1>[0];
  accountServiceSelection?: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }> | Readonly<{ kind: 'unavailable' }>;
  target: QualifiedConnectedAccountPurposeBindingTargetV1;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups: readonly QualifiedConnectedAccountGroupV4[];
  readAuthentication?(service: Readonly<{ pluginId: string; localId: string }>): PluginConnectedAccountAuthenticationV2 | null;
  now: number;
}>): QualifiedConnectedAccountProfileV4 | null {
  const declared = readDeclaredConnectedAccountPurposeV1(input.declaration);
  // Provisioner setup supplies an explicit launch input; it never writes a default.
  if (!declared || declared.consumerKind === 'machineProvisioner') return null;
  const purpose = input.declaration.purpose;
  let readAuthentication = input.readAuthentication;
  if ('accountSelection' in input.declaration) {
    const consumer = input.declaration.accountSelection;
    readAuthentication = service => {
      const selection = service.pluginId === consumer.manifest.id ? consumer : input.accountServiceSelection;
      return selection?.kind === 'available' && selection.manifest.id === service.pluginId
        ? selection.manifest.contributes.connectedAccountDescriptors.find(descriptor => descriptor.id === service.localId)?.authentication ?? null
        : null;
    };
  }
  return resolveConnectedAccountPurposeSelectedAccountV1({ ...input, purpose, readAuthentication, serviceRefs: declared.serviceRefs,
    bindings: { v: 1, bindings: [{ purpose, target: input.target }] } });
}
