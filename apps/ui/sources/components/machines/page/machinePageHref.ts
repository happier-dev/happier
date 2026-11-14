import type { MachinesDoor } from './machinesDoor';
import type { MachinePageTabParams } from './machinePageTabQuery';
import type { MachineSubPageId } from './machineSubPages';
import { machinePageTabQuery } from './machinePageTabQuery';
import type { MachineVitalsNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';

export const MACHINES_COLLECTION_ROOT = '/settings/machines';
export const MACHINES_RAIL_ROOT = '/machines';

export function machinesIndexHref(door: MachinesDoor): typeof MACHINES_RAIL_ROOT | typeof MACHINES_COLLECTION_ROOT {
    return door === 'rail' ? MACHINES_RAIL_ROOT : MACHINES_COLLECTION_ROOT;
}

/** The fleet pages beside the Machines column (pfc-redesign fUpd, fAct), inside the door that opened them. */
export function machineFleetPageHref(door: MachinesDoor, page: 'updates' | 'activity'): string {
    return `${machinesIndexHref(door)}/${page}`;
}

export type MachinePageTarget = Readonly<{ machineId: string; serverId?: string }>;

/** Where a machine resource alert opens, from a push or the Inbox: memory and CPU to Processes sorted by that column, disk to Storage. */
export function machineResourceAlertTab(kind: 'memory_pressure' | 'cpu_busy' | 'disk_nearly_full', volumeId?: string | null): MachinePageTabParams {
    if (kind === 'disk_nearly_full') return volumeId ? { id: 'storage', prepare: 'lowDisk', volumeId } : { id: 'storage' };
    return { id: 'processes', sort: kind === 'cpu_busy' ? 'cpu' : 'memory' };
}

export function machineVitalsNoticeTab(notice: MachineVitalsNotificationV1): MachinePageTabParams {
    return machineResourceAlertTab(notice.kind, notice.kind === 'disk_nearly_full' ? notice.volumeId : null);
}

/** Notice rows, generic Inbox details and push links share the Machine page's tab selection. */
export function machineVitalsNoticeHref(notice: MachineVitalsNotificationV1, serverId?: string): string {
    return machinePageHref({ door: 'rail', target: { machineId: notice.machineId, ...(serverId ? { serverId } : {}) }, tab: machineVitalsNoticeTab(notice) });
}

/** One route owner for both Machines doors, their tabs and pushed sub-pages. */
export function machinePageHref(input: Readonly<{
    door: MachinesDoor;
    target: MachinePageTarget;
    tab?: MachinePageTabParams;
    page?: MachineSubPageId;
}>): `/settings/machines/${string}` | `/machines/${string}` {
    const path = `${machinesIndexHref(input.door)}/${encodeURIComponent(input.target.machineId)}${input.page ? `/${input.page}` : ''}` as const;
    const query: string[] = [];
    const serverId = input.target.serverId?.trim();
    if (serverId) query.push(`serverId=${encodeURIComponent(serverId)}`);
    if (input.tab) {
        for (const [key, value] of Object.entries(machinePageTabQuery(input.tab))) query.push(`${key}=${encodeURIComponent(value)}`);
    }
    return query.length > 0 ? `${path}?${query.join('&')}` : path;
}
