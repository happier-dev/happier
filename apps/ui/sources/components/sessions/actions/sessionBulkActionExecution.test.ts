import { describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { stopSessionAndMaybeArchive } from '../sessionStopArchiveFlow';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';

import {
    SESSION_BULK_ACTION_IDS,
    executeSessionBulkAction,
    groupSessionBulkTargetsByServer,
    type SessionBulkActionRequest,
    type SessionBulkActionTarget,
} from './sessionBulkActionExecution';
import { buildSessionBulkActionResultSummary } from './sessionActionResultMessages';

const workspaceA = {
    t: 'workspaceRef',
    serverId: 'server-a',
    workspaceRefId: 'workspace-a',
} satisfies SessionFolderWorkspaceRefV1;

const workspaceB: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceRef',
    serverId: 'server-a',
    workspaceRefId: 'workspace-b',
};

function target(input: Partial<SessionBulkActionTarget> & Pick<SessionBulkActionTarget, 'key' | 'sessionId'>): SessionBulkActionTarget {
    return {
        serverId: 'server-a',
        active: false,
        archived: false,
        canUnarchive: true,
        canStop: true,
        canArchive: true,
        pinned: false,
        tags: [],
        readState: undefined,
        ...input,
    };
}

describe('executeSessionBulkAction', () => {
    it('moves unique selected entities across projects in one Home while retaining partial outcomes', async () => {
        const setSessionFolderAssignment = vi.fn(async ({ target: entry }: { target: SessionBulkActionTarget }) => {
            if (entry.sessionId === 'failed') throw new Error('permission_denied');
        });
        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.moveToFolder, folderId: 'launch', destinationServerId: 'server-a' },
            targets: [target({ key: 'base', sessionId: 'same', canMoveToFolder: true, workspace: workspaceA }),
                target({ key: 'mirror', sessionId: 'same', canMoveToFolder: true, workspace: workspaceA }),
                target({ key: 'other-project', sessionId: 'other', canMoveToFolder: true, workspace: workspaceB }),
                target({ key: 'failed', sessionId: 'failed', canMoveToFolder: true }),
                target({ key: 'foreign', serverId: 'server-b', sessionId: 'foreign', canMoveToFolder: true })],
            context: { foldersFeatureDecision: { state: 'enabled' }, setSessionFolderAssignment },
        });
        expect(setSessionFolderAssignment.mock.calls.map(([entry]) => entry.target.sessionId)).toEqual(['same', 'other', 'failed']);
        expect(result.succeeded.map(entry => entry.target.sessionId)).toEqual(['same', 'other']);
        expect(result.failed.map(entry => entry.target.sessionId)).toEqual(['failed']);
        expect(result.skipped.map(entry => entry.target.sessionId)).toEqual(['foreign']);
    });

    it('uses the caller archive failure message for an inactive target with an owned timeout code', async () => {
        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.archive },
            targets: [target({ key: 'server-a:timeout', sessionId: 'timeout' })],
            context: {
                archiveErrorMessage: 'Archivierung fehlgeschlagen',
                archiveSession: async () => ({ success: false, code: 'session_archive_timeout' }),
            },
        });

        expect(result.failed).toMatchObject([{
            target: { sessionId: 'timeout' },
            reasonCode: 'session_archive_timeout',
            reason: 'Archivierung fehlgeschlagen',
        }]);
        expect(result.remainingSelectedKeys).toEqual(['server-a:timeout']);
    });

    it('treats empty target selections as a no-op for every bulk action', async () => {
        const actions: SessionBulkActionRequest[] = [
            { id: SESSION_BULK_ACTION_IDS.stop },
            { id: SESSION_BULK_ACTION_IDS.archive },
            { id: SESSION_BULK_ACTION_IDS.unarchive },
            { id: SESSION_BULK_ACTION_IDS.markRead },
            { id: SESSION_BULK_ACTION_IDS.markUnread },
            { id: SESSION_BULK_ACTION_IDS.pin },
            { id: SESSION_BULK_ACTION_IDS.unpin },
            { id: SESSION_BULK_ACTION_IDS.tagsAdd, tags: ['important'] },
            { id: SESSION_BULK_ACTION_IDS.tagsRemove, tags: ['important'] },
            { id: SESSION_BULK_ACTION_IDS.tagsSet, tags: ['important'] },
            {
                id: SESSION_BULK_ACTION_IDS.moveToFolder,
                folderId: 'folder-a',
                destinationServerId: workspaceA.serverId,
            },
        ];

        for (const action of actions) {
            const result = await executeSessionBulkAction({
                action,
                targets: [],
                context: {},
            });

            expect(result).toMatchObject({
                actionId: action.id,
                targetCount: 0,
                results: [],
                succeeded: [],
                failed: [],
                skipped: [],
                cancelled: [],
                remainingSelectedKeys: [],
            });
            expect(result.progress).toMatchObject({
                total: 0,
                completed: 0,
                status: 'idle',
            });
        }
    });

    it('pins selected sessions through the organization pin operation', async () => {
        const setSessionPin = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.pin },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1' }),
                target({ key: 'server-a:s2', sessionId: 's2', pinned: true }),
            ],
            context: {
                setSessionPin,
            },
        });

        expect(setSessionPin).toHaveBeenCalledTimes(2);
        expect(setSessionPin).toHaveBeenNthCalledWith(1, {
            target: expect.objectContaining({ key: 'server-a:s1', sessionId: 's1' }),
            pinned: true,
        });
        expect(setSessionPin).toHaveBeenNthCalledWith(2, {
            target: expect.objectContaining({ key: 'server-a:s2', sessionId: 's2' }),
            pinned: true,
        });
        expect(result.succeeded.map((entry) => entry.target.key)).toEqual(['server-a:s1', 'server-a:s2']);
        expect(result.failed).toEqual([]);
        expect(result.remainingSelectedKeys).toEqual([]);
    });

    it('removes tags from selected sessions through organization tag assignment operations', async () => {
        const setSessionTagAssignments = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: {
                id: SESSION_BULK_ACTION_IDS.tagsRemove,
                tags: ['important', 'later'],
            },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', tags: ['important', 'keep'] }),
                target({ key: 'server-a:s2', sessionId: 's2', tags: ['later'] }),
            ],
            context: {
                setSessionTagAssignments,
            },
        });

        expect(setSessionTagAssignments).toHaveBeenCalledTimes(2);
        expect(setSessionTagAssignments).toHaveBeenNthCalledWith(1, {
            target: expect.objectContaining({ key: 'server-a:s1', sessionId: 's1' }),
            tags: ['keep'],
        });
        expect(setSessionTagAssignments).toHaveBeenNthCalledWith(2, {
            target: expect.objectContaining({ key: 'server-a:s2', sessionId: 's2' }),
            tags: [],
        });
        expect(result.succeeded.map((entry) => entry.target.key)).toEqual(['server-a:s1', 'server-a:s2']);
    });

    it('captures per-target network failures without aborting the batch and respects the concurrency limit', async () => {
        let running = 0;
        let maxRunning = 0;
        const stopSession = vi.fn(async (entry: SessionBulkActionTarget) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await new Promise((resolve) => setTimeout(resolve, 0));
            running -= 1;
            if (entry.sessionId === 's2') {
                throw new Error('stop exploded');
            }
            return { success: true };
        });

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.stop },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', active: true }),
                target({ key: 'server-a:s2', sessionId: 's2', active: true }),
                target({ key: 'server-a:s3', sessionId: 's3', active: true }),
            ],
            context: {
                concurrencyLimit: 2,
                stopSession,
            },
        });

        expect(maxRunning).toBeLessThanOrEqual(2);
        expect(stopSession).toHaveBeenCalledTimes(3);
        expect(result.succeeded.map((entry) => entry.target.sessionId)).toEqual(['s1', 's3']);
        expect(result.failed.map((entry) => [entry.target.sessionId, entry.reason])).toEqual([
            ['s2', 'stop exploded'],
        ]);
        expect(result.remainingSelectedKeys).toEqual(['server-a:s2']);
    });

    it('archives active sessions through the stop-and-archive flow and archives inactive sessions directly', async () => {
        const effects: Array<{ sessionId: string; effect: string }> = [];
        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.archive },
            targets: [
                target({ key: 'server-a:active', sessionId: 'active', active: true, pinned: true }),
                target({ key: 'server-a:inactive', sessionId: 'inactive', active: false }),
            ],
            context: {
                concurrencyLimit: 1,
                archiveSession: async entry => { effects.push({ sessionId: entry.sessionId, effect: 'archive' }); return { success: true }; },
                stopSession: async entry => { effects.push({ sessionId: entry.sessionId, effect: 'stop' }); return { success: true }; },
                stopSessionAndMaybeArchive,
            },
        });
        expect(effects).toEqual([
            { sessionId: 'active', effect: 'stop' },
            { sessionId: 'active', effect: 'archive' },
            { sessionId: 'inactive', effect: 'archive' },
        ]);
        expect(result.failed).toEqual([]);
        expect(result.succeeded.map(entry => entry.target.sessionId)).toEqual(['active', 'inactive']);
    });

    it('captures all optional Homes before queued archive effects can change focus and rejects repeated targets', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://bulk-archive-owner.example', name: 'Bulk owner' });
        const other = await upsertServerProfile({ serverUrl: 'https://bulk-archive-other.example', name: 'Bulk other' });
        await setActiveServerId(home.id);
        let release!: () => void;
        let issued!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const entered = new Promise<void>(resolve => { issued = resolve; });
        const effects: Array<{ sessionId: string; serverId: string | null | undefined }> = [];
        const pending = executeSessionBulkAction({ action: { id: SESSION_BULK_ACTION_IDS.archive },
            targets: ['first', 'queued'].map(sessionId => target({ key: sessionId, sessionId, serverId: undefined })),
            context: { concurrencyLimit: 1, archiveSession: async entry => {
                effects.push({ sessionId: entry.sessionId, serverId: entry.serverId });
                if (entry.sessionId === 'first') { issued(); await blocked; }
                return { success: true };
            } },
        });
        try {
            await entered;
            await setActiveServerId(other.id);
            const repeated = await executeSessionBulkAction({ action: { id: SESSION_BULK_ACTION_IDS.archive },
                targets: [target({ key: 'repeat', sessionId: 'first', serverId: home.id })],
                context: { archiveSession: async () => { throw new Error('Repeated archive reached network'); } },
            });
            expect(repeated.skipped.map(entry => entry.reasonCode)).toEqual(['archive_pending']);
        } finally { release(); }
        expect((await pending).failed).toEqual([]);
        expect(effects).toEqual([{ sessionId: 'first', serverId: home.id }, { sessionId: 'queued', serverId: home.id }]);
        expect(storage.getState().sessionArchiveOperations).toEqual({});
    });

    it('fails an active archive before effects when its exact Home-qualified address is unavailable', async () => {
        const archiveSession = vi.fn(async () => ({ success: true }));
        const stopSession = vi.fn(async () => ({ success: true }));

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.archive },
            targets: [target({ key: 'unqualified', sessionId: 'active', serverId: null, active: true })],
            context: {
                archiveSession,
                stopSession,
                stopSessionAndMaybeArchive,
            },
        });

        expect(stopSession).not.toHaveBeenCalled();
        expect(archiveSession).not.toHaveBeenCalled();
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.reasonCode).toBe('missing_session_address');
    });

    it('fails bulk move-to-folder closed when the sessions.folders feature is unavailable', async () => {
        const setSessionFolderAssignment = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: {
                id: SESSION_BULK_ACTION_IDS.moveToFolder,
                folderId: 'folder-a',
                destinationServerId: workspaceA.serverId,
            },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1' }),
                target({ key: 'server-a:s2', sessionId: 's2' }),
            ],
            context: {
                foldersFeatureDecision: null,
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).not.toHaveBeenCalled();
        expect(result.skipped.map((entry) => entry.reasonCode)).toEqual([
            'feature_disabled',
            'feature_disabled',
        ]);
        expect(result.remainingSelectedKeys).toEqual(['server-a:s1', 'server-a:s2']);
    });

    it('moves selected sessions to one chosen folder through the headless assignment path', async () => {
        const setSessionFolderAssignment = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: {
                id: SESSION_BULK_ACTION_IDS.moveToFolder,
                folderId: 'folder-a',
                destinationServerId: workspaceA.serverId,
            },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', canMoveToFolder: true, workspace: workspaceA }),
                target({ key: 'server-a:s2', sessionId: 's2', canMoveToFolder: true, workspace: workspaceA }),
            ],
            context: {
                foldersFeatureDecision: { state: 'enabled' },
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).toHaveBeenCalledTimes(2);
        expect(setSessionFolderAssignment).toHaveBeenNthCalledWith(1, {
            target: expect.objectContaining({ sessionId: 's1' }),
            folderId: 'folder-a',
        });
        expect(setSessionFolderAssignment).toHaveBeenNthCalledWith(2, {
            target: expect.objectContaining({ sessionId: 's2', serverId: 'server-a' }),
            folderId: 'folder-a',
        });
        expect(result.succeeded.map((entry) => entry.target.key)).toEqual(['server-a:s1', 'server-a:s2']);
    });

    it('moves only targets admitted by the canonical per-item folder eligibility decision', async () => {
        const setSessionFolderAssignment = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: {
                id: SESSION_BULK_ACTION_IDS.moveToFolder,
                folderId: 'folder-a',
                destinationServerId: workspaceA.serverId,
            },
            targets: [
                target({
                    key: 'server-a:external',
                    sessionId: 'external',
                    canMoveToFolder: true,
                    workspace: workspaceA,
                }),
                target({ key: 'server-a:unscoped', sessionId: 'unscoped', canMoveToFolder: false }),
            ],
            context: {
                foldersFeatureDecision: { state: 'enabled' },
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).toHaveBeenCalledTimes(1);
        expect(setSessionFolderAssignment).toHaveBeenCalledWith({
            target: expect.objectContaining({ sessionId: 'external' }),
            folderId: 'folder-a',
        });
        expect(result.succeeded.map((entry) => entry.target.key)).toEqual(['server-a:external']);
        expect(result.skipped.map((entry) => [entry.target.key, entry.reasonCode])).toEqual([
            ['server-a:unscoped', 'folder_move_unavailable'],
        ]);
    });

    it('preflights every target against the destination Home before starting bulk section writes', async () => {
        const setSessionFolderAssignment = vi.fn(async () => undefined);

        const result = await executeSessionBulkAction({
            action: {
                id: SESSION_BULK_ACTION_IDS.moveToFolder,
                folderId: 'folder-a',
                destinationServerId: workspaceA.serverId,
            },
            targets: [
                target({ key: 'server-a:same-1', sessionId: 'same-1', canMoveToFolder: true, workspace: workspaceA }),
                target({ key: 'server-b:different', sessionId: 'different', serverId: 'server-b', canMoveToFolder: true, workspace: workspaceB }),
                target({ key: 'server-a:same-2', sessionId: 'same-2', canMoveToFolder: true, workspace: workspaceA }),
            ],
            context: {
                foldersFeatureDecision: { state: 'enabled' },
                setSessionFolderAssignment,
            },
        });

        expect(setSessionFolderAssignment).toHaveBeenCalledTimes(2);
        expect(setSessionFolderAssignment).toHaveBeenNthCalledWith(1, {
            target: expect.objectContaining({ sessionId: 'same-1' }),
            folderId: 'folder-a',
        });
        expect(setSessionFolderAssignment).toHaveBeenNthCalledWith(2, {
            target: expect.objectContaining({ sessionId: 'same-2' }),
            folderId: 'folder-a',
        });
        expect(result.succeeded.map((entry) => entry.target.key)).toEqual([
            'server-a:same-1',
            'server-a:same-2',
        ]);
        expect(result.skipped.map((entry) => [entry.target.key, entry.reasonCode])).toEqual([
            ['server-b:different', 'folder_destination_scope_mismatch'],
        ]);
    });

    it('cancels queued network work without invoking operations for cancelled targets', async () => {
        const stopSession = vi.fn(async () => ({ success: true }));

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.stop },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', active: true }),
                target({ key: 'server-a:s2', sessionId: 's2', active: true }),
            ],
            context: {
                cancelSignal: { isCancelled: () => true },
                stopSession,
            },
        });

        expect(stopSession).not.toHaveBeenCalled();
        expect(result.cancelled.map((entry) => entry.target.key)).toEqual(['server-a:s1', 'server-a:s2']);
        expect(result.remainingSelectedKeys).toEqual(['server-a:s1', 'server-a:s2']);
    });

    it('emits progress snapshots for long-running network work', async () => {
        const snapshots: Array<{ succeeded: number; failed: number; running: number; queued: number }> = [];

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.markRead },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', readState: 'unread' }),
                target({ key: 'server-a:s2', sessionId: 's2', readState: 'unread' }),
            ],
            context: {
                concurrencyLimit: 1,
                setManualReadState: async () => ({ success: true }),
                onProgress: (snapshot) => {
                    snapshots.push({
                        succeeded: snapshot.succeeded,
                        failed: snapshot.failed,
                        running: snapshot.running,
                        queued: snapshot.queued,
                    });
                },
            },
        });

        expect(result.succeeded).toHaveLength(2);
        expect(snapshots.at(-1)).toEqual({ succeeded: 2, failed: 0, running: 0, queued: 0 });
        expect(snapshots.some((snapshot) => snapshot.running === 1)).toBe(true);
    });

    it('skips read-state actions for targets whose read state is unavailable', async () => {
        const setManualReadState = vi.fn(async () => ({ success: true }));

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.markRead },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', archived: true, readState: undefined }),
            ],
            context: {
                setManualReadState,
            },
        });

        expect(setManualReadState).not.toHaveBeenCalled();
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]).toMatchObject({
            target: expect.objectContaining({ key: 'server-a:s1' }),
            reasonCode: 'read_state_unavailable',
        });
        expect(result.remainingSelectedKeys).toEqual(['server-a:s1']);
    });

    it('counts intentionally skipped network targets as skipped progress, not failures', async () => {
        const snapshots: Array<{ failed: number; skipped: number; running: number; queued: number }> = [];

        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.stop },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', active: false }),
            ],
            context: {
                stopSession: async () => ({ success: true }),
                onProgress: (snapshot) => {
                    snapshots.push({
                        failed: snapshot.failed,
                        skipped: snapshot.skipped,
                        running: snapshot.running,
                        queued: snapshot.queued,
                    });
                },
            },
        });

        expect(result.skipped.map((entry) => entry.reasonCode)).toEqual(['session_inactive']);
        expect(snapshots.at(-1)).toEqual({ failed: 0, skipped: 1, running: 0, queued: 0 });
    });

    it('skips lifecycle actions when target permissions deny the action', async () => {
        const stopSession = vi.fn(async () => ({ success: true }));
        const archiveSession = vi.fn(async () => ({ success: true }));
        const unarchiveSession = vi.fn(async () => ({ success: true }));

        const stopResult = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.stop },
            targets: [target({ key: 'server-a:active', sessionId: 'active', active: true, canStop: false })],
            context: { stopSession },
        });
        const archiveResult = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.archive },
            targets: [target({ key: 'server-a:inactive', sessionId: 'inactive', active: false, archived: false, canArchive: false })],
            context: { archiveSession },
        });
        const unarchiveResult = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.unarchive },
            targets: [target({ key: 'server-a:archived', sessionId: 'archived', active: false, archived: true, canUnarchive: false })],
            context: { unarchiveSession },
        });

        expect(stopSession).not.toHaveBeenCalled();
        expect(archiveSession).not.toHaveBeenCalled();
        expect(unarchiveSession).not.toHaveBeenCalled();
        expect(stopResult.skipped.map((entry) => entry.reasonCode)).toEqual(['permission_denied']);
        expect(archiveResult.skipped.map((entry) => entry.reasonCode)).toEqual(['permission_denied']);
        expect(unarchiveResult.skipped.map((entry) => entry.reasonCode)).toEqual(['permission_denied']);
    });

    it('skips lifecycle actions when target permission facts are absent', async () => {
        const stopSession = vi.fn(async () => ({ success: true }));
        const archiveSession = vi.fn(async () => ({ success: true }));
        const unarchiveSession = vi.fn(async () => ({ success: true }));

        const stopResult = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.stop },
            targets: [target({ key: 'server-a:active', sessionId: 'active', active: true, canStop: undefined })],
            context: { stopSession },
        });
        const archiveResult = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.archive },
            targets: [target({ key: 'server-a:inactive', sessionId: 'inactive', active: false, archived: false, canArchive: undefined })],
            context: { archiveSession },
        });
        const unarchiveResult = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.unarchive },
            targets: [target({ key: 'server-a:archived', sessionId: 'archived', active: false, archived: true, canUnarchive: undefined })],
            context: { unarchiveSession },
        });

        expect(stopSession).not.toHaveBeenCalled();
        expect(archiveSession).not.toHaveBeenCalled();
        expect(unarchiveSession).not.toHaveBeenCalled();
        expect(stopResult.skipped.map((entry) => entry.reasonCode)).toEqual(['permission_denied']);
        expect(archiveResult.skipped.map((entry) => entry.reasonCode)).toEqual(['permission_denied']);
        expect(unarchiveResult.skipped.map((entry) => entry.reasonCode)).toEqual(['permission_denied']);
    });
});

describe('groupSessionBulkTargetsByServer', () => {
    it('groups targets by server while preserving first-seen server order', () => {
        const groups = groupSessionBulkTargetsByServer([
            target({ key: 'server-b:s1', sessionId: 's1', serverId: 'server-b' }),
            target({ key: 'server-a:s2', sessionId: 's2', serverId: 'server-a' }),
            target({ key: 'server-b:s3', sessionId: 's3', serverId: 'server-b' }),
            target({ key: 'local:s4', sessionId: 's4', serverId: null }),
        ]);

        expect(groups.map((group) => ({
            serverId: group.serverId,
            sessionIds: group.targets.map((entry) => entry.sessionId),
        }))).toEqual([
            { serverId: 'server-b', sessionIds: ['s1', 's3'] },
            { serverId: 'server-a', sessionIds: ['s2'] },
            { serverId: null, sessionIds: ['s4'] },
        ]);
    });
});

describe('buildSessionBulkActionResultSummary', () => {
    it('classifies partial success without depending on exact copy', async () => {
        const result = await executeSessionBulkAction({
            action: { id: SESSION_BULK_ACTION_IDS.unarchive },
            targets: [
                target({ key: 'server-a:s1', sessionId: 's1', archived: true }),
                target({ key: 'server-a:s2', sessionId: 's2', archived: true }),
            ],
            context: {
                unarchiveSession: async (entry) => (
                    entry.sessionId === 's2'
                        ? { success: false, message: 'nope' }
                        : { success: true }
                ),
            },
        });

        expect(buildSessionBulkActionResultSummary(result)).toMatchObject({
            kind: 'partial',
            succeededCount: 1,
            failedCount: 1,
            skippedCount: 0,
            cancelledCount: 0,
        });
    });
});
