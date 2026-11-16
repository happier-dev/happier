import * as React from 'react';
import { Platform } from 'react-native';

import { useManagedMachineDeletionSource, useManagedMachineDeletionLeadTime,
    type ManagedMachineDeletionEntry } from '@/activity/source/useManagedMachineDeletionSource';
import { updateManagedMachineDeletionNotification } from '../managedMachineDeletionNotification';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isDesktopHost } from '@/utils/platform/desktopHost';

const MachineReminder = React.memo(function MachineReminder({ entry, leadTimeMs }: Readonly<{ entry: ManagedMachineDeletionEntry; leadTimeMs: number }>) {
    React.useEffect(() => {
        const controller = new AbortController();
        fireAndForget(updateManagedMachineDeletionNotification({ ...entry,
            leadTimeMs, nowMs: Date.now(),
            identifier: `managed-machine-deletion:${entry.key}`,
            content: reminder => ({ title: entry.name,
                body: t('managedRetention.consequence.deleteAt', { time: formatAsOfTime(reminder.notice.at) }),
                data: { serverId: entry.serverId, accountId: entry.accountId, managedId: entry.managedId, url: entry.href } }),
        }, Platform.OS === 'web' ? {
            channel: isDesktopHost() ? 'desktop' : 'web', signal: controller.signal,
        } : undefined), { tag: 'ActivityLocalNotificationRuntime.managedMachineDeletion' });
        // Document deadlines retire with this entry; native OS schedules survive app closure.
        return () => controller.abort();
    }, [entry, leadTimeMs]);
    return null;
});

export function ManagedMachineDeletionNotificationRuntime({ serverIds }: Readonly<{ serverIds: readonly string[] }>) {
    const entries = useManagedMachineDeletionSource(serverIds);
    const resolveLeadTime = useManagedMachineDeletionLeadTime(entries);
    return <>{entries.map(entry => {
        const leadTimeMs = resolveLeadTime(entry);
        return leadTimeMs === null ? null : <MachineReminder key={entry.key} entry={entry} leadTimeMs={leadTimeMs} />;
    })}</>;
}
