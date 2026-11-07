import * as React from 'react';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { captureServerProfileScopeResolver, getServerProfileLegacyServerIds } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';
import { projectSessionArchiveRow, readSessionArchivePending } from '@/sync/domains/session/listing/sessionArchiveState';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { areSessionMachineTargetInputsEqual, resolveDisplayMachineIdForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { getStorage } from '@/sync/domains/state/storageStore';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
import type { StorageState } from './types';

const EMPTY_RECENT: readonly SessionListRenderableSession[] = Object.freeze([]);
const subscribeInactive = () => () => {};

/** A demanded listing, not a second Session store: retain only this Machine's admitted rows. */
function createMachineRecentListing(serverId: string, machineId: string) {
    const store = getStorage();
    const resolveScopeId = captureServerProfileScopeResolver();
    const homeKeys = [...new Set([serverId, resolveScopeId(serverId), ...getServerProfileLegacyServerIds(serverId)])];
    const members = new Map<string, SessionListRenderableSession>();
    let rows: ReturnType<typeof readSessionListRowsForServerId> | undefined;
    let machineInputs: ReturnType<typeof resolveServerScopedMachines<StorageState['machines'][string]>> | undefined;
    let machineRecords: StorageState['machines'] | undefined;
    let scopedMachines: StorageState['machineListByServerId'] | undefined;
    let machineStatuses: StorageState['machineListStatusByServerId'] | undefined;
    let projects: StorageState['projectAccountRows'] | undefined;
    let archiveOperations: readonly (StorageState['sessionArchiveOperations'][string] | undefined)[] | undefined;
    let visibility: SessionRecordingVisibility | undefined;
    let recent = EMPTY_RECENT;

    const update = (state: StorageState, isVisible: SessionRecordingVisibility, previous?: StorageState) => {
        const nextRows = readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId, resolveScopeId);
        let attributionChanged = rows === undefined || projects !== state.projectAccountRows;
        if (machineRecords !== state.machines || scopedMachines !== state.machineListByServerId
            || machineStatuses !== state.machineListStatusByServerId) {
            const nextInputs = resolveServerScopedMachines({
                serverId, activeServerId: getActiveServerSnapshot().serverId,
                get activeMachines() { return Object.values(state.machines); },
                machineListByServerId: state.machineListByServerId,
                machineListStatusByServerId: state.machineListStatusByServerId,
            }, resolveScopeId);
            attributionChanged ||= !areSessionMachineTargetInputsEqual(machineInputs, nextInputs);
            machineInputs = nextInputs;
            machineRecords = state.machines;
            scopedMachines = state.machineListByServerId;
            machineStatuses = state.machineListStatusByServerId;
        }
        let membershipChanged = false;
        const admit = (id: string) => {
            const row = nextRows?.[id];
            const belongs = row && isUserFacingSession(row) && resolveDisplayMachineIdForSessionFromState({
                state, sessionId: id, serverId, metadata: row.metadata,
            }) === machineId;
            if (belongs) {
                if (members.get(id) !== row) { members.set(id, row); membershipChanged = true; }
            } else if (members.delete(id)) membershipChanged = true;
        };
        if (attributionChanged || nextRows !== rows) {
            const delta = state.sessionListRenderableDelta;
            // The writer's immediate predecessor proves these IDs exhaust this publication,
            // even when publications on other Homes were outside this subscription.
            const incremental = !attributionChanged && previous
                && readSessionListRowsForServerId(previous.sessionListRowsByServerId, serverId, resolveScopeId) === rows
                && delta.revision === previous.sessionListRenderableDelta.revision + 1;
            if (incremental) {
                for (const id of new Set([...delta.changedSessionIds, ...delta.removedSessionIds])) {
                    if (nextRows?.[id] !== rows?.[id]) admit(id);
                }
            } else {
                members.clear();
                for (const id of Object.keys(nextRows ?? {})) admit(id);
                membershipChanged = true;
            }
        }
        const nextArchiveOperations = homeKeys.map(key => state.sessionArchiveOperations?.[key]);
        const archiveChanged = !archiveOperations || nextArchiveOperations.some((bucket, index) => bucket !== archiveOperations?.[index]);
        if (membershipChanged || visibility !== isVisible || archiveChanged) {
            recent = retainShallow(recent, [...members.values()]
                .filter(row => isVisible({ serverId, sessionId: row.id }))
                .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
                .slice(0, 5)
                .map(row => projectSessionArchiveRow(row, readSessionArchivePending(state, { serverId, sessionId: row.id }, resolveScopeId))!));
        }
        rows = nextRows;
        projects = state.projectAccountRows;
        archiveOperations = nextArchiveOperations;
        visibility = isVisible;
        return recent;
    };

    return {
        read: (isVisible: SessionRecordingVisibility) => update(store.getState(), isVisible),
        peek: () => recent,
        subscribe: (notify: () => void) => {
            const stop = store.subscribe((state, previous) => {
                if (!visibility) return;
                const before = recent;
                update(state, visibility, previous);
                if (recent !== before) notify();
            }, {
                sessionListRowsByServerId: homeKeys,
                machineDisplayById: true,
                machineListByServerId: homeKeys,
                machineListStatusByServerId: homeKeys,
                projectAccountRows: true,
                sessionArchiveOperations: homeKeys,
            });
            return () => {
                stop();
                // A retained surface keeps its five displayed rows, not hidden listing demand.
                rows = undefined;
                members.clear();
                machineInputs = undefined;
                machineRecords = undefined;
                scopedMachines = undefined;
                machineStatuses = undefined;
                projects = undefined;
                archiveOperations = undefined;
                visibility = undefined;
            };
        },
    };
}

/** Recent five user-facing Sessions for one exact Home/Machine, with no hidden demand. */
export function useMachineRecentSessions(serverId: string, machineId: string,
    isVisible: SessionRecordingVisibility, enabled: boolean): readonly SessionListRenderableSession[] {
    const profilesGeneration = useServerProfilesGeneration();
    const listing = React.useMemo(() => createMachineRecentListing(serverId, machineId), [serverId, machineId, profilesGeneration]);
    const active = enabled && Boolean(machineId);
    const read = React.useCallback(() => active ? listing.read(isVisible) : listing.peek(), [active, listing, isVisible]);
    return React.useSyncExternalStore(active ? listing.subscribe : subscribeInactive, read, read);
}
