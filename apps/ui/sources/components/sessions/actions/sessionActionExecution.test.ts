import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { createSessionActionTarget } from './sessionActionContext';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
} from './sessionActionIds';
import { executeSessionAction } from './sessionActionExecution';
import { executeSessionBulkAction, SESSION_BULK_ACTION_IDS } from './sessionBulkActionExecution';
import { isSessionArchivePending, stopSessionAndMaybeArchive } from '../sessionStopArchiveFlow';
import { createDeferred } from '@/dev/testkit';

function createSession(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 'session_1',
        active: false,
        archivedAt: null,
        owner: 'user_1',
        accessLevel: undefined,
        seq: 4,
        lastViewedSessionSeq: 3,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 1,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

function createTarget(overrides: Partial<SessionListRenderableSession> = {}) {
    const session = createSession(overrides);
    return createSessionActionTarget({
        session,
        serverId: 'server_1',
        currentUserId: 'user_1',
        isConnected: true,
        isPinned: true,
    });
}

describe('delete eligibility at execution', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(['active', 'preserved-terminal'] as const)('rejects a stale target after the session becomes %s', async (state) => {
        const serverId = getActiveServerSnapshot().serverId;
        const session = createSessionFixture({ id: 'delete-after-confirmation', archivedAt: 123, presence: 0, serverId });
        const target = createSessionActionTarget({ session, serverId });
        expect(target.canDelete).toBe(true);
        const latestSession = state === 'active'
            ? { ...session, active: true, archivedAt: null }
            : createSessionFixture({
                ...session,
                metadata: {
                    path: '/tmp/project',
                    host: 'local',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1: { v: 1, state: 'unknown', observedAt: 124, reason: 'attachment_changed' },
                    },
                },
            });
        storage.setState({ sessions: { [session.id]: latestSession }, sessionListRenderables: {} });
        // apiSocket is the HTTP transport boundary; eligibility and deletion remain real.
        const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response('{"success":true}'));

        await expect(executeSessionAction({ actionId: SESSION_ACTION_DELETE_ID, target })).rejects.toBeInstanceOf(HappyError);
        expect(request).not.toHaveBeenCalled();
    });

    it('uses the current list projection when terminal metadata hydration is deferred', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const session = createSessionFixture({ id: 'delete-cache-only-update', archivedAt: 123, presence: 0, serverId });
        const target = createSessionActionTarget({ session, serverId });
        const latest = createSessionFixture({
            ...session,
            metadata: {
                path: '/tmp/project',
                host: 'local',
                terminal: {
                    mode: 'zellij',
                    controlServiceabilityV1: { v: 1, state: 'unknown', observedAt: 124, reason: 'attachment_changed' },
                },
            },
        });
        storage.setState({
            sessions: { [session.id]: session },
            sessionListRenderables: { [session.id]: buildSessionListRenderableFromSession(latest) },
        });
        const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response('{"success":true}'));

        await expect(executeSessionAction({ actionId: SESSION_ACTION_DELETE_ID, target })).rejects.toBeInstanceOf(HappyError);
        expect(request).not.toHaveBeenCalled();
    });

    it('still deletes an eligible inactive session that is not archived', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const session = createSessionFixture({ id: 'delete-inactive', archivedAt: null, presence: 0, serverId });
        storage.setState({ sessions: { [session.id]: session }, sessionListRenderables: {} });
        const request = vi.spyOn(apiSocket, 'request').mockResolvedValue(new Response('{"success":true}'));

        await executeSessionAction({ actionId: SESSION_ACTION_DELETE_ID, target: createSessionActionTarget({ session, serverId }) });

        expect(request).toHaveBeenCalledWith(`/v1/sessions/${session.id}`, { method: 'DELETE' });
    });
});

describe('executeSessionAction', () => {
    beforeEach(() => {
        vi.mocked(Modal.confirm).mockClear();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
    });

    it.each([
        [SESSION_ACTION_ARCHIVE_ID, 'session.archive', 'archiveSession'],
        [SESSION_ACTION_UNARCHIVE_ID, 'session.unarchive', 'unarchiveSession'],
    ] as const)('honors cancellation when confirmation is enabled for %s', async (actionId, protocolId, operation) => {
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { [protocolId]: { approvalRequiredSurfaces: ['ui_button'] } },
        }) });
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const mutate = vi.fn(async () => ({ success: true }));
        await executeSessionAction({
            actionId,
            target: createTarget({ archivedAt: actionId === SESSION_ACTION_UNARCHIVE_ID ? 1 : null }),
            context: { operations: { [operation]: mutate } },
        });
        expect(Modal.confirm).toHaveBeenCalled();
        expect(vi.mocked(Modal.confirm).mock.calls[0]?.[2]?.destructive).toBe(false);
        expect(mutate).not.toHaveBeenCalled();
    });

    it.each([SESSION_ACTION_ARCHIVE_ID, SESSION_ACTION_UNARCHIVE_ID] as const)('runs %s immediately when confirmation is off', async (actionId) => {
        const mutate = vi.fn(async () => ({ success: true }));
        await executeSessionAction({
            actionId,
            target: createTarget({ archivedAt: actionId === SESSION_ACTION_UNARCHIVE_ID ? 1 : null }),
            context: { operations: { archiveSession: mutate, unarchiveSession: mutate } },
        });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(mutate).toHaveBeenCalledWith('session_1', { serverId: 'server_1' });
    });

    it('retains stop confirmation when archive discovers an active session after the click', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const stopSession = vi.fn(async () => ({ success: true }));
        const archiveSession = vi.fn(async (): Promise<{ success: boolean; code?: string }> => ({ success: true }))
            .mockResolvedValueOnce({ success: false, code: 'session_active' });
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget(),
            context: { operations: {
                archiveSession,
                stopSession,
            } },
        });
        expect(Modal.confirm).toHaveBeenCalled();
        expect(stopSession).not.toHaveBeenCalled();
    });

    it('does not stop or archive an active session when the stop confirmation is cancelled', async () => {
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        const stopSession = vi.fn(async () => ({ success: true }));
        const archiveSession = vi.fn(async () => ({ success: true }));
        const result = await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({ active: true }),
            context: { operations: { stopSession, archiveSession } },
        });
        expect(result).toBe(false);
        expect(stopSession).not.toHaveBeenCalled();
        expect(archiveSession).not.toHaveBeenCalled();
    });
    it('archives an active session through the stop/archive flow', async () => {
        const stopArchiveFlow = vi.fn(async () => undefined);
        const archiveSession = vi.fn(async () => ({ success: true as const }));

        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({ active: true }),
            context: {
                hideInactiveSessions: true,
                operations: {
                    stopArchiveFlow,
                    stopSession: vi.fn(async () => ({ success: true as const })),
                    archiveSession,
                },
            },
        });

        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session_1',
            archiveAfterStop: 'always',
            hideInactiveSessions: true,
            isPinned: true,
        }));
        expect(archiveSession).not.toHaveBeenCalled();
    });

    it('stops a recoverable preserved host before archiving an inactive session', async () => {
        const stopArchiveFlow = vi.fn(async () => undefined);
        const archiveSession = vi.fn(async () => ({ success: true as const }));

        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({
                active: false,
                metadata: {
                    path: '',
                    terminalControlServiceabilityV1: {
                        v: 1,
                        attachmentId: 'attachment-preserved',
                        state: 'recoverable_unservable',
                        observedAt: 123,
                        reason: 'control_descriptor_missing',
                    },
                },
            }),
            context: {
                operations: {
                    stopArchiveFlow,
                    stopSession: vi.fn(async () => ({ success: true as const })),
                    archiveSession,
                },
            },
        });

        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session_1',
            archiveAfterStop: 'always',
        }));
        expect(archiveSession).not.toHaveBeenCalled();
    });

    it('falls back to the active-session stop/archive flow when direct archive returns a session-active conflict', async () => {
        const stopArchiveFlow = vi.fn(async () => undefined);
        const archiveSession = vi.fn(async () => ({
            success: false as const,
            code: 'session_active',
            message: 'Cannot archive an active session',
        }));

        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({ active: false }),
            context: {
                operations: {
                    stopArchiveFlow,
                    stopSession: vi.fn(async () => ({ success: true as const })),
                    archiveSession,
                },
            },
        });

        expect(archiveSession).toHaveBeenCalledWith('session_1', { serverId: 'server_1' });
        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session_1',
            archiveAfterStop: 'always',
        }));
    });

    it('marks read and renames through the injected operation seam', async () => {
        const setManualReadState = vi.fn(async () => ({ success: true as const }));
        const renameSession = vi.fn(async () => ({ success: true as const }));

        await executeSessionAction({
            actionId: SESSION_ACTION_MARK_READ_ID,
            target: createTarget(),
            context: {
                operations: {
                    setManualReadState,
                    renameSession,
                },
            },
        });
        await executeSessionAction({
            actionId: SESSION_ACTION_RENAME_ID,
            target: createTarget(),
            input: { title: 'New title' },
            context: {
                operations: {
                    setManualReadState,
                    renameSession,
                },
            },
        });

        expect(setManualReadState).toHaveBeenCalledWith('session_1', 'read', { serverId: 'server_1' });
        expect(renameSession).toHaveBeenCalledWith('session_1', 'New title', { serverId: 'server_1' });
    });

    it('writes an explicit attention standing through the injected operation seam', async () => {
        const setAttentionStanding = vi.fn(async () => undefined);

        await executeSessionAction({
            actionId: SESSION_ACTION_SET_ATTENTION_STANDING_ID,
            target: createTarget(),
            context: { operations: { setAttentionStanding } },
        });
        await executeSessionAction({
            actionId: SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
            target: createTarget(),
            context: { operations: { setAttentionStanding } },
        });

        expect(setAttentionStanding).toHaveBeenNthCalledWith(1, 'session_1', true, { serverId: 'server_1' });
        expect(setAttentionStanding).toHaveBeenNthCalledWith(2, 'session_1', false, { serverId: 'server_1' });
    });

    it('throws HappyError when a single-target operation reports failure', async () => {
        await expect(executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target: createTarget({ active: true }),
            context: {
                operations: {
                    stopArchiveFlow: vi.fn(async () => {
                        throw new HappyError('stop failed', false);
                    }),
                    stopSession: vi.fn(async () => ({ success: false as const, message: 'stop failed' })),
                    archiveSession: vi.fn(async () => ({ success: true as const })),
                },
            },
        })).rejects.toMatchObject({ message: 'stop failed' });
    });

    it('preserves unavailable-control recovery through the single-target action surface', async () => {
        await expect(executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target: createTarget({ active: true }),
            context: {
                operations: {
                    stopSession: vi.fn(async () => ({
                        success: false as const,
                        message: 'RPC method not available',
                        code: 'session_stop_control_unavailable',
                        recovery: 'retry_when_runtime_available' as const,
                    })),
                    archiveSession: vi.fn(async () => ({ success: true as const })),
                },
            },
        })).rejects.toMatchObject({
            message: t('sessionInfo.stopSessionControlUnavailable'),
        });
    });

    it('uses the unarchive failure message for unarchive failures', async () => {
        await expect(executeSessionAction({
            actionId: SESSION_ACTION_UNARCHIVE_ID,
            target: createTarget({ archivedAt: 123 }),
            context: {
                operations: {
                    unarchiveSession: vi.fn(async () => ({ success: false as const })),
                },
            },
        })).rejects.toMatchObject({ message: t('sessionInfo.failedToUnarchiveSession') });
    });

    it('executes pin through the injected local action seam', async () => {
        const setPinned = vi.fn(async () => ({ success: true as const }));

        await executeSessionAction({
            actionId: SESSION_ACTION_PIN_ID,
            target: createTarget(),
            context: {
                operations: {
                    setPinned,
                },
            },
        });

        expect(setPinned).toHaveBeenCalledWith('session_1', true, { serverId: 'server_1' });
    });

    it('executes tags and move-to-folder through injected local action seams', async () => {
        const setTags = vi.fn(async () => ({ success: true as const }));
        const moveToFolder = vi.fn(async () => ({ success: true as const }));
        const target = createTarget();

        await executeSessionAction({
            actionId: SESSION_ACTION_EDIT_TAGS_ID,
            target,
            input: { tags: ['urgent'] },
            context: {
                operations: {
                    setTags,
                    moveToFolder,
                },
            },
        });
        await executeSessionAction({
            actionId: SESSION_ACTION_MOVE_TO_FOLDER_ID,
            target,
            input: { folderId: 'folder_1' },
            context: {
                operations: {
                    setTags,
                    moveToFolder,
                },
            },
        });

        expect(setTags).toHaveBeenCalledWith('session_1', ['urgent'], { serverId: 'server_1' });
        expect(moveToFolder).toHaveBeenCalledWith(target, { folderId: 'folder_1' });
    });

    it('does not silently ignore local action ids without an injected operation', async () => {
        await expect(executeSessionAction({
            actionId: SESSION_ACTION_EDIT_TAGS_ID,
            target: createTarget(),
        })).rejects.toBeInstanceOf(HappyError);
    });

    describe('archive pending state', () => {
        const sessionId = 'session_archive_pending';
        const readArchiving = () => isSessionArchivePending(sessionId, 'server_1');

        beforeEach(() => {
            storage.setState({ sessionArchiveOperations: {} });
            storage.getState().mergeSessionListRenderables([createSession({ id: sessionId })]);
        });

        it('does not duplicate a bulk archive that starts while stop confirmation is open', async () => {
            const confirmation = createDeferred<boolean>();
            const stopped = createDeferred<{ success: boolean }>();
            vi.mocked(Modal.confirm).mockReturnValueOnce(confirmation.promise);
            const stopSession = vi.fn(() => stopped.promise);
            const archiveSession = vi.fn(async () => ({ success: true }));
            const single = executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createTarget({ id: sessionId, active: true }),
                context: { operations: { stopSession, archiveSession } },
            });
            const bulk = executeSessionBulkAction({
                action: { id: SESSION_BULK_ACTION_IDS.archive },
                targets: [{
                    key: `server_1:${sessionId}`, sessionId, serverId: 'server_1', active: true,
                    archived: false, hasAdminAccess: true, canStop: true, canArchive: true,
                    pinned: false, tags: [],
                }],
                context: { stopSession, archiveSession, stopSessionAndMaybeArchive: (params) => stopSessionAndMaybeArchive({ ...params, serverId: params.target.serverId }) },
            });
            await vi.waitFor(() => expect(stopSession).toHaveBeenCalledTimes(1));
            confirmation.resolve(true);
            try {
                await Promise.resolve();
                await Promise.resolve();
                expect(stopSession).toHaveBeenCalledTimes(1);
                expect(readArchiving()).toBe(true);
            } finally {
                stopped.resolve({ success: true });
                await Promise.all([single, bulk]);
            }
            expect(archiveSession).toHaveBeenCalledTimes(1);
            expect(readArchiving()).toBe(false);
        });

        it('marks an inactive session archiving while the archive request is in flight and clears it on success', async () => {
            const observed: boolean[] = [];
            const archiveSession = vi.fn(async () => {
                observed.push(readArchiving());
                return { success: true };
            });

            await executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createTarget({ id: sessionId }),
                context: { operations: { archiveSession } },
            });

            expect(observed).toEqual([true]);
            expect(readArchiving()).toBe(false);
        });

        it('allows the same session id on two servers to archive independently', async () => {
            const request = createDeferred<{ success: boolean }>();
            const archiveSession = vi.fn(() => request.promise);
            const run = (serverId: string) => executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: { ...createTarget({ id: sessionId }), serverId },
                context: { operations: { archiveSession } },
            });
            const first = run('server_1');
            await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1));
            const second = run('server_2');
            try {
                await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(2));
            } finally {
                request.resolve({ success: true });
                await Promise.all([first, second]);
            }
        });

        it('prevents duplicate archives even when the remote session has no active-store renderable', async () => {
            const remoteId = 'uncached_remote_session';
            const request = createDeferred<{ success: boolean }>();
            const archiveSession = vi.fn(() => request.promise);
            const run = () => executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: { ...createTarget({ id: remoteId }), serverId: 'server_2' },
                context: { operations: { archiveSession } },
            });
            const first = run();
            await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1));
            const second = run();
            try {
                await Promise.resolve();
                await Promise.resolve();
                expect(archiveSession).toHaveBeenCalledTimes(1);
            } finally {
                request.resolve({ success: true });
                await Promise.all([first, second]);
            }
        });

        it('retains admission when the active-server renderables are replaced during a request', async () => {
            const request = createDeferred<{ success: boolean }>();
            const archiveSession = vi.fn(() => request.promise);
            const run = () => executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createTarget({ id: sessionId }),
                context: { operations: { archiveSession } },
            });
            const first = run();
            await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1));
            storage.setState({ sessionListRenderables: { [sessionId]: createSession({ id: sessionId }) } });
            const second = run();
            try {
                await Promise.resolve();
                await Promise.resolve();
                expect(archiveSession).toHaveBeenCalledTimes(1);
            } finally {
                request.resolve({ success: true });
                await Promise.all([first, second]);
            }
        });

        it('does not start a second archive while one is already in flight for the session', async () => {
            let release: () => void = () => {};
            const gate = new Promise<{ success: boolean }>((resolve) => {
                release = () => resolve({ success: true });
            });
            const archiveSession = vi.fn(() => gate);
            const run = () => executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createTarget({ id: sessionId }),
                context: { operations: { archiveSession } },
            });

            const first = run();
            await vi.waitFor(() => expect(archiveSession).toHaveBeenCalledTimes(1));
            const second = run();
            release();

            await expect(second).resolves.toBe(false);
            await first;
            expect(archiveSession).toHaveBeenCalledTimes(1);
            expect(readArchiving()).toBe(false);
        });

        it('reverts the archiving state when the archive fails', async () => {
            const observed: boolean[] = [];
            const archiveSession = vi.fn(async () => {
                observed.push(readArchiving());
                return { success: false, message: 'archive boom' };
            });

            await expect(executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createTarget({ id: sessionId }),
                context: { operations: { archiveSession } },
            })).rejects.toMatchObject({ message: 'archive boom' });

            expect(observed).toEqual([true]);
            expect(readArchiving()).toBe(false);
        });

        it('keeps a running session archiving from stop through archive and reverts when stop fails', async () => {
            const observedDuringStop: boolean[] = [];
            const stopSession = vi.fn(async () => {
                observedDuringStop.push(readArchiving());
                return { success: false, message: 'stop boom', code: 'session_stop_failed' };
            });
            const archiveSession = vi.fn(async () => ({ success: true }));

            await expect(executeSessionAction({
                actionId: SESSION_ACTION_ARCHIVE_ID,
                target: createTarget({ id: sessionId, active: true }),
                context: { operations: { stopSession, archiveSession } },
            })).rejects.toMatchObject({ message: 'stop boom' });

            expect(observedDuringStop).toEqual([true]);
            expect(archiveSession).not.toHaveBeenCalled();
            expect(readArchiving()).toBe(false);
        });
    });
});
