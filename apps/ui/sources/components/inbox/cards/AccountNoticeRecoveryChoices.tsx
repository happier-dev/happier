import * as React from 'react';
import { OfferedChoices } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import type { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import type { AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { Modal } from '@/modal';
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
        if (!result.ok)
          Modal.alert(t('common.error'), t('errors.unknownError'));
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
