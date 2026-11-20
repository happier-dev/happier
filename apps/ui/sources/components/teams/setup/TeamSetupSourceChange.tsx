import * as React from 'react';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectPendingSharedSetupV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
  findWorkspaceProjectCandidatesV1,
  workspaceAddressFromRefV1,
} from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildProjectRouteHref } from '@/components/projects/detail/projectRouteState';
import { describePendingSharedSetupSummary } from '@/components/projects/projectSetup/PendingSharedSetupRow';
import { useProjectDefinitionInspection } from '@/components/projects/projectSetup/useProjectDefinitionInspection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

const SETUP_READ: ProjectDefinitionInspectRead = { kind: 'setup' };

/** The member's checkout of a listed Team Source on the chosen Machine, by the checkout's own Source provenance. */
export function findTeamSetupSourceCheckout<T extends WorkspaceRefV1>(
  refs: readonly T[],
  input: Readonly<{
    serverId: string;
    machineId: string | null;
    sourceId: string;
    revision: number;
  }>,
): T | null {
  if (!input.machineId) return null;
  return (
    findWorkspaceProjectCandidatesV1(
      refs,
      {
        serverId: input.serverId,
        source: { sourceId: input.sourceId, revision: input.revision },
      },
      { normalizeServerId: resolveServerProfileScopeIdForIdentifier },
    ).find(
      (ref) =>
        'machineId' in ref &&
        ref.machineId === input.machineId &&
        ref.source?.sourceId === input.sourceId,
    ) ?? null
  );
}

/** "Acme changed this repository's shared setup": the checkout owner's pending result, said once, leading to its review. */
export function TeamSetupSourceChangeNotice(
  props: Readonly<{
    sourceId: string;
    teamName: string;
    pending: ProjectPendingSharedSetupV1;
    onReview: () => void;
  }>,
) {
  const adds = describePendingSharedSetupSummary(props.pending.summary);
  return (
    <Item
      testID={`team-setup-source-changed:${props.sourceId}`}
      title={t('teams.join.setupPage.sourceChanged', { team: props.teamName })}
      subtitle={adds || undefined}
      showChevron={false}
      rightElement={
        <RoundButton
          testID={`team-setup-source-changed-review:${props.sourceId}`}
          size="small"
          display="secondary"
          title={t('machinePresets.setup.tab.reviewChanges')}
          onPress={props.onReview}
        />
      }
    />
  );
}

/**
 * Reads the existing per-checkout setup inspection for one listed row (demand-owned, never scheduled, no writes) and
 * shows the daemon's pending shared setup. Review opens the checkout's Scripts page, where the review and apply live.
 */
export const TeamSetupSourceChange = React.memo(function TeamSetupSourceChange(
  props: Readonly<{
    sourceId: string;
    teamName: string;
    checkout: WorkspaceRefV1;
  }>,
) {
  const { checkout } = props;
  const router = useRouter();
  const { binding } = useServerCredentialAccountScopeBinding(checkout.serverId);
  const address = React.useMemo(
    () => workspaceAddressFromRefV1(checkout),
    [checkout],
  );
  const { effectiveDefinition } = useProjectDefinitionInspection(
    address,
    binding,
    SETUP_READ,
  );
  const pending =
    effectiveDefinition?.kind === 'available'
      ? (effectiveDefinition.value.pendingSharedSetup ?? null)
      : null;
  const review = React.useCallback(
    () =>
      router.push(
        buildProjectRouteHref({
          workspaceRefId: checkout.id,
          serverId: checkout.serverId,
          segment: 'scripts',
          activeRootPath: checkout.rootPath,
          defaultRootPath: checkout.rootPath,
        }) as never,
      ),
    [checkout, router],
  );
  return pending ? (
    <TeamSetupSourceChangeNotice
      sourceId={props.sourceId}
      teamName={props.teamName}
      pending={pending}
      onReview={review}
    />
  ) : null;
});
