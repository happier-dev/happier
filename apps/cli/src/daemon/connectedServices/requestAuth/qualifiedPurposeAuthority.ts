import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

import type { ConnectedServiceBindingSelection } from '../parseConnectedServicesBindings';
import { resolveFirstPartyConnectedAccountServiceId } from './firstPartyConnectedAccountRequestAuthAdapter';
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
}>): asserts params is Readonly<{
  selections: readonly ConnectedServiceBindingSelection[];
  snapshot: AgentSpawnQualifiedPurposeBindingSnapshot;
}> {
  const missingServiceIds = params.selections.flatMap((selection) => {
    const represented = params.snapshot?.bindings.some((binding) => {
      const service = binding.target.kind === 'account'
        ? binding.target.account.service
        : binding.target.service;
      if (resolveFirstPartyConnectedAccountServiceId(service) !== selection.serviceId) {
        return false;
      }
      return selection.kind === 'profile'
        ? binding.target.kind === 'account'
          && binding.target.account.accountId === selection.profileId
        : binding.target.kind === 'group'
          && binding.target.groupId === selection.groupId;
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
