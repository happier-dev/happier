import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export function TailnetConnectionWarning({ intent, testID }: Readonly<{ intent: 'join' | 'leave'; testID: string }>) {
  return (
    <ItemGroup surface="none">
      <AttentionBanner
        testID={testID}
        placement="inline"
        tone="warning"
        announce="alert"
        title={t('machineDetailPage.network.tailnetWarningTitle')}
        description={t(intent === 'join'
          ? 'machineDetailPage.network.tailnetJoinWarning'
          : 'machineDetailPage.network.tailnetLeaveWarning')}
      />
    </ItemGroup>
  );
}
