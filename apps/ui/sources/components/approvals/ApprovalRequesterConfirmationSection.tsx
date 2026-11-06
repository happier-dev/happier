import * as React from 'react';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { ApprovalOperationActorLine } from './ApprovalOperationActorLine';

/**
 * Whether the viewer is the one person who may decide a shared Bot's requester-bound request. An
 * unknown viewer is never entitled; the decision owner re-admits the present person regardless.
 */
export function isApprovalRequesterViewer(
  subject: ApprovalRequesterConfirmationV1 | null | undefined,
  /** The viewer's scope as resolved for the Home that asked (aliases already applied). */
  viewerScope: ServerAccountScope | null,
): boolean {
  return Boolean(subject && viewerScope && viewerScope.accountId === subject.requesterAccountId);
}

/** The viewer's current credential scope on the Home that asked; retained identity never grants Confirm. */
export function useApprovalRequesterViewer(
  subject: ApprovalRequesterConfirmationV1 | null | undefined,
  /** This device's resolved profile id for the approval Home, never the creator device's saved id. */
  viewerServerId: string | null,
): boolean {
  const { binding } = useServerCredentialAccountScopeBinding(
    subject ? viewerServerId : null,
  );
  const viewerScope = binding?.isCurrent() ? binding.scope : null;
  return isApprovalRequesterViewer(subject, viewerScope);
}

/** One Account named as this viewer may see it: You, a known name, or a generic person. Never guessed. */
export function useApprovalAccountLabel(
  serverId: string | null,
  accountId: string | undefined,
  /** The viewer named inside a sentence ("confirmed by you") instead of as a row value ("You"). */
  form: 'value' | 'sentence' = 'value',
): string | null {
  const { viewerScope, actor } = useKnownAccountActor(serverId, accountId);
  if (!accountId) return null;
  if (viewerScope?.accountId === accountId) {
    return form === 'sentence' ? t('session.collaboration.discussion.attribution.you') : t('message.accountActorYou');
  }
  return actor
    ? resolveAccountActorPresentation(actor, viewerScope).name
    : form === 'sentence'
      ? t('session.collaboration.discussion.attribution.anotherPerson')
      : t('detailPages.approval.requester.anotherPerson');
}

/**
 * C7 requester confirmation, layered into the approval page: who asked (the only person who may
 * confirm) and, once decided, who decided; a receipt adds the credential the operation used, from
 * its admitted evidence alone. The page's decision bar
 * is offered only to the requester; everyone else reads who can act here instead of a button.
 */
export const ApprovalRequesterConfirmationSection = React.memo(
  function ApprovalRequesterConfirmationSection(
    props: Readonly<{
      subject: ApprovalRequesterConfirmationV1;
      /** This device's resolved profile id for the approval Home. */
      serverId: string | null;
      open: boolean;
      decision: Readonly<{
        kind: 'approve' | 'reject';
        decidingAccountId?: string;
      }> | null;
      /** The settled receipt's admitted credential uses; absent evidence draws nothing. */
      operationCredentialUses?: readonly ActionOperationCredentialUseV1[];
    }>,
  ) {
    const serverId = props.serverId;
    const entitled = useApprovalRequesterViewer(props.subject, serverId);
    const requester = useApprovalAccountLabel(
      serverId,
      props.subject.requesterAccountId,
    );
    const decider = useApprovalAccountLabel(
      serverId,
      props.decision?.decidingAccountId,
    );
    const requesterName =
      requester ?? t('detailPages.approval.requester.anotherPerson');
    const description = !props.open
      ? undefined
      : entitled
        ? t('detailPages.approval.requester.descriptionYou')
        : t('detailPages.approval.requester.descriptionOther', {
            name: requesterName,
          });

    return (
      <ItemGroup
        testID="approvals.requester-confirmation"
        title={t('detailPages.approval.requester.title')}
        description={description}
      >
        <Item
          testID="approvals.requester-confirmation.asked-by"
          title={t('detailPages.approval.requester.askedBy')}
          detail={requesterName}
          mode="info"
          showChevron={false}
        />
        {props.decision && decider ? (
          <Item
            testID="approvals.requester-confirmation.decided-by"
            title={
              props.decision.kind === 'approve'
                ? t('detailPages.approval.requester.confirmedBy')
                : t('detailPages.approval.requester.declinedBy')
            }
            detail={decider}
            mode="info"
            showChevron={false}
          />
        ) : props.open && !entitled ? (
          <Item
            testID="approvals.requester-confirmation.waiting"
            title={t('detailPages.approval.requester.waitingFor', {
              name: requesterName,
            })}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {props.operationCredentialUses?.length ? (
          <SectionContentRow>
            <ApprovalOperationActorLine
              uses={props.operationCredentialUses}
              serverId={serverId ?? props.subject.personaSessionRef.serverId}
            />
          </SectionContentRow>
        ) : null}
      </ItemGroup>
    );
  },
);
