import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { createSessionActionTarget } from './sessionActionContext';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MAKE_ORCHESTRATOR_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
} from './sessionActionIds';
import { executeSessionAction } from './sessionActionExecution';

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
                    clearSessionVisibleWhenInactive: vi.fn(),
                },
            },
        });

        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            address: { serverId: 'server_1', sessionId: 'session_1' },
            archiveAfterStop: 'always',
            hideInactiveSessions: true,
            isPinned: true,
        }));
        expect(archiveSession).not.toHaveBeenCalled();
    });

    it('keeps stop/archive retention and archive cleanup qualified to the selected Home when Session ids collide', async () => {
        const stopArchiveFlow = vi.fn(async () => undefined);
        const clearSessionVisibleWhenInactive = vi.fn();
        const archiveSession = vi.fn(async () => ({ success: true as const }));
        const otherHomeTarget = { ...createTarget(), serverId: 'home_a', sessionId: 'shared_session' };
        const selectedHomeTarget = { ...otherHomeTarget, serverId: 'home_b' };

        await executeSessionAction({
            actionId: SESSION_ACTION_STOP_ID,
            target: { ...selectedHomeTarget, isActive: true },
            context: {
                hideInactiveSessions: true,
                operations: {
                    stopArchiveFlow,
                    stopSession: vi.fn(async () => ({ success: true as const })),
                    archiveSession,
                    clearSessionVisibleWhenInactive,
                },
            },
        });
        await executeSessionAction({
            actionId: SESSION_ACTION_ARCHIVE_ID,
            target: { ...selectedHomeTarget, isActive: false },
            context: {
                hideInactiveSessions: true,
                operations: {
                    stopArchiveFlow,
                    stopSession: vi.fn(async () => ({ success: true as const })),
                    archiveSession,
                    clearSessionVisibleWhenInactive,
                },
            },
        });

        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            address: { serverId: 'home_b', sessionId: 'shared_session' },
        }));
        expect(clearSessionVisibleWhenInactive).toHaveBeenCalledWith({
            serverId: 'home_b',
            sessionId: 'shared_session',
        });
        expect(stopArchiveFlow).not.toHaveBeenCalledWith(expect.objectContaining({
            address: { serverId: 'home_a', sessionId: 'shared_session' },
        }));
        expect(clearSessionVisibleWhenInactive).not.toHaveBeenCalledWith({
            serverId: 'home_a',
            sessionId: 'shared_session',
        });
    });

    it('stops a recoverable preserved host before archiving an inactive session', async () => {
        const stopArchiveFlow = vi.fn(async () => undefined);
        const archiveSession = vi.fn(async () => ({ success: true as const }));

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
                    stopArchiveFlow,
                    stopSession: vi.fn(async () => ({ success: true as const })),
                    archiveSession,
                },
            },
        });

        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            address: { serverId: 'server_1', sessionId: 'session_1' },
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
                    clearSessionVisibleWhenInactive: vi.fn(),
                },
            },
        });

        expect(archiveSession).toHaveBeenCalledWith('session_1', { serverId: 'server_1' });
        expect(stopArchiveFlow).toHaveBeenCalledWith(expect.objectContaining({
            address: { serverId: 'server_1', sessionId: 'session_1' },
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

    it('makes the Session an orchestrator through the role Action and reports a refusal', async () => {
        const setSessionRole = vi.fn(async () => ({ ok: true }));
        await executeSessionAction({
            actionId: SESSION_ACTION_MAKE_ORCHESTRATOR_ID,
            target: createTarget(),
            context: { operations: { setSessionRole } },
        });
        expect(setSessionRole).toHaveBeenCalledWith('session_1', 'orchestrator', { serverId: 'server_1' });

        await expect(executeSessionAction({
            actionId: SESSION_ACTION_MAKE_ORCHESTRATOR_ID,
            target: createTarget(),
            context: { operations: { setSessionRole: async () => ({ ok: false, error: 'role_target_unavailable' }) } },
        })).rejects.toBeInstanceOf(HappyError);
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
