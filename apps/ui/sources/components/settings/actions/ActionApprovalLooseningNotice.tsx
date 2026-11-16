import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { t } from '@/text';

import type { ActionApprovalLooseningNoticeData } from './resolveActionSettingsControlState';
import { useActionPolicyWriter } from './useActionPolicyWriter';
import type { ActionSettingsTarget } from './actionSettingsTarget';

/**
 * The one warning shown when a permission-changing Action is Allowed on a surface or scope: agents
 * could then loosen their own limits without asking. Settings → Actions, Environment Permissions and
 * Machine scoped preferences all render this component, at the top of the section that holds the
 * Allowed choice, so the warning reads the same everywhere (R23).
 *
 * Whether it shows, and which exact key Keep Ask first restores, come from
 * `resolveActionApprovalLooseningNoticeData`; this component only presents that data and submits the
 * revert through the canonical policy Action. It never classifies an Action itself.
 */
export const ActionApprovalLooseningNotice = React.memo(
  function ActionApprovalLooseningNotice(
    props: Readonly<{
      testID: string;
      notice: ActionApprovalLooseningNoticeData;
      /** A scope-specific sentence ("On vps-1, …"); the shared sentence otherwise. */
      description?: string;
      disabled?: boolean;
      /** Injected by `ItemGroup`, which owns the section's row dividers. */
      showDivider?: boolean;
      /** A profile page reverts the profile's own row, not the Account's. */
      target?: ActionSettingsTarget;
    }>,
  ) {
    const writePolicy = useActionPolicyWriter(props.target);
    const [reverting, setReverting] = React.useState(false);
    const { keepAskFirst } = props.notice;
    const handleKeepAskFirst = React.useCallback(() => {
      setReverting(true);
      void writePolicy(keepAskFirst).finally(() => setReverting(false));
    }, [keepAskFirst, writePolicy]);

    return (
      <SectionContentRow showDivider={props.showDivider}>
        <AttentionBanner
          testID={props.testID}
          placement="inline"
          tone="warning"
          title={t('settingsActions.loosening.title')}
          description={props.description ?? t('settingsActions.loosening.body')}
          accessibilityLiveRegion="polite"
          action={{
            label: t('settingsActions.loosening.keepAskFirst'),
            onPress: handleKeepAskFirst,
            disabled: props.disabled,
            loading: reverting,
          }}
        />
      </SectionContentRow>
    );
  },
);
