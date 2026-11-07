import * as React from 'react';

import { MANAGED_MACHINE_DELETION_LEAD_TIME_MS, useManagedMachineDeletionSource,
    type ManagedMachineDeletionEntry } from '@/activity/source/useManagedMachineDeletionSource';
import { updateManagedMachineDeletionNotification } from '../managedMachineDeletionNotification';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { fireAndForget } from '@/utils/system/fireAndForget';

const MachineReminder = React.memo(function MachineReminder({ entry }: Readonly<{ entry: ManagedMachineDeletionEntry }>) {
    React.useEffect(() => {
        fireAndForget(updateManagedMachineDeletionNotification({ ...entry,
            leadTimeMs: MANAGED_MACHINE_DELETION_LEAD_TIME_MS, nowMs: Date.now(),
            identifier: `managed-machine-deletion:${entry.key}`,
            content: reminder => ({ title: entry.name,
                body: t('managedRetention.consequence.deleteAt', { time: formatAsOfTime(reminder.notice.at) }),
                data: { serverId: entry.serverId, managedId: entry.managedId, url: entry.href } }),
        }), { tag: 'ActivityLocalNotificationRuntime.managedMachineDeletion' });
        // The OS keeps the schedule when the app closes; an explicit withdrawn notice cancels it.
    }, [entry]);
    return null;
});

export function ManagedMachineDeletionNotificationRuntime({ serverIds }: Readonly<{ serverIds: readonly string[] }>) {
    const entries = useManagedMachineDeletionSource(serverIds);
    return <>{entries.map(entry => <MachineReminder key={entry.key} entry={entry} />)}</>;
}
