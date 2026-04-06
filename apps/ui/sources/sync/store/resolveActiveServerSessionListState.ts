import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

import { buildSessionListViewDataWithServerScope } from './buildSessionListViewDataWithServerScope';
import { areSessionListViewItemsEqual } from './sessionListCache';

type ProjectLookupResult = {
    key?: {
        machineId?: string | null;
        rootPath?: string | null;
    } | null;
} | null;

type ActiveServerSessionListSettings = Readonly<{
    groupInactiveSessionsByProject?: boolean;
    sessionListActiveGroupingV1?: 'project' | 'date';
    sessionListInactiveGroupingV1?: 'project' | 'date';
}>;

export type ActiveServerSessionListStateLike = Readonly<{
    sessions: Record<string, Session>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListViewData: SessionListViewItem[] | null;
    machines: Record<string, Machine>;
    machineDisplayById: Record<string, MachineDisplayRenderable>;
    settings: ActiveServerSessionListSettings;
    getProjectForSession?: (sessionId: string) => ProjectLookupResult;
}>;

export function resolveActiveServerSessionListState(params: Readonly<{
    state: ActiveServerSessionListStateLike;
    shouldRebuild: boolean;
}>): Readonly<{
    sessionListViewData: SessionListViewItem[] | null;
}> {
    if (!params.shouldRebuild) {
        return {
            sessionListViewData: params.state.sessionListViewData,
        };
    }

    const rebuilt = buildSessionListViewDataWithServerScope({
        sessions: params.state.sessionListRenderables,
        sessionRecords: params.state.sessions,
        machines: params.state.machineDisplayById,
        machineRecords: params.state.machines,
        groupInactiveSessionsByProject: params.state.settings.groupInactiveSessionsByProject === true,
        activeGroupingV1: params.state.settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: params.state.settings.sessionListInactiveGroupingV1,
        getProjectForSession: params.state.getProjectForSession,
    });

    return {
        sessionListViewData: areSessionListViewItemsEqual(params.state.sessionListViewData, rebuilt)
            ? params.state.sessionListViewData
            : rebuilt,
    };
}
