import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { ApprovalRequesterThreadCard } from '@/components/approvals/ApprovalRequesterThreadCard';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { listDiscussionRequesterApprovals } from '@/sync/domains/artifacts/approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from '@/dev/testkit/fixtures/discussionRequesterApprovalArtifact';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/**
 * Dev-only: a shared Bot's outward write waiting for the person who asked, drawn by the real
 * ApprovalRequesterThreadCard over the owner testkit's signed requester request. `?state=` picks
 * `mine` (you asked, so you decide), `theirs` (someone else asked, so you see who can act), `done`
 * (executed) or `unknown` (the effect could not be confirmed). The executing Machine is not on this
 * Home, so the card shows its offline/unknown presence as a real one would.
 */
const STATES = ['mine', 'theirs', 'done', 'unknown'] as const;
type SpecimenState = (typeof STATES)[number];

function settleAs(
  state: SpecimenState,
  decider: string,
): ((request: ApprovalRequestV2) => ApprovalRequestV2) | undefined {
  if (state !== 'done' && state !== 'unknown') return undefined;
  return (request) => ({
    ...request,
    status: state === 'done' ? 'executed' : 'outcome_unknown',
    updatedAtMs: Date.now() - 60_000,
    decision: {
      kind: 'approve',
      decidedAtMs: Date.now() - 90_000,
      authority: 'present_user',
      decidingAccountId: decider,
    },
    execution:
      state === 'done'
        ? {
            executedAtMs: Date.now() - 60_000,
            ok: true,
            effectAttempted: true,
            result: { ok: true },
          }
        : {
            executedAtMs: Date.now() - 60_000,
            ok: false,
            effectAttempted: true,
            errorCode: 'approval_execution_outcome_unknown',
            error: 'approval_execution_outcome_unknown',
          },
  });
}

export default function RequesterApprovalsDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  const state =
    STATES.find((candidate) => candidate === params.state) ?? 'mine';
  const scope = useActiveServerAccountScope();
  const approval = React.useMemo(() => {
    if (!scope) return null;
    const requesterAccountId =
      state === 'theirs' ? 'requester-elsewhere' : scope.accountId;
    const artifact = buildDiscussionRequesterApprovalArtifact({
      id: `requester-approval-specimen-${state}`,
      serverId: scope.serverId,
      requesterAccountId,
      summary: 'Rename the release-week Session to "Ship 0.3 notes"',
      settle: settleAs(state, requesterAccountId),
    });
    const [entry] = listDiscussionRequesterApprovals([artifact], {
      serverId: scope.serverId,
      discussionId: 'discussion-1',
    });
    return entry ?? null;
  }, [scope, state]);
  if (!scope || !approval) return null;
  return (
    <ItemList>
      <ItemGroup
        title="Requester approval"
        description="The card in the Discussion thread that asked."
      >
        <ApprovalRequesterThreadCard
          key={state}
          approval={approval}
          serverId={scope.serverId}
        />
      </ItemGroup>
    </ItemList>
  );
}
