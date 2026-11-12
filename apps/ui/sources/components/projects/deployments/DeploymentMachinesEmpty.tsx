import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * What a deploy surface with no Machine to offer says, from the Machine list owner's own state: still reading, a read
 * that failed (with Retry), or truly none (`empty`). An unread list never reads as "no Machine".
 */
export function DeploymentMachinesEmpty(props: Readonly<{ serverId: string; testID: string; empty: React.ReactNode }>): React.ReactNode {
  const settled = useIsMachineListSettled(props.serverId);
  const status = useMachineListStatusForServer(props.serverId);
  if (status === 'error' || status === 'signedOut') {
    return <SurfaceStateCard testID={`${props.testID}.machinesUnavailable`} size="line" kind="unavailable"
      title={t('settingsMachines.unreadableTitle', { home: resolveHomeDisplayLabel(getServerProfileById(props.serverId), props.serverId) })}
      action={{ label: t('common.retry'), onPress: () => {
        fireAndForget(sync.refreshMachines({ serverId: props.serverId }), { tag: 'DeploymentMachinesEmpty.retry' });
      } }} />;
  }
  if (!settled) {
    return <SurfaceStateCard testID={`${props.testID}.machinesLoading`} size="line" kind="loading" title={t('common.loading')} />;
  }
  return props.empty;
}
