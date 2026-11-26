import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * Setup reads for a Team belong to the Account that joined it. While another Account is active, the Joined page and the
 * setup page say so in the setup's place instead of reading anything for the wrong Account.
 */
export function TeamSetupOtherAccountNotice(
  props: Readonly<{ testID: string }>,
) {
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="error"
      size="line"
      title={t('teams.join.setupPage.otherAccount')}
    />
  );
}
