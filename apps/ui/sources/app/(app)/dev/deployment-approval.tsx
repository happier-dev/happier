import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { ApprovalIncludedSteps } from '@/components/approvals/ApprovalIncludedSteps';
import { ApprovalSessionContextCard } from '@/components/approvals/ApprovalSessionContextCard';
import {
  DeploymentReviewApprovalFacts,
  describeDeploymentBackupConfigureDecision,
  readDeploymentReviewApproval,
} from '@/components/approvals/DeploymentReviewApprovalFacts';
import {
  readApprovalArtifactTitleInput,
  resolveApprovalRequestTitle,
} from '@/components/approvals/approvalRequestTitle';
import {
  readApprovalRequesterSurface,
  resolveApprovalHomeName,
} from '@/components/approvals/approvalRequesterLabels';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { createDeploymentApprovalArtifact } from '@/dev/testkit/fixtures/deploymentApprovalArtifacts';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

/** A backup destination Test as its host folds it: one included step whose Machine the request decides. */
const BACKUP_TEST_PREVIEW = {
  actionId: 'deployments.backups.configure',
  hostReviewedChildren: { children: [{ action: 'deployments.bindings.set', role: 'backup.bindings' }] },
} as const;

/**
 * Dev-only: a provider Create or Delete review asked from the command line, from the testkit's stored request,
 * through the real owners: the one approval title rule (the page and its tab read it; the tab adds the status,
 * shown here as the meta line), the reviewed facts, and Requested by. `?kind=create|delete|teardown|backupTest`
 * (`backupTest`: the decision title and the included steps the configure review folds);
 * `asker=other` makes another Account the asker, whom this Home cannot name.
 */
export default function DeploymentApprovalDevScreen() {
  const params = useLocalSearchParams<{ kind?: string; asker?: string }>();
  const kind = params.kind === 'delete' || params.kind === 'teardown' ? params.kind : 'create';
  const scope = useActiveServerAccountScope();
  const backupTest = params.kind === 'backupTest'
    ? describeDeploymentBackupConfigureDecision('deployments.backups.configure', { intent: 'test' }) : null;
  const stored = React.useMemo(
    () =>
      scope
        ? createDeploymentApprovalArtifact({
            id: `dev-deployment-${kind}`,
            kind,
            scope,
            requesterAccountId:
              params.asker === 'other' ? 'account-elsewhere' : undefined,
          })
        : null,
    [kind, params.asker, scope],
  );
  if (!scope || !stored) return null;
  if (backupTest) return (
    <ItemList>
      <PageHeader testID="approvals.header" alwaysShowTitle title={backupTest.title} />
      <ApprovalIncludedSteps preview={BACKUP_TEST_PREVIEW} serverId={scope.serverId} testID="dev-deployment-steps" />
    </ItemList>
  );
  const parsed = approvalArtifactBodyMatchesHeaderV1(
    stored.header ?? {},
    stored.body,
  );
  const { title } = resolveApprovalRequestTitle(
    readApprovalArtifactTitleInput(stored, parsed),
  );
  const review = readDeploymentReviewApproval(stored.request);
  return (
    <ItemList>
      <PageHeader
        testID="approvals.header"
        alwaysShowTitle
        title={title}
        description={`${title} · ${formatApprovalStatusLabel(stored.request.status)}`}
      />
      {review ? (
        <DeploymentReviewApprovalFacts
          approval={review}
          serverId={scope.serverId}
          testID="dev-deployment-facts"
        />
      ) : null}
      <ApprovalSessionContextCard
        session={null}
        sessionName={null}
        machineLabel={null}
        serverId={scope.serverId}
        context={null}
        homeName={resolveApprovalHomeName(scope.serverId)}
        requesterSessionId={null}
        requesterAgentId={null}
        requesterAccountId={stored.request.executionOriginV1.accountId ?? null}
        requesterSurface={readApprovalRequesterSurface(stored.request, true)}
      />
    </ItemList>
  );
}
