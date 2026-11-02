import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { readSessionArchivePending } from '@/sync/domains/session/listing/sessionArchiveState';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { createSessionActionTarget } from './sessionActionContext';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
} from './sessionActionIds';
import { executeSessionAction } from './sessionActionExecution';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

function createTarget(overrides: Partial<SessionListRenderableSession> = {}) {
    const session: SessionListRenderableSession = {
        id: 'session_1',
        active: false,
        archivedAt: null,
        owner: 'user_1',
        access: createSessionAccessFixture(),
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
    return createSessionActionTarget({
        session,
        serverId: 'server_1',
        currentUserId: 'user_1',
        isConnected: true,
        isPinned: true,
    });
}

describe('executeSessionAction', () => {
    it('forwards the direct-report choice in the one archive request', async () => {
        const requests: unknown[] = [];
        await executeSessionAction({ actionId: SESSION_ACTION_ARCHIVE_ID, target: createTarget(),
            input: { alsoArchiveReports: true }, context: { operations: {
                archiveSession: async (sessionId, options) => { requests.push({ sessionId, options }); return { success: true }; },
            } } });
        expect(requests).toEqual([{ sessionId: 'session_1', options: expect.objectContaining({ serverId: 'server_1', alsoArchiveReports: true }) }]);
    });
    it('forwards the exact completed host confirmation to Delete only', async () => {
        const deleteSession = vi.fn(async () => ({ success: true as const }));
        const previousState = storage.getState();
        const session = createSessionFixture({ id: 'session_1', serverId: 'server_1', archivedAt: 42,
            active: false, activeAt: 0, presence: 0 });
        storage.setState({ sessions: { ...previousState.sessions, [session.id]: session } });
        try {
            await executeSessionAction({
                actionId: SESSION_ACTION_DELETE_ID,
                target: createSessionActionTarget({ session, serverId: 'server_1', isConnected: false }),
                context: { confirmed: true, operations: { deleteSession } },
            });
            expect(deleteSession).toHaveBeenCalledWith('session_1', {
                serverId: 'server_1', confirmed: true,
            });
        } finally {
            storage.setState(previousState, true);
        }
    });

    it.each([true, false] as const)('announces Stop success only after a confirmed outcome (%s)', async confirmed => {
        retirePresentationNotice();
        await executeSessionAction({ actionId: SESSION_ACTION_STOP_ID, target: createTarget({ active: true }),
            context: { operations: {
                stopSession: async () => confirmed ? { success: true } : {
                    success: false, code: 'session_stop_requested', recovery: 'wait_for_inactive',
                },
            } },
        });
        expect(readPresentationNotice()?.severity ?? null).toBe(confirmed ? 'info' : null);
        retirePresentationNotice();
    });
    it('opens the existing Work pane for the captured Home without navigating unqualified or unreadable targets', async () => {
        const { router } = await import('expo-router');
        const push = vi.mocked(router.push);
        push.mockClear();
        const target = createTarget({ metadata: { path: '/project', bot: { kind: 'bot' } } });
        await executeSessionAction({ actionId: 'ui.session.work.open', target });
        const route = new URL(String(push.mock.calls[0]?.[0]), 'https://happier.test');
        expect(route.pathname).toBe('/session/session_1');
        expect(route.searchParams.get('serverId')).toBe('server_1');
        expect(route.searchParams.get('right')).toBe('agents');
        await executeSessionAction({ actionId: 'ui.session.work.open', target: { ...target, serverId: null } });
        await executeSessionAction({ actionId: 'ui.session.work.open', target: { ...target, session: { ...target.session, access: null } } });
        expect(push.mock.calls.map(([href]) => String(href))).toEqual([route.pathname + route.search]);
    });
    it('opens People on the Following section for "Edit what it follows"', async () => {
        const { router } = await import('expo-router');
        const push = vi.mocked(router.push);
        push.mockClear();
        await executeSessionAction({ actionId: 'ui.session.coordinator.edit', target: createTarget() });
        const route = new URL(String(push.mock.calls[0]?.[0]), 'https://happier.test');
        expect(route.pathname).toBe('/session/session_1');
        expect(route.searchParams.get('serverId')).toBe('server_1');
        expect(route.searchParams.get('right')).toBe('collaboration');
        expect(route.searchParams.get('collaborationFocus')).toBe('following');
    });
    it('opens Follow for the captured Home and preserves archived state without permitting unqualified or disabled targets', async () => {
        const opened: Array<{ address: { serverId: string; sessionId: string }; archived: boolean }> = [];
        const context = { operations: { openFollowEditor: (target: typeof opened[number]) => { opened.push(target); } } };
        const target = { ...createTarget({ archivedAt: 42 }), followEnabled: true, serverId: 'home_b' };
        await executeSessionAction({ actionId: 'ui.session.follow', target, context });
        await executeSessionAction({ actionId: 'ui.session.follow', target: { ...target, serverId: null }, context });
        await executeSessionAction({ actionId: 'ui.session.follow', target: { ...target, followEnabled: false }, context });
        expect(opened).toEqual([{ address: { serverId: 'home_b', sessionId: 'session_1' }, archived: true }]);
    });
    it('archives an active session through the stop/archive flow', async () => {
        const effects: string[] = [];
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({ active: true }),
            context: { hideInactiveSessions: true, operations: {
                stopSession: async () => { effects.push('stop'); return { success: true }; },
                archiveSession: async () => { effects.push('archive'); return { success: true }; },
            } },
        });
        expect(effects).toEqual(['stop', 'archive']);
        expect(readSessionArchivePending(storage.getState(), { serverId: 'server_1', sessionId: 'session_1' })).toBe(false);
    });

    it('keeps stop/archive progress qualified to the selected Home when Session ids collide', async () => {
        const other = { serverId: 'home_a', sessionId: 'shared_session' };
        const operation = storage.getState().beginSessionArchive(other);
        expect(operation).not.toBeNull();
        const effects: unknown[] = [];
        try {
            const target = { ...createTarget(), serverId: 'home_b', sessionId: other.sessionId };
            const context = { hideInactiveSessions: true, operations: {
                stopSession: async (id: string, options?: { serverId?: string | null }) => {
                    effects.push({ effect: 'stop', id, serverId: options?.serverId }); return { success: true };
                },
                archiveSession: async (id: string, options?: { serverId?: string | null }) => {
                    effects.push({ effect: 'archive', id, serverId: options?.serverId }); return { success: true };
                },
            } };
            await executeSessionAction({ actionId: SESSION_ACTION_STOP_ID, target: { ...target, isActive: true }, context });
            await executeSessionAction({ actionId: SESSION_ACTION_ARCHIVE_ID, target: { ...target, isActive: false }, context });
            expect(effects).toEqual([
                { effect: 'stop', id: other.sessionId, serverId: 'home_b' },
                { effect: 'archive', id: other.sessionId, serverId: 'home_b' },
            ]);
            expect(readSessionArchivePending(storage.getState(), other)).toBe(true);
            expect(readSessionArchivePending(storage.getState(), { ...other, serverId: 'home_b' })).toBe(false);
        } finally {
            if (operation) storage.getState().finishSessionArchive(operation);
        }
    });

    it('stops a recoverable preserved host before archiving an inactive session', async () => {
        const effects: string[] = [];
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({
                active: false,
                metadata: {
                    path: '/repo',
                    terminalControlServiceabilityV1: {
                        v: 1,
                        state: 'recoverable_unservable',
                        observedAt: 123,
                        reason: 'control_descriptor_missing',
                    },
                },
            }),
            context: {
                operations: {
                    stopSession: async () => { effects.push('stop'); return { success: true }; },
                    archiveSession: async () => { effects.push('archive'); return { success: true }; },
                },
            },
        });

        expect(effects).toEqual(['stop', 'archive']);
    });

    it('falls back to the active-session stop/archive flow when direct archive returns a session-active conflict', async () => {
        const effects: string[] = [];
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: createTarget({ active: false }),
            context: { operations: {
                stopSession: async () => { effects.push('stop'); return { success: true }; },
                archiveSession: async () => {
                    effects.push('archive');
                    return effects.length === 1
                        ? { success: false, code: 'session_active', message: 'Cannot archive an active session' }
                        : { success: true };
                },
            } },
        });
        expect(effects).toEqual(['archive', 'stop', 'archive']);
        expect(readSessionArchivePending(storage.getState(), { serverId: 'server_1', sessionId: 'session_1' })).toBe(false);
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

    it("flips a coordinator's \"Answers its workers' questions\" through the session role Action", async () => {
        const setSessionAnswersWorkerQuestions = vi.fn(async () => ({ ok: true }));
        await executeSessionAction({
            actionId: 'ui.session.coordinator.answers',
            target: createTarget(),
            context: { operations: { setSessionAnswersWorkerQuestions } },
        });
        expect(setSessionAnswersWorkerQuestions).toHaveBeenCalledWith('session_1', false, { serverId: 'server_1' });
    });

    it('throws HappyError when a single-target operation reports failure', async () => {
        await expect(executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target: createTarget({ active: true }),
            context: {
                operations: {
                    stopSession: vi.fn(async () => ({ success: false as const, message: 'stop failed' })),
                    archiveSession: vi.fn(async () => ({ success: true as const })),
                },
            },
        })).rejects.toMatchObject({ message: 'stop failed' });
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
            actionId: SESSION_ACTION_PIN_ID,
            target: createTarget(),
        })).rejects.toBeInstanceOf(HappyError);
    });
});
