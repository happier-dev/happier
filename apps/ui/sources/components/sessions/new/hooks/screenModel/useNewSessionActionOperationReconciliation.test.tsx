import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearCapturedDraftMock = vi.hoisted(() => vi.fn(async () => undefined));
const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'available' })));
const presentationRegisterMock = vi.hoisted(() => vi.fn());
const presentationAcknowledgeRequestMock = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted(() => ({
    sessions: { 'session-created': { id: 'session-created' } } as Record<string, { id: string }>,
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    clearNewSessionDraft: clearNewSessionDraftMock,
    loadNewSessionDraft: vi.fn(() => ({ input: 'persisted prompt' })),
}));
vi.mock('@/components/sessions/new/modules/newSessionDraftLifecycle', () => ({
    clearCapturedNewSessionDraftAfterLaunch: clearCapturedDraftMock,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: ensureSessionVisibleForMessageRouteMock,
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: () => storageState,
        },
    });
});

vi.mock('@/components/inbox/actionOperations/actionOperationPresentationRuntime', () => ({
    actionOperationPresentationCoordinator: {
        register: presentationRegisterMock,
        acknowledgeRequestPresented: presentationAcknowledgeRequestMock,
    },
}));

import { useNewSessionActionOperationReconciliation } from './useNewSessionActionOperationReconciliation';

const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;

function operation(
    state: ActionOperationSnapshotV1['state'],
    overrides: Partial<ActionOperationSnapshotV1> = {},
): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: state === 'accepted' ? 1 : 2,
        actionId: 'session.spawn_new',
        state,
        scope: { accountId: 'account-a', machineId: 'machine-a' },
        title: 'Create session',
        requestId: 'request-1',
        createdAt: 1,
        ...(state === 'running' ? { startedAt: 2 } : {}),
        ...(state === 'succeeded'
            ? {
                settledAt: 3,
                result: {
                    type: 'success',
                    disposition: 'created',
                    sessionId: 'session-created',
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'notRequested' },
                },
            }
            : {}),
        ...(state === 'failed'
            ? { settledAt: 3, error: { errorCode: 'spawn_failed', error: 'Failed' } }
            : {}),
        ...(state === 'cancelled' ? { settledAt: 3 } : {}),
        cancellation: 'supported',
        ...overrides,
    };
}

beforeEach(() => {
    actionOperationStore.reset();
    clearNewSessionDraftMock.mockReset();
    clearCapturedDraftMock.mockReset();
    clearCapturedDraftMock.mockResolvedValue(undefined);
    ensureSessionVisibleForMessageRouteMock.mockReset();
    ensureSessionVisibleForMessageRouteMock.mockResolvedValue({ kind: 'available' });
    presentationRegisterMock.mockReset();
    presentationAcknowledgeRequestMock.mockReset();
    storageState.sessions = { 'session-created': { id: 'session-created' } };
});

afterEach(async () => {
    await standardCleanup();
    actionOperationStore.reset();
});

describe('useNewSessionActionOperationReconciliation', () => {
    it.each(['accepted', 'running'] as const)(
        'reattaches persisted request identity and reports creating for %s without executing again',
        async (state) => {
            actionOperationStore.mergeSnapshots([operation(state)]);
            const resetLaunchRequestId = vi.fn();
            const router = { replace: vi.fn() };

            const hook = await renderHook(() => useNewSessionActionOperationReconciliation({
                draftId: 'draft-a',
                requestId: 'request-1',
                draftScope,
                localCreationInFlight: false,
                disableDraftPersistence: vi.fn(),
                resetLaunchRequestId,
                router,
            }));

            expect(hook.getCurrent().isCreatingFromOperation).toBe(true);
            expect(presentationRegisterMock).toHaveBeenCalledWith({
                requestId: 'request-1',
                onStart: 'current',
                origin: expect.objectContaining({ resolve: expect.any(Function) }),
            });
            expect(resetLaunchRequestId).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
        },
    );

    it.each(['failed', 'cancelled'] as const)(
        'preserves the persisted form and rotates identity after %s so retry is a fresh execution',
        async (state) => {
            actionOperationStore.mergeSnapshots([operation(state)]);
            const resetLaunchRequestId = vi.fn();
            const disableDraftPersistence = vi.fn();
            const router = { replace: vi.fn() };

            await renderHook(() => useNewSessionActionOperationReconciliation({
                draftId: 'draft-a',
                requestId: 'request-1',
                draftScope,
                localCreationInFlight: false,
                disableDraftPersistence,
                resetLaunchRequestId,
                router,
            }));

            await vi.waitFor(() => expect(resetLaunchRequestId).toHaveBeenCalledWith(null));
            expect(disableDraftPersistence).not.toHaveBeenCalled();
            expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
        },
    );

    it('hydrates, clears the accepted scoped draft, and routes once after terminal success', async () => {
        actionOperationStore.mergeSnapshots([operation('succeeded', {
            result: {
                type: 'success',
                disposition: 'created',
                sessionId: 'session-created',
                executionTarget: { serverId: 'server-b', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'notRequested' },
            },
        })]);
        const disableDraftPersistence = vi.fn();
        const resetLaunchRequestId = vi.fn();
        const router = { replace: vi.fn() };

        await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope,
            localCreationInFlight: false,
            disableDraftPersistence,
            resetLaunchRequestId,
            router,
        }));

        await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith(
            'session-created',
            { forceRefresh: true, serverId: 'server-b' },
        );
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearCapturedDraftMock).toHaveBeenCalledWith({
            scope: draftScope,
            draftId: 'draft-a',
            launchUserAttemptId: 'request-1',
        });
        expect(router.replace).toHaveBeenCalledWith(
            '/session/session-created?serverId=server-b',
            expect.objectContaining({ dangerouslySingular: expect.any(Function) }),
        );
        expect(presentationAcknowledgeRequestMock).toHaveBeenCalledWith(
            'request-1',
            expect.objectContaining({ operationId: 'operation-1' }),
        );
        expect(resetLaunchRequestId).not.toHaveBeenCalled();

        act(() => actionOperationStore.mergeSnapshots([operation('succeeded', { revision: 3 })]));
        expect(router.replace).toHaveBeenCalledTimes(1);
    });

    it('does not clear or route terminal success before canonical route readiness is proven', async () => {
        storageState.sessions = {};
        ensureSessionVisibleForMessageRouteMock.mockResolvedValue({ kind: 'missing' });
        actionOperationStore.mergeSnapshots([operation('succeeded')]);
        const disableDraftPersistence = vi.fn();
        const router = { replace: vi.fn() };

        await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope,
            localCreationInFlight: false,
            disableDraftPersistence,
            resetLaunchRequestId: vi.fn(),
            router,
        }));

        await vi.waitFor(() => expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledTimes(1));
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('ignores a colliding request from another account', async () => {
        actionOperationStore.mergeSnapshots([operation('running', {
            scope: { accountId: 'account-b', machineId: 'machine-a' },
        })]);

        const hook = await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope,
            localCreationInFlight: false,
            disableDraftPersistence: vi.fn(),
            resetLaunchRequestId: vi.fn(),
            router: { replace: vi.fn() },
        }));

        expect(hook.getCurrent().isCreatingFromOperation).toBe(false);
    });

    it('fails closed when duplicate operations claim the same account request identity', async () => {
        actionOperationStore.mergeSnapshots([
            operation('running'),
            operation('running', { operationId: 'operation-2' }),
        ]);

        const hook = await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope,
            localCreationInFlight: false,
            disableDraftPersistence: vi.fn(),
            resetLaunchRequestId: vi.fn(),
            router: { replace: vi.fn() },
        }));

        expect(hook.getCurrent().isCreatingFromOperation).toBe(false);
    });

    it('does not correlate request identity without the persisted account scope', async () => {
        actionOperationStore.mergeSnapshots([operation('running')]);

        const hook = await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope: null,
            localCreationInFlight: false,
            disableDraftPersistence: vi.fn(),
            resetLaunchRequestId: vi.fn(),
            router: { replace: vi.fn() },
        }));

        expect(hook.getCurrent().isCreatingFromOperation).toBe(false);
        expect(presentationRegisterMock).not.toHaveBeenCalled();
    });
});
