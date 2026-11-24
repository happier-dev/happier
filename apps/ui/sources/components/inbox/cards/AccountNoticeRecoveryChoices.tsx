import * as React from 'react';
import { OfferedChoices } from '@happier-dev/plugin-ui/presentation';
import { INBOX_NOTICE_DISMISS_ACTION_ID_V1 } from '@happier-dev/protocol/actions/appShellActionIdsV1';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { useUnistyles } from 'react-native-unistyles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import type { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import { isOpenAccountNotice, type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { AccountNoticeInvestigationBoundary, useAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useDeploymentNoticeHeaders } from '@/hooks/inbox/useDeploymentNoticeHeaders';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { findInboxDeploymentNotice } from '@/components/inbox/inboxItemFocus';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { t } from '@/text';

type NoticeRecovery = Pick<
  ReturnType<typeof createAccountNoticeInvestigation>,
  'readRecoveryChoices' | 'runRecoveryChoice'
>;

/**
 * Domain adapter: a notice's recovery choices (roll back, or keep and fix forward) as the Inbox's one set of
 * offered decisions. Which choices exist and whether a press still applies stay with the notice owner.
 */
export const AccountNoticeRecoveryChoices = React.memo(
  function AccountNoticeRecoveryChoices(
    props: Readonly<{
      entry: AccountNoticeArtifact;
      recovery: NoticeRecovery;
      testID: string;
      onReview?: (artifactId: string) => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const [busyIndex, setBusyIndex] = React.useState<number | null>(null);
    const choices = props.recovery.readRecoveryChoices(props.entry);
    const offered = React.useMemo(
      () =>
        choices.map((choice, index) => ({
          id: String(index),
          label: choice.label,
          available: true,
          // Keeping the release is the quiet way out; the rollbacks are the decisions.
          refusal: choice.actionId === INBOX_NOTICE_DISMISS_ACTION_ID_V1,
        })),
      [choices],
    );
    if (offered.length === 0) return null;
    const choose = async (id: string) => {
      const index = Number(id);
      setBusyIndex(index);
      try {
        const result = await props.recovery.runRecoveryChoice(
          props.entry,
          index,
        );
        if (!result.ok) {
          const presentation = choices[index]?.actionId === DEPLOYMENT_ROLLBACK_ACTION_ID_V1
            ? presentActionFailureOutcome(result, 'deployment') : presentActionExecutionFailure(result);
          alertActionFailure({
            reason: presentation.reason ?? result.error,
            code: result.errorCode,
            requestId: result.requestId,
            context: Object.fromEntries(presentation.technicalDetails
              .filter(line => line.key !== 'code' && line.key !== 'requestId')
              .map(line => [line.key, line.value])),
          });
        } else if (props.onReview) {
          const review = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
          if (review.success) props.onReview(review.data.artifactId);
        }
      } finally {
        setBusyIndex(null);
      }
    };
    return (
      <OfferedChoices
        theme={presentationTheme}
        choices={offered}
        primaryId={null}
        disabled={busyIndex !== null}
        busyChoiceId={busyIndex === null ? null : String(busyIndex)}
        unavailableReason=""
        feedbackPlaceholder=""
        cancelLabel={t('common.cancel')}
        onChoose={(id) => {
          void choose(id);
        }}
        testID={props.testID}
      />
    );
  },
);

/**
 * A deployment receipt's notice decision: the open notice that points at this receipt offers its recovery choices
 * here, the same list its Inbox row offers. The receipt is the notice's one page (Inbox, push and links all land on
 * it), so its header carries them. Mounts the small Account notice owners a receipt outside the Inbox lacks.
 */
type DeploymentNoticeRecoveryProps = Readonly<{
  scope: ServerAccountScope | null;
  environmentId: string;
  deploymentId: string;
  testID: string;
  /**
   * The receipt's own way back, shown only while the notice offers no decision of its own: a notice that offers a
   * rollback is that rollback, so the page never shows two (PAGE-ACCEPT-176 R14-D5).
   */
  fallback?: React.ReactNode;
  onReview: (artifactId: string) => void;
}>;

export function DeploymentNoticeRecoveryChoices(props: DeploymentNoticeRecoveryProps) {
  return (
    <AccountNoticeInvestigationBoundary>
      <DeploymentNoticeRecoveryBody {...props} />
    </AccountNoticeInvestigationBoundary>
  );
}

function DeploymentNoticeRecoveryBody(props: DeploymentNoticeRecoveryProps) {
  const { items } = useDeploymentNoticeHeaders(props.scope, props.environmentId, true, props.deploymentId);
  const recovery = useAccountNoticeInvestigation();
  const entry = findInboxDeploymentNotice(items.filter(candidate => isOpenAccountNotice(candidate.header)), props.deploymentId);
  const decides = entry !== null && recovery.readRecoveryChoices(entry)
    .some(choice => choice.actionId !== INBOX_NOTICE_DISMISS_ACTION_ID_V1);
  return <>
    {entry ? <AccountNoticeRecoveryChoices entry={entry} recovery={recovery} testID={props.testID} onReview={props.onReview} /> : null}
    {decides ? null : props.fallback ?? null}
  </>;
}
