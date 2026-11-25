import * as React from 'react';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
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
 * Reads the existing per-checkout setup inspection for one listed row (demand-owned, never scheduled, no writes): the
 * daemon's pending shared setup, which Review opens on the checkout's Scripts page where the review and apply live,
 * and the checkout's current setup readiness, which lets a row say Ready after a cold return without a run.
 */
export function useTeamSetupCheckoutSetup(source: ProjectSourceV1, checkout: WorkspaceRefV1 | null): Readonly<{
  pending: ProjectPendingSharedSetupV1 | null;
  ready: boolean;
  /** The inspection has answered (or there is nothing to read): the row's shape no longer waits on it. */
  settled: boolean;
  onReview: () => void;
}> {
  const router = useRouter();
  const { binding, resolution } = useServerCredentialAccountScopeBinding(checkout?.serverId);
  const address = React.useMemo(
    () => (checkout ? workspaceAddressFromRefV1(checkout) : null),
    [checkout],
  );
  // The listed Source already carries the publication metadata. Only a changed
  // setup attachment invalidates the checkout owner's inspection.
  const setup = source.attachments?.find((attachment) => attachment.purpose === 'setup');
  const publication = setup ? JSON.stringify([source.id, setup.ref.artifactId, setup.ref.serverId,
    setup.contentRevision.headerVersion, setup.contentRevision.bodyVersion]) : null;
  const { read, effectiveDefinition } = useProjectDefinitionInspection(
    address,
    binding,
    SETUP_READ,
    publication,
  );
  const pending =
    effectiveDefinition?.kind === 'available'
      ? (effectiveDefinition.value.pendingSharedSetup ?? null)
      : null;
  const readiness = read && !('error' in read) ? read.value.setupReadiness ?? null : null;
  const onReview = React.useCallback(() => {
    if (!checkout) return;
    router.push(
      buildProjectRouteHref({
        workspaceRefId: checkout.id,
        serverId: checkout.serverId,
        segment: 'scripts',
        activeRootPath: checkout.rootPath,
        defaultRootPath: checkout.rootPath,
      }) as never,
    );
  }, [checkout, router]);
  return {
    pending,
    // The checkout owner's own fact: its reviewed setup is current, or it has none to run.
    ready: !pending && (readiness?.kind === 'current' || readiness?.kind === 'notRequired'),
    // Answered, or nothing will be read: no checkout, or a Home that resolved without a current credential.
    settled: !address || read !== null || (resolution.kind !== 'resolving' && !binding?.isCurrent()),
    onReview,
  };
}
