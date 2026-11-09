import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

const clearNewSessionDraftMock = vi.hoisted(() => vi.fn());
const clearCapturedDraftMock = vi.hoisted(() => vi.fn(async () => undefined));
const preserveCreatedDraftMock = vi.hoisted(() => vi.fn());
const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn(async () => ({ kind: 'available' })));
const presentationRegisterMock = vi.hoisted(() => vi.fn());
const presentationAcknowledgeRequestMock = vi.hoisted(() => vi.fn());
const readCapturedFirstTurnTextMock = vi.hoisted(() => vi.fn());
const markSessionOptimisticThinkingMock = vi.hoisted(() => vi.fn());
const upsertPendingMessageMock = vi.hoisted(() => vi.fn());
const storageState = vi.hoisted(() => ({
    sessions: { 'session-created': { id: 'session-created' } } as Record<string, { id: string }>,
    settings: {},
    markSessionOptimisticThinking: markSessionOptimisticThinkingMock,
    upsertPendingMessage: upsertPendingMessageMock,
}));

vi.mock('@/sync/domains/state/persistence', () => ({
    clearNewSessionDraft: clearNewSessionDraftMock,
    loadNewSessionDraft: vi.fn(() => ({ input: 'persisted prompt' })),
}));
vi.mock('@/components/sessions/new/modules/newSessionDraftLifecycle', () => ({
    clearCapturedNewSessionDraftAfterLaunch: clearCapturedDraftMock,
    preserveCreatedSessionDraftAfterUnacceptedFirstTurn: preserveCreatedDraftMock,
    readCapturedNewSessionFirstTurnText: readCapturedFirstTurnTextMock,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: ensureSessionVisibleForMessageRouteMock,
    },
}));

// A stub, not the real module merged in: loading the real storage graph from inside this factory
// re-enters storage through the approval continuation's imports and never settles.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
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

// The approval Artifact is read from its Home over the network; settlement parsing stays real.
const approvalArtifactState = vi.hoisted(() => ({ artifact: null as unknown }));
vi.mock('@/components/approvals/useApprovalArtifact', () => ({
    useApprovalArtifact: () => ({
        artifact: approvalArtifactState.artifact,
        isLoading: false,
        homeUnavailable: false,
        error: false,
        invalidArtifact: false,
        refresh: async () => undefined,
    }),
}));
vi.mock('@/components/appShell/workspace/destinationRoute', () => ({
    useRouter: () => ({ push: vi.fn(), pushRetainingCurrent: vi.fn(), replace: vi.fn() }),
}));

import { useNewSessionActionOperationReconciliation } from './useNewSessionActionOperationReconciliation';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { buildApprovalRequestArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';

const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;

function mergeOperations(snapshots: readonly ActionOperationSnapshotV1[]): void {
    actionOperationStore.mergeSnapshots({ serverId: draftScope.serverId, snapshots });
}

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
                result: projectSessionSpawnNewActionResultV1({
                    type: 'success',
                    disposition: 'created',
                    sessionId: 'session-created',
                    executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
                    organizationPlacement: { folderId: null, tagIds: [] },
                    initialInput: { status: 'notRequested' },
                }),
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
    approvalArtifactState.artifact = null;
    actionOperationStore.reset();
    clearNewSessionDraftMock.mockReset();
    clearCapturedDraftMock.mockReset();
    clearCapturedDraftMock.mockResolvedValue(undefined);
    preserveCreatedDraftMock.mockReset();
    ensureSessionVisibleForMessageRouteMock.mockReset();
    ensureSessionVisibleForMessageRouteMock.mockResolvedValue({ kind: 'available' });
    presentationRegisterMock.mockReset();
    presentationAcknowledgeRequestMock.mockReset();
    readCapturedFirstTurnTextMock.mockReset();
    readCapturedFirstTurnTextMock.mockReturnValue('Persisted first turn');
    markSessionOptimisticThinkingMock.mockReset();
    upsertPendingMessageMock.mockReset();
    storageState.sessions = { 'session-created': { id: 'session-created' } };
});

afterEach(async () => {
    await standardCleanup();
    actionOperationStore.reset();
});

describe('useNewSessionActionOperationReconciliation', () => {
    it.each([
        ['accepted', 'request-1'], ['running', 'request-1'], ['running', 'manual:request-1'],
    ] as const)(
        'reattaches persisted request identity and reports creating for %s (%s) without executing again',
        async (state, requestId) => {
            mergeOperations([operation(state, { requestId })]);
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
                serverId: 'server-a',
                accountId: 'account-a',
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
            mergeOperations([operation(state)]);
            const resetLaunchRequestId = vi.fn();
            const disableDraftPersistence = vi.fn();
            const onOperationFailure = vi.fn();
            const router = { replace: vi.fn() };

            await renderHook(() => useNewSessionActionOperationReconciliation({
                draftId: 'draft-a',
                requestId: 'request-1',
                draftScope,
                localCreationInFlight: false,
                disableDraftPersistence,
                resetLaunchRequestId,
                onOperationFailure,
                router,
            }));

            await vi.waitFor(() => expect(resetLaunchRequestId).toHaveBeenCalledWith(null));
            expect(disableDraftPersistence).not.toHaveBeenCalled();
            expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
            if (state === 'failed') {
                expect(onOperationFailure).toHaveBeenCalledOnce();
                expect(onOperationFailure).toHaveBeenCalledWith({
                    errorCode: 'spawn_failed',
                    error: 'Failed',
                });
            } else {
                expect(onOperationFailure).not.toHaveBeenCalled();
            }
        },
    );

    it('projects the accepted first turn on the source Home, routes once, then clears the scoped draft after terminal success', async () => {
        const presentationOrder: string[] = [];
        clearCapturedDraftMock.mockImplementationOnce(async () => {
            presentationOrder.push('clear');
        });
        upsertPendingMessageMock.mockImplementationOnce(() => {
            presentationOrder.push('project');
        });
        mergeOperations([operation('succeeded', {
            result: projectSessionSpawnNewActionResultV1({
                type: 'success',
                disposition: 'created',
                sessionId: 'session-created',
                executionTarget: { serverId: 'server-b', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'accepted', localId: 'local-first-turn' },
            }),
        })]);
        const disableDraftPersistence = vi.fn();
        const resetLaunchRequestId = vi.fn();
        const router = {
            replace: vi.fn(() => {
                presentationOrder.push('route');
            }),
        };

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
            { forceRefresh: true, serverId: 'server-a' },
        );
        expect(disableDraftPersistence).toHaveBeenCalledTimes(1);
        expect(clearCapturedDraftMock).toHaveBeenCalledWith({
            scope: draftScope,
            draftId: 'draft-a',
            launchUserAttemptId: 'request-1',
        });
        expect(router.replace).toHaveBeenCalledWith(
            '/session/session-created?serverId=server-a',
            expect.objectContaining({ dangerouslySingular: expect.any(Function) }),
        );
        expect(presentationAcknowledgeRequestMock).toHaveBeenCalledWith(
            { serverId: 'server-a', accountId: 'account-a', requestId: 'request-1' },
            expect.objectContaining({
                serverId: 'server-a',
                snapshot: expect.objectContaining({ operationId: 'operation-1' }),
            }),
        );
        expect(markSessionOptimisticThinkingMock).toHaveBeenCalledWith('session-created');
        expect(upsertPendingMessageMock).toHaveBeenCalledWith(
            'session-created',
            expect.objectContaining({
                localId: 'local-first-turn',
                text: 'Persisted first turn',
                deliveryStatus: 'accepted',
            }),
        );
        expect(presentationOrder).toEqual(['project', 'route', 'clear']);
        expect(resetLaunchRequestId).not.toHaveBeenCalled();

        act(() => mergeOperations([operation('succeeded', { revision: 3 })]));
        expect(router.replace).toHaveBeenCalledTimes(1);
    });

    it('does not clear or route terminal success before bounded route readiness is proven', async () => {
        vi.useFakeTimers();
        try {
            storageState.sessions = {};
            ensureSessionVisibleForMessageRouteMock.mockResolvedValue({ kind: 'missing' });
            mergeOperations([operation('succeeded')]);
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

            await vi.advanceTimersByTimeAsync(10_000);
            expect(ensureSessionVisibleForMessageRouteMock.mock.calls.length).toBeGreaterThan(1);
            expect(disableDraftPersistence).not.toHaveBeenCalled();
            expect(clearNewSessionDraftMock).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not route a completed launch after the new-session surface unmounts during hydration', async () => {
        storageState.sessions = {};
        let resolveVisibility: ((result: { kind: 'available' }) => void) | null = null;
        ensureSessionVisibleForMessageRouteMock.mockImplementationOnce(async () => (
            await new Promise<{ kind: 'available' }>((resolve) => {
                resolveVisibility = resolve;
            })
        ));
        mergeOperations([operation('succeeded')]);
        const disableDraftPersistence = vi.fn();
        const router = { replace: vi.fn() };

        const hook = await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope,
            localCreationInFlight: false,
            disableDraftPersistence,
            resetLaunchRequestId: vi.fn(),
            router,
        }));

        await vi.waitFor(() => expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledTimes(1));
        await hook.unmount();
        storageState.sessions = { 'session-created': { id: 'session-created' } };
        await act(async () => {
            resolveVisibility?.({ kind: 'available' });
            await Promise.resolve();
        });

        expect(router.replace).not.toHaveBeenCalled();
        expect(disableDraftPersistence).not.toHaveBeenCalled();
        expect(clearCapturedDraftMock).not.toHaveBeenCalled();
        expect(presentationAcknowledgeRequestMock).not.toHaveBeenCalled();
    });

    it('preserves an outcome-unknown first turn instead of projecting it as accepted', async () => {
        mergeOperations([operation('succeeded', {
            result: projectSessionSpawnNewActionResultV1({
                type: 'success',
                disposition: 'created',
                sessionId: 'session-created',
                executionTarget: { serverId: 'server-b', machineId: 'machine-a' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: {
                    status: 'outcomeUnknown',
                    localId: 'local-outcome-unknown',
                    code: 'ack_timeout',
                },
            }),
        })]);
        const router = { replace: vi.fn() };

        await renderHook(() => useNewSessionActionOperationReconciliation({
            draftId: 'draft-a',
            requestId: 'request-1',
            draftScope,
            localCreationInFlight: false,
            disableDraftPersistence: vi.fn(),
            resetLaunchRequestId: vi.fn(),
            router,
        }));

        await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
        expect(preserveCreatedDraftMock).toHaveBeenCalledWith({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            sessionId: 'session-created',
            draftText: 'Persisted first turn',
        });
        expect(upsertPendingMessageMock).not.toHaveBeenCalled();
    });

    it('ignores a colliding request from another account', async () => {
        mergeOperations([operation('running', {
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
        mergeOperations([
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
        mergeOperations([operation('running')]);

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

    describe('approval of the launch', () => {
        const spawnSuccess = projectSessionSpawnNewActionResultV1({
            type: 'success',
            disposition: 'created',
            sessionId: 'session-created',
            executionTarget: { serverId: 'server-a', machineId: 'machine-a' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' },
        } as const);

        function approvalArtifact(status: 'open' | 'executed' | 'rejected' | 'canceled', requestId = 'request-1') {
            const request: ApprovalRequestV2 = {
                v: 2,
                status,
                createdAtMs: 1,
                updatedAtMs: 2,
                createdBy: { surface: 'system' },
                requestedSurface: 'ui',
                executionOriginV1: {
                    v: 1,
                    authority: 'present_user',
                    surface: 'ui',
                    caller: { kind: 'host' },
                    serverId: 'server-a',
                    accountId: 'account-a',
                    actionId: 'session.spawn_new',
                    requestId,
                },
                actionId: 'session.spawn_new',
                actionArgs: {},
                summary: 'Create session',
                ...(status === 'executed' || status === 'rejected'
                    ? { decision: { kind: status === 'executed' ? 'approve' : 'reject', decidedAtMs: 2 } }
                    : {}),
                ...(status === 'executed' ? { execution: { executedAtMs: 2, ok: true, result: spawnSuccess } } : {}),
            } as ApprovalRequestV2;
            return {
                id: 'approval-spawn',
                title: null,
                header: buildApprovalRequestArtifactHeaderV1(request),
                body: JSON.stringify(request),
                headerVersion: 1,
                bodyVersion: 1,
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                isDecrypted: true,
            };
        }

        async function renderWaitingLaunch() {
            approvalArtifactState.artifact = approvalArtifact('open');
            const callbacks = {
                disableDraftPersistence: vi.fn(),
                resetLaunchRequestId: vi.fn(),
                router: { replace: vi.fn() },
            };
            const onSucceeded = vi.fn();
            const onFailed = vi.fn();
            const hook = await renderHook(() => useNewSessionActionOperationReconciliation({
                draftId: 'draft-a',
                requestId: 'request-1',
                draftScope,
                localCreationInFlight: false,
                ...callbacks,
            }));
            await act(async () => {
                hook.getCurrent().launchApproval.request(createActionApprovalContinuation({
                    artifactId: 'approval-spawn', actionId: 'session.spawn_new',
                    expectedRequestId: 'request-1', scope: draftScope,
                    refreshAfterExecution: false, onSucceeded, onFailed,
                }));
            });
            return { hook, onSucceeded, onFailed, ...callbacks };
        }

        it('returns the approved result once to the incumbent creation completion without presenting or clearing itself', async () => {
            const { hook, router, disableDraftPersistence, resetLaunchRequestId, onSucceeded, onFailed } = await renderWaitingLaunch();

            expect(hook.getCurrent().launchApproval.pending).toEqual(expect.objectContaining({ artifactId: 'approval-spawn', serverId: 'server-a' }));
            expect(hook.getCurrent().isCreatingFromOperation).toBe(true);
            expect(router.replace).not.toHaveBeenCalled();
            expect(clearCapturedDraftMock).not.toHaveBeenCalled();

            approvalArtifactState.artifact = approvalArtifact('executed');
            await hook.rerender();

            await vi.waitFor(() => expect(onSucceeded).toHaveBeenCalledExactlyOnceWith(spawnSuccess));
            expect(onFailed).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
            expect(clearCapturedDraftMock).not.toHaveBeenCalled();
            expect(disableDraftPersistence).not.toHaveBeenCalled();
            expect(resetLaunchRequestId).not.toHaveBeenCalled();
            expect(hook.getCurrent().launchApproval.pending).toBeNull();
            await hook.rerender();
            expect(onSucceeded).toHaveBeenCalledTimes(1);
        });

        it.each(['rejected', 'canceled'] as const)('returns %s to the incumbent completion with the draft kept', async status => {
            const { hook, router, disableDraftPersistence, resetLaunchRequestId, onSucceeded, onFailed } = await renderWaitingLaunch();

            approvalArtifactState.artifact = approvalArtifact(status);
            await hook.rerender();

            await vi.waitFor(() => expect(hook.getCurrent().launchApproval.pending).toBeNull());
            expect(onFailed).toHaveBeenCalledWith(`approval_${status}`, undefined);
            expect(onSucceeded).not.toHaveBeenCalled();
            expect(resetLaunchRequestId).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
            expect(disableDraftPersistence).not.toHaveBeenCalled();
            expect(clearCapturedDraftMock).not.toHaveBeenCalled();
            expect(hook.getCurrent().isCreatingFromOperation).toBe(false);
        });

        it('ignores an executed approval that belongs to another launch attempt', async () => {
            const { hook, router, onSucceeded, onFailed } = await renderWaitingLaunch();

            approvalArtifactState.artifact = approvalArtifact('executed', 'request-other');
            await hook.rerender();

            await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith('approval_binding_mismatch'));
            expect(onSucceeded).not.toHaveBeenCalled();
            expect(router.replace).not.toHaveBeenCalled();
            expect(clearCapturedDraftMock).not.toHaveBeenCalled();
        });
    });
});
