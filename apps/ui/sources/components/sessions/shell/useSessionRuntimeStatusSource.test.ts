import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { getSessionStatus, useSessionStatus } from '@/utils/sessions/sessionUtils';

import { useSessionRuntimeStatusSource } from './useSessionRuntimeStatusSource';

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's_runtime_source',
        seq: 1,
        encryptionMode: 'plain',
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        accessLevel: 'edit',
        canApprovePermissions: true,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '/tmp', host: 'localhost' },
        agentState: {},
        ...overrides,
    } as Session;
}

afterEach(() => {
    standardCleanup();
});

describe('useSessionRuntimeStatusSource', () => {
    it.each([false, true])('settles the mounted composer from transcript-only approval (projected counts: %s)', async (projectedCounts) => {
        const previousState = storage.getState();
        try {
            const shellSession = createSession({
                ...(projectedCounts ? {
                    pendingPermissionRequestCount: 1,
                    pendingUserActionRequestCount: 0,
                    pendingRequestObservedAt: 100,
                } : {}),
            });
            storage.getState().applySessions([shellSession]);
            const pending: NormalizedMessage = {
                id: 'permission-message', localId: null, createdAt: 200,
                role: 'agent', isSidechain: false,
                content: [{
                    type: 'tool-call', id: 'permission-request', name: 'bash',
                    input: { permissionId: 'permission-request', status: 'pending' },
                    description: null, uuid: 'permission-message', parentUUID: null,
                }],
            };
            storage.getState().applyMessages(shellSession.id, [pending]);
            const stableShellSession = storage.getState().sessions[shellSession.id]!;
            let renders = 0;
            const hook = await renderHook(() => {
                renders += 1;
                return useSessionStatus(useSessionRuntimeStatusSource(stableShellSession), {
                    subscribeToSession: false,
                    subscribeToTranscript: false,
                });
            });
            expect(hook.getCurrent().state).toBe('permission_required');

            const pendingRenders = renders;
            await act(async () => {
                storage.getState().applyMessages(shellSession.id, [{
                    id: 'unrelated-text', localId: null, createdAt: 250,
                    role: 'agent', isSidechain: false,
                    content: [{ type: 'text', text: 'Working', uuid: 'unrelated-text', parentUUID: null }],
                }]);
            });
            expect(renders).toBe(pendingRenders);

            await act(async () => {
                storage.getState().applyMessages(shellSession.id, [{
                    id: 'permission-result', localId: null, createdAt: 300,
                    role: 'agent', isSidechain: false,
                    content: [{
                        type: 'tool-result', tool_use_id: 'permission-request', content: 'done',
                        is_error: false, permissions: { result: 'approved', date: 300 },
                        uuid: 'permission-result', parentUUID: null,
                    }],
                }]);
            });
            expect(storage.getState().sessions[shellSession.id]).toBe(stableShellSession);
            expect(getSessionStatus(stableShellSession).state).toBe('waiting');
            expect(hook.getCurrent().state).toBe('waiting');
            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState, true);
            });
        }
    });

    it('wakes subscribers when applySessions updates runtime status on a stable shell session', async () => {
        const previousState = storage.getState();
        try {
            const shellSession = createSession({
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1,
            });
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [shellSession.id]: shellSession,
                },
            }));

            const hook = await renderHook(() => useSessionRuntimeStatusSource(shellSession), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initial = hook.getCurrent();
            expect(initial.latestTurnStatus).toBe('completed');

            await act(async () => {
                storage.getState().applySessions([{
                    ...shellSession,
                    activeAt: 2_000,
                    thinking: true,
                    thinkingAt: 2_000,
                    latestTurnStatus: 'in_progress',
                    latestTurnStatusObservedAt: 2_000,
                    presence: 'online',
                }]);
            });

            expect(hook.getCurrent()).not.toBe(initial);
            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                id: shellSession.id,
                activeAt: 2_000,
                thinking: true,
                thinkingAt: 2_000,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 2_000,
            }));

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('wakes subscribers when only the pending request freshness timestamp changes', async () => {
        const previousState = storage.getState();
        try {
            const shellSession = createSession({
                pendingUserActionRequestCount: 1,
                pendingRequestObservedAt: 1_000,
            });
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [shellSession.id]: shellSession,
                },
            }));

            const hook = await renderHook(() => useSessionRuntimeStatusSource(shellSession), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initial = hook.getCurrent();
            expect(initial.pendingRequestObservedAt).toBe(1_000);

            await act(async () => {
                storage.getState().applySessions([{
                    ...shellSession,
                    pendingRequestObservedAt: 5_000,
                }]);
            });

            expect(hook.getCurrent()).not.toBe(initial);
            expect(hook.getCurrent().pendingRequestObservedAt).toBe(5_000);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('wakes subscribers when provider runtime activity changes without a foreground turn change', async () => {
        const previousState = storage.getState();
        try {
            const shellSession = createSession({
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1_000,
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
            });
            storage.setState((state) => ({
                ...state,
                sessions: {
                    ...state.sessions,
                    [shellSession.id]: shellSession,
                },
            }));

            const hook = await renderHook(() => useSessionRuntimeStatusSource(shellSession), {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const initial = hook.getCurrent();
            expect(initial.runtimeActivityActiveCount).toBe(0);

            await act(async () => {
                storage.getState().applySessions([{
                    ...shellSession,
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 5_000,
                }]);
            });

            expect(hook.getCurrent()).not.toBe(initial);
            expect(hook.getCurrent()).toEqual(expect.objectContaining({
                id: shellSession.id,
                latestTurnStatus: 'completed',
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: 5_000,
            }));

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

    it('does not wake foreground-only subscribers for Activity-only changes', async () => {
        const previousState = storage.getState();
        try {
            const shellSession = createSession({
                meaningfulActivityAt: 1,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 1_000,
                runtimeActivityState: 'idle',
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 1,
            });
            storage.getState().applySessions([shellSession]);
            const normalizedShellSession = storage.getState().sessions[shellSession.id]!;

            const hook = await renderHook(
                () => useSessionRuntimeStatusSource(normalizedShellSession, {
                    subscribeToRuntimeActivity: false,
                }),
                { flushOptions: { cycles: 1, turns: 4 } },
            );
            const initial = hook.getCurrent();

            await act(async () => {
                storage.getState().applySessions([{
                    ...normalizedShellSession,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 5_000,
                    runtimeActivityRevision: 2,
                }]);
            });

            expect(hook.getCurrent()).toBe(initial);
            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });

});
