import * as React from 'react';
import { OfferedChoices } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import type { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import { isOpenAccountNotice, type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { AccountNoticeInvestigationBoundary, useAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { InboxArtifactSourceBoundary, useInboxArtifactItems } from '@/hooks/inbox/useInboxArtifactSource';
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
          refusal: choice.actionId === 'inbox.notice.dismiss',
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
          const presentation = presentActionExecutionFailure(result);
          alertActionFailure({
            reason: presentation.reason,
            code: result.errorCode,
            requestId: result.requestId,
            context: Object.fromEntries(presentation.technicalDetails
              .filter(line => line.key !== 'code' && line.key !== 'requestId')
              .map(line => [line.key, line.value])),
          });
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
export function DeploymentNoticeRecoveryChoices(props: Readonly<{ deploymentId: string; testID: string }>) {
  return (
    <AccountNoticeInvestigationBoundary>
      <InboxArtifactSourceBoundary>
        <DeploymentNoticeRecoveryBody deploymentId={props.deploymentId} testID={props.testID} />
      </InboxArtifactSourceBoundary>
    </AccountNoticeInvestigationBoundary>
  );
}

function DeploymentNoticeRecoveryBody(props: Readonly<{ deploymentId: string; testID: string }>) {
  const { accountNotices } = useInboxArtifactItems();
  const recovery = useAccountNoticeInvestigation();
  const entry = React.useMemo(() => findInboxDeploymentNotice(
    accountNotices.filter(candidate => isOpenAccountNotice(candidate.header)), props.deploymentId,
  ), [accountNotices, props.deploymentId]);
  return entry ? <AccountNoticeRecoveryChoices entry={entry} recovery={recovery} testID={props.testID} /> : null;
}
