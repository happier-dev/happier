import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { buildUpdatedSessionFromSocketUpdate } from '@/sync/engine/sessions/syncSessions';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';
import { useSessionRuntimeStatusSource } from './useSessionRuntimeStatusSource';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';

afterEach(() => standardCleanup());

it.each(['zero', 'absent', 'retained'] as const)('settles the retained composer after Stop cancels a pending Shell permission (%s counts)', async (counts) => {
    const previous = storage.getState();
    const now = Date.now();
    const session = createSessionFixture({ id: 'stopped-permission-status', serverId: 'home',
        active: true, activeAt: now, presence: 'online', metadataLayoutVersion: 1,
        ownerMetadataView: { path: '/workspace', host: 'qa' },
        agentStateVersion: 4, updatedAt: now, thinking: true, thinkingAt: now,
        ...(counts === 'absent' ? {} : { pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 0, pendingRequestObservedAt: now }),
        agentState: { requests: { shell: { tool: 'Bash', arguments: { command: 'sleep 92' }, createdAt: now } } } });
    storage.getState().applySessions([session]);
    const pending: NormalizedMessage = { id: 'shell-message', localId: null, createdAt: now,
        role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'shell', name: 'Bash',
            input: { command: 'sleep 92', permissionId: 'shell', status: 'pending' },
            description: null, uuid: 'shell-message', parentUUID: null }] };
    storage.getState().applyMessages(session.id, [pending]);
    const hook = await renderHook(() => useSessionStatus(useSessionRuntimeStatusSource(session), {
        subscribeToSession: false, subscribeToTranscript: false,
    }));
    try {
        expect(hook.getCurrent()?.state).toBe('permission_required');
        await act(async () => {
            const { nextSession } = await buildUpdatedSessionFromSocketUpdate({ session,
                updateSeq: 2, updateCreatedAt: now + 1, sessionEncryption: null,
                updateBody: {
                    thinking: false, latestTurnStatus: 'cancelled', latestTurnStatusObservedAt: now + 1,
                    ...(counts === 'zero' ? { pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0, pendingRequestObservedAt: null } : {}),
                    agentState: { version: 5, value: JSON.stringify({ requests: {}, completedRequests: { shell: {
                        tool: 'Bash', arguments: { command: 'sleep 92' }, createdAt: now,
                        completedAt: now + 1, status: 'canceled', decision: 'abort',
                    } } }) },
                },
            });
            storage.getState().applySessions([nextSession]);
        });
        expect(derivePendingRequestFlagsFromSession(storage.getState().sessions[session.id]!)).toEqual({
            hasPendingPermissionRequests: false, hasPendingUserActionRequests: false,
        });
        expect(hook.getCurrent()?.state).not.toBe('permission_required');
        expect(hook.getCurrent()?.state).not.toBe('thinking');
    } finally {
        await hook.unmount();
        storage.setState(previous, true);
    }
});

it('updates the retained composer status after archive and unarchive settle', async () => {
    const previous = storage.getState();
    const session = createSessionFixture({ id: 'archive-status', serverId: 'home',
        active: false, presence: 'online', archivedAt: null, activeAt: Date.now() });
    storage.getState().applySessions([session]);
    const hook = await renderHook(() => useSessionStatus(useSessionRuntimeStatusSource(session), {
        subscribeToSession: false, subscribeToTranscript: false,
    }));
    try {
        expect(hook.getCurrent()?.state).not.toBe('archived');
        await act(async () => {
            storage.getState().applySessions([{ ...session, archivedAt: 42, updatedAt: 42 }], 'projection');
        });
        expect(storage.getState().sessions[session.id]?.archivedAt).toBe(42);
        expect(hook.getCurrent()?.state).toBe('archived');
        await act(async () => {
            storage.getState().applySessions([{ ...session, archivedAt: null, updatedAt: 43 }], 'projection');
        });
        expect(hook.getCurrent()?.state).not.toBe('archived');
    } finally {
        await hook.unmount();
        storage.setState(previous, true);
    }
});
