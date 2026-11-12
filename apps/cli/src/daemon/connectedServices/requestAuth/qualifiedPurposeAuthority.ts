import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ConnectedAccountServiceKey, QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import { applyProjectedCredentialKindRestrictions } from '@happier-dev/agents';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { ConnectedServiceBindingSelection } from '../parseConnectedServicesBindings';
import type { AgentSpawnQualifiedPurposeBindingSnapshot } from './prepareConnectedAccountRequestAuthForSpawn';

export class ConnectedServiceQualifiedPurposeAuthorityError extends Error {
  readonly code = 'connected_service_qualified_purpose_authority_unavailable' as const;
  readonly reason: 'snapshot_unavailable' | 'selected_service_unrepresented';
  readonly missingServiceIds: readonly ConnectedAccountServiceKey[];

  constructor(params: Readonly<{
    reason: ConnectedServiceQualifiedPurposeAuthorityError['reason'];
    missingServiceIds: readonly ConnectedAccountServiceKey[];
  }>) {
    super(
      `Qualified Connected Account purpose authority is unavailable (${params.missingServiceIds.join(', ')})`,
    );
    this.name = 'ConnectedServiceQualifiedPurposeAuthorityError';
    this.reason = params.reason;
    this.missingServiceIds = Object.freeze([...params.missingServiceIds]);
  }
}

export function assertQualifiedPurposeAuthorityForSelections(params: Readonly<{
  selections: readonly ConnectedServiceBindingSelection[];
  snapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null;
}>): void {
  const purposeSelections = params.selections.flatMap((selection) => (
    selection.kind === 'team_resource' && selection.deliveryMode === 'brokered'
      ? []
      : [selection]
  ));
  if (purposeSelections.length === 0) return;
  const missingServiceIds = purposeSelections.flatMap((selection) => {
    const represented = params.snapshot?.bindings.some((binding) => {
      const service = binding.target.kind === 'account'
        ? binding.target.account.service
        : binding.target.service;
      if (buildQualifiedPluginContributionKey(service) !== selection.serviceId) {
        return false;
      }
      return selection.kind === 'profile'
        ? binding.target.kind === 'account'
          && binding.target.account.accountId === selection.profileId
        : selection.kind === 'group'
          ? binding.target.kind === 'group'
            && binding.target.groupId === selection.groupId
          : binding.target.kind === 'account'
            && binding.target.account.accountId === selection.disclosedMember.accountId;
    }) === true;
    return represented ? [] : [selection.serviceId];
  });
  if (missingServiceIds.length === 0 && params.snapshot) return;
  throw new ConnectedServiceQualifiedPurposeAuthorityError({
    reason: params.snapshot
      ? 'selected_service_unrepresented'
      : 'snapshot_unavailable',
    missingServiceIds,
  });
}

/** Use the inventory owner's credential-kind semantics at profile admission. */
export function assertQualifiedPurposeCredentialCompatibility(params: Readonly<{
  snapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  profile: Pick<QualifiedConnectedAccountProfileV4, 'ref' | 'kind'>;
}>): void {
  const serviceId = buildQualifiedPluginContributionKey(params.profile.ref.service);
  const options = applyProjectedCredentialKindRestrictions({
    optionsByServiceId: { [serviceId]: [{ profileId: params.profile.ref.accountId,
      status: 'connected', kind: params.profile.kind }] },
    connectedAccounts: (params.snapshot?.authorizedPurposes ?? []).flatMap(scope =>
      scope.serviceRefs.map(service => ({ service, credentialKinds: scope.credentialKinds }))),
  });
  if (options[serviceId]?.[0]?.status !== 'unsupported_kind') return;
  throw new PluginError({ code: 'provider_incompatible_with_agent', retryable: false,
    message: 'The selected Connected Account credential kind is not supported by this Agent.',
    details: { requiredCredentialKinds: options[serviceId][0].requiredCredentialKinds ?? [],
      failureCause: { code: 'provider_incompatible_with_agent',
      phase: 'authentication', failureReason: 'permission_denied', retryable: false } },
  });
}
