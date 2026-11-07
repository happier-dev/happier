import * as React from 'react';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import {
  readApprovalArtifactTitleInput,
  useApprovalRequestTitle,
} from '@/components/approvals/approvalRequestTitle';
import { useArtifact } from '@/sync/store/hooks';
import { t } from '@/text';

/**
 * A Run request waiting on approval, in the existing outcome region: named by the request's own
 * title ("Post the answers to …"), the same one its Inbox row and page use, with one way to open it. Until
 * the request's body is read it says only that it waits for the person.
 */
export const WorkflowRunPublicationRequestRow = React.memo(
  function WorkflowRunPublicationRequestRow(
    props: Readonly<{
      artifactId: string;
      serverId: string | null | undefined;
      onOpen: () => void;
      testID: string;
      /** What waits on this request in the Run (the item it belongs to), so sibling requests read apart. */
      context?: string;
    }>,
  ) {
    const artifact = useArtifact(props.artifactId);
    const matchedBody = React.useMemo(
      () =>
        artifact && typeof artifact.body === 'string'
          ? approvalArtifactBodyMatchesHeaderV1(
              artifact.header ?? {},
              artifact.body,
            )
          : null,
      [artifact],
    );
    const title = useApprovalRequestTitle(
      readApprovalArtifactTitleInput(artifact, matchedBody),
      props.serverId ?? null,
    );
    const named = artifact !== null && title.title.trim().length > 0;
    return (
      <ActionApprovalPendingNotice
        testID={props.testID}
        message={t('approvals.waitingForYou')}
        // The item leads, so two requests from one Action read apart ("Alex · Invite a participant…").
        summary={named ? (props.context ? `${props.context} \u00b7 ${title.title}` : title.title) : null}
        openLabel={t('inbox.work.detail.openApproval')}
        onOpenApproval={props.onOpen}
      />
    );
  },
);
