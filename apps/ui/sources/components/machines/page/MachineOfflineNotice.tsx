import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

/**
 * What an offline Machine means on one tab of its page, in the one form every tab uses (lab `rv` OS 3: a quiet
 * banner above what the machine last reported). The page header's presence already says the machine is offline
 * ("Offline · Oct 13"), so this never says it again: its title is what that means here ("Its storage shows here
 * when it's back."), and Try again, when the tab can retry, sits at its end.
 */
export function MachineOfflineNotice(
  props: Readonly<{
    testID: string;
    title: string;
    description?: string;
    retry?: Readonly<{
      onPress: () => void;
      loading?: boolean;
      testID?: string;
    }> | null;
  }>,
) {
  const { retry } = props;
  return (
    <AttentionBanner
      testID={props.testID}
      tone="neutral"
      title={props.title}
      {...(props.description ? { description: props.description } : {})}
      action={
        retry
          ? {
              label: t('machineVitals.states.tryAgain'),
              ...(retry.testID ? { testID: retry.testID } : {}),
              onPress: retry.onPress,
              loading: retry.loading === true,
              disabled: retry.loading === true,
            }
          : null
      }
    />
  );
}
