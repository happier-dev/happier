import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { MACHINES_THIS_COMPUTER_ROUTE } from '../collection/machineCollectionModel';

import { useThisComputerServiceSummary } from './useThisComputerServiceSummary';

/**
 * This computer's background service where a page would otherwise be empty (Add a machine › This machine): its state
 * and its one operation, Install, Start or Repair, with Details on Settings › This machine. While nothing needs the
 * person, it is the way to that page, never a blank pane.
 */
export function ThisComputerServiceNotice(props: Readonly<{ testID: string }>) {
  const router = useRouter();
  const summary = useThisComputerServiceSummary();
  const openDetails = React.useCallback(
    () => router.push(MACHINES_THIS_COMPUTER_ROUTE),
    [router],
  );
  if (summary?.needsYou) {
    return (
      <AttentionBanner
        testID={props.testID}
        title={summary.title ?? t('settingsMachines.thisComputerNotConnected')}
        description={summary.error ?? summary.description ?? undefined}
        action={
          summary.action
            ? {
                label: summary.action.label,
                onPress: summary.action.run,
                disabled: summary.action.disabled,
                loading: summary.busy,
                testID: `${props.testID}.action`,
              }
            : null
        }
        secondaryAction={{
          label: t('common.details'),
          onPress: openDetails,
          testID: `${props.testID}.details`,
        }}
      />
    );
  }
  return (
    <Item
      testID={`${props.testID}.open`}
      icon={<Icon name="laptop" size={20} />}
      title={t('machine.thisComputer.openThisComputer')}
      subtitle={t('settingsMachines.thisComputerRowSubtitle')}
      onPress={openDetails}
    />
  );
}
