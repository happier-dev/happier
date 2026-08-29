import {
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
  sameQualifiedConnectedAccountRef,
  type AccountProfile,
  type ConnectedServiceBindingsV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

/**
 * Projects the current authority behind an already-admitted Connected Services
 * binding. This is deliberately a read-only fact: callers retain ownership of
 * the lifecycle decision they make when the fact changes.
 *
 * Account profiles still expose the released V2 scalar service projection,
 * while current bindings carry qualified service keys. Normalize that seam in
 * the Connected Services domain so consumers cannot each reinterpret profile,
 * group, health, and generation state differently.
 */
export function createConnectedServiceBindingAuthorityFingerprint(params: Readonly<{
  bindings: ConnectedServiceBindingsV1 | null;
  connectedServices: AccountProfile['connectedServicesV2'];
  credentialRevisions?: AccountProfile['connectedServiceCredentialRevisionsV1'];
}>): string {
  if (!params.bindings) return 'unbound';

  const servicesByQualifiedKey = new Map<
    string,
    AccountProfile['connectedServicesV2'][number]
  >();
  for (const service of params.connectedServices) {
    const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(service.serviceId);
    if (serviceKey && !servicesByQualifiedKey.has(serviceKey)) {
      servicesByQualifiedKey.set(serviceKey, service);
    }
  }
  const credentialRevisionsByQualifiedServiceAndProfile = new Map<string, string>();
  for (const revision of params.credentialRevisions ?? []) {
    const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(revision.serviceId);
    if (!serviceKey) continue;
    credentialRevisionsByQualifiedServiceAndProfile.set(
      JSON.stringify([serviceKey, revision.profileId]),
      revision.credentialRevision,
    );
  }
  const authority = Object.entries(params.bindings.bindingsByServiceId)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([serviceId, binding]) => {
      if (binding.source === 'native') {
        return { serviceId, source: 'native' as const };
      }

      const service = servicesByQualifiedKey.get(serviceId) ?? null;
      const profiles = service?.profiles ?? [];
      const readProfileAuthority = (profileId: string | null) => {
        const profile = profileId
          ? profiles.find((candidate) => candidate.profileId === profileId) ?? null
          : null;
        return {
          profileId,
          credentialRevision: profileId === null
            ? null
            : credentialRevisionsByQualifiedServiceAndProfile.get(
                JSON.stringify([serviceId, profileId]),
              ) ?? null,
          usable: profile !== null
            && isConnectedServiceCredentialHealthStatusUsable(
              normalizeConnectedServiceCredentialHealthStatus(profile.status),
            ),
        };
      };

      if (binding.selection !== 'group') {
        return {
          serviceId,
          source: 'connected' as const,
          selection: 'profile' as const,
          ...readProfileAuthority(binding.profileId),
        };
      }

      const group = service?.groups.find((candidate) => candidate.groupId === binding.groupId) ?? null;
      const activeProfileId = group?.activeProfileId ?? null;
      return {
        serviceId,
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: binding.groupId,
        boundProfileId: binding.profileId ?? null,
        generation: group?.generation ?? null,
        ...readProfileAuthority(activeProfileId),
      };
    });

  return stableJsonStringify(authority);
}

/**
 * Projects one selected Connected Account source through the same authority
 * domain-owned V4 projection. The selected target is already owned by the
 * qualified purpose binding; consumers retain only the authority-bearing
 * fields of that exact account/group instead of fingerprinting every Account
 * credential and presentation row.
 */
export function createConnectedAccountTargetAuthorityFingerprint(params: Readonly<{
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
  accounts: AccountProfile['connectedAccountsV4'];
  groups: AccountProfile['connectedAccountGroupsV4'];
}>): string {
  if (!params.target) return 'unbound';
  const projectAccount = (account: AccountProfile['connectedAccountsV4'][number] | null) => (
    account === null
      ? null
      : {
          ref: account.ref,
          status: account.status,
          authenticationModeId: account.authenticationModeId,
          configurationReady: account.configurationReady,
          configurationRevision: account.configurationRevision,
          revisionSemantics: account.revisionSemantics,
          credentialRevision: account.credentialRevision,
          expiresAt: account.expiresAt ?? null,
        }
  );
  if (params.target.kind === 'account') {
    const targetAccount = params.target.account;
    const account = params.accounts.find((candidate) => (
      sameQualifiedConnectedAccountRef(candidate.ref, targetAccount)
    )) ?? null;
    return stableJsonStringify({ kind: 'account', account: projectAccount(account) });
  }
  const targetService = params.target.service;
  const targetGroupId = params.target.groupId;
  const group = params.groups.find((candidate) => (
    candidate.ref.service.pluginId === targetService.pluginId
    && candidate.ref.service.localId === targetService.localId
    && candidate.ref.groupId === targetGroupId
  )) ?? null;
  const activeAccount = group?.activeConnectedAccountId
    ? params.accounts.find((candidate) => (
        candidate.ref.service.pluginId === targetService.pluginId
        && candidate.ref.service.localId === targetService.localId
        && candidate.ref.accountId === group.activeConnectedAccountId
      )) ?? null
    : null;
  return stableJsonStringify({
    kind: 'group',
    group: group === null
      ? null
      : {
          ref: group.ref,
          incarnation: group.incarnation,
          policy: group.policy,
          activeConnectedAccountId: group.activeConnectedAccountId,
          generation: group.generation,
          runtimeStateRevision: group.runtimeStateRevision,
          state: group.state,
          members: group.members,
        },
    activeAccount: projectAccount(activeAccount),
  });
}
