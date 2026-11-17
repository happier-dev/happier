import * as React from 'react';
import type { ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { readApprovalAutomaticConsentCanAllowV1 } from '@happier-dev/protocol/actions/executor/automaticApprovalContinuation';
import { readActionAutomationSkipReasonV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { projectApprovalArtifactAccountActor } from '@/sync/domains/artifacts/approvalArtifactAccountActor';
import { useApprovalAccountLabel } from './useApprovalAccountLabel';

/** Both card families consume the request they already hold; this projection never fetches it again. */
export function useApprovalAutomaticChecksPresentation(input: Readonly<{
  request: ApprovalRequestV2 | TargetActionApprovalRequestV1 | null;
  serverId: string | null;
  scope: ServerAccountScope | null;
  artifactId: string;
  accessGrants?: ArtifactAccessGrantsListResponseV1 | null;
  unavailable?: boolean;
}>) {
  const { request, serverId, artifactId, accessGrants } = input;
  const automaticCheckSkips = React.useMemo(() => request?.automaticChecks?.notices.flatMap(notice =>
    notice.code === 'action_automation_skipped' ? [{ notice, reason: readActionAutomationSkipReasonV1(notice) }] : [],
  ) ?? [], [request]);
  const executionAccountId = request?.requesterConfirmation?.executionAccountId;
  const executionAccountActor = React.useMemo(() => projectApprovalArtifactAccountActor({
    artifactId, serverId, accountId: executionAccountId, accessGrants: accessGrants ?? null,
  }), [accessGrants, artifactId, executionAccountId, serverId]);
  const automaticChecksExecutionAccountName = useApprovalAccountLabel(serverId, executionAccountId, 'value', executionAccountActor);
  return {
    automaticCheckSkips,
    automaticChecksExecutionAccountName,
    canAllow: input.unavailable !== true && input.scope !== null && readApprovalAutomaticConsentCanAllowV1(
      request, { surface: 'ui', authority: 'present_user', runtimeAccountId: input.scope.accountId },
    ),
  };
}

export type ApprovalAutomaticChecksPresentation = ReturnType<typeof useApprovalAutomaticChecksPresentation>;
