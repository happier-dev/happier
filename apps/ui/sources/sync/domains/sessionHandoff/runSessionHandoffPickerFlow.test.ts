import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionExecutorBoundaryFixture, createUiActionExecutorBoundary } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import * as frontDoor from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import '@/components/settings/machines/managed/managedMachineCreation';

const openSessionHandoffPickerMock = vi.hoisted(() => vi.fn());
const executeSessionHandoffActionMock = vi.hoisted(() => vi.fn());
const releaseUserRequestLeaseMock = vi.hoisted(() => vi.fn());
const acquireUserRequestLeaseMock = vi.hoisted(() => vi.fn(() => releaseUserRequestLeaseMock));
const presentationRegisterMock = vi.hoisted(() => vi.fn());
const progressCloseMock = vi.hoisted(() => vi.fn());
const showRequestFailureMock = vi.hoisted(() => vi.fn());
const showMachineCreationMock = vi.hoisted(() => vi.fn());
const openConflictDetailsMock = vi.hoisted(() => vi.fn());
const openObservedProgressMock = vi.hoisted(() => vi.fn((_input: unknown) => ({
    close: progressCloseMock,
    isAttached: () => true,
    showRequestFailure: showRequestFailureMock,
    showResult: vi.fn(),
    showMachineCreation: showMachineCreationMock,
})));
const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'new-request-id'));
const getStorageMock = vi.hoisted(() => vi.fn(() => ({
    getState: () => ({ profileScope: { serverId: 'server', accountId: 'account' } }),
})));

vi.mock('@/components/sessions/handoff/openSessionHandoffPicker', () => ({
    openSessionHandoffPicker: (...args: unknown[]) => openSessionHandoffPickerMock(...args),
}));
vi.mock('./executeSessionHandoffAction', async (importOriginal) => ({
    ...await importOriginal<typeof import('./executeSessionHandoffAction')>(),
    executeSessionHandoffAction: (...args: unknown[]) => executeSessionHandoffActionMock(...args),
}));
vi.mock('@/sync/sync', () => ({
    sync: { acquireUserRequestLease: acquireUserRequestLeaseMock },
}));
vi.mock('@/components/inbox/actionOperations/actionOperationPresentationRuntime', () => ({
    actionOperationPresentationCoordinator: { register: presentationRegisterMock },
}));
vi.mock('@/components/sessions/handoff/openSessionHandoffProgressModal', () => ({
    openObservedSessionHandoffProgressModal: (input: unknown) => openObservedProgressMock(input),
}));
vi.mock('@/components/workspaces/sync/openWorkspaceSyncRelationshipDetails', () => ({
    openWorkspaceSyncConflictDetails: (resource: unknown) => openConflictDetailsMock(resource),
}));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: randomUUIDMock }));
vi.mock('@/sync/domains/state/storageStore', () => ({ getStorage: getStorageMock }));

const policyFields = {
    v: 1 as const,
    selection: 'git_worktree' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
};
const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
const completedStatus = {
    handoffId: 'handoff_1',
    status: 'completed' as const,
    phase: 'finalizing' as const,
    recoveryActions: [],
};
const completedResult = (workspace: { kind: 'none' } | {
    kind: 'relationship'; relationshipId: string; created: boolean;
    cleanupWarning?: { code: string; message: string };
} = { kind: 'none' as const }) => ({
    ok: true as const,
    result: { handoffId: 'handoff_1', status: completedStatus, workspace },
});

describe('runSessionHandoffPickerFlow', () => {
    beforeEach(() => {
        openSessionHandoffPickerMock.mockReset();
        executeSessionHandoffActionMock.mockReset();
        acquireUserRequestLeaseMock.mockClear();
        releaseUserRequestLeaseMock.mockClear();
        presentationRegisterMock.mockReset();
        progressCloseMock.mockReset();
        showRequestFailureMock.mockReset();
        showMachineCreationMock.mockReset();
        openConflictDetailsMock.mockReset();
        openObservedProgressMock.mockClear();
        randomUUIDMock.mockClear();
    });

    it.each([true, false])('hands off only after managed enrollment succeeds (enrolled=%s)', async (enrolled) => {
        const controller = { machineId: 'controller', installationId: 'installation' };
        const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const draft = createManagedMachineSelectionDraft({ enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            selection: { kind: 'one-off', homeId: 'home', launch, controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            receipt: { launch, controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const machine: ManagedMachineFullV1 = { id: 'managed', homeId: 'home', custodianAccountId: 'account', controller, launch,
            allocation: enrolled ? 'bound' : 'confirmed-absent',
            ...(enrolled ? { resource: { contributionRef: launch.provider, schemaVersion: 1, value: { nativeId: 'guest' } } } : {}),
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            ...(enrolled ? { enrolledMachineId: 'enrolled' } : {}) };
        const effects: string[] = [];
        const operation: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'creation', revision: 2, actionId: 'machines.managed.acquire',
            state: enrolled ? 'succeeded' : 'failed', scope: { accountId: 'account', machineId: controller.machineId },
            title: 'Create guest', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, controller },
            ...(!enrolled ? { error: { errorCode: 'controller_unavailable', error: 'controller_unavailable' } } : {}),
        };
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'machines.managed.acquire': ['ui'], 'machines.managed.get': ['ui'], 'action.operations.get': ['ui'], 'session.handoff': ['ui'],
        } });
        const sourceMachineId = 'source';
        let runningOn = sourceMachineId;
        const executor = createUiActionExecutorBoundary(createActionExecutorBoundaryFixture({
            readActionsSettings: () => settings,
            managedMachineAction: async request => {
                effects.push(request.actionId);
                if (request.actionId === 'machines.managed.get') return machine;
                return { managedId: machine.id, operation: { operationId: operation.operationId } };
            },
            actionOperationAction: async request => {
                effects.push(request.actionId);
                expect(request.input).toMatchObject({ operationId: 'creation', waitForTerminal: true });
                return { kind: 'found', operation };
            },
            // The transport hands control to the source daemon only after both UI Actions are admitted.
            sessionHandoffStart: async request => {
                effects.push('session.handoff');
                runningOn = request.targetMachineId;
                return completedResult();
            },
        }), 'account', settings);
        const managedExecute = frontDoor.createFrontDoorActionExecute(executor);
        const managedFrontDoor = vi.spyOn(frontDoor, 'createFrontDoorActionExecute').mockReturnValueOnce(managedExecute);
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            managedTarget: { draft, lifetime: {
                scope: { serverId: 'server', accountId: 'account' }, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }),
            },
                onApprovalPending: () => { throw new Error('Unexpected approval'); } },
            workspaceAction: { kind: 'none' },
        });
        const { executeSessionHandoffAction } = await vi.importActual<typeof import('./executeSessionHandoffAction')>('./executeSessionHandoffAction');
        executeSessionHandoffActionMock.mockImplementationOnce(executeSessionHandoffAction);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        const result = await runSessionHandoffPickerFlow({ execute: executor.execute, sessionId: 'sess_1', sourceMachineId, serverId: 'server', placement: 'session_info' })
            .finally(() => managedFrontDoor.mockRestore());

        expect(effects).toEqual(['machines.managed.acquire', 'action.operations.get', 'machines.managed.get',
            ...(enrolled ? ['session.handoff'] : [])]);
        expect(openObservedProgressMock).toHaveBeenCalledWith(expect.objectContaining({
            machineCreation: { name: 'Guest', progress: { kind: 'idle' } },
        }));
        expect(result?.ok).toBe(enrolled);
        expect(runningOn).toBe(enrolled ? 'enrolled' : sourceMachineId);
        if (enrolled) return;
        // Nothing moved, so the failure offers Retry: it runs the same selection again from the retained picker.
        const progressArgs = openObservedProgressMock.mock.calls[0]?.[0] as { onRetry?: () => void };
        expect(showRequestFailureMock).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'controller_unavailable' }));
        expect(progressArgs.onRetry).toBeTypeOf('function');
        effects.length = 0;
        const retryFrontDoor = vi.spyOn(frontDoor, 'createFrontDoorActionExecute').mockReturnValue(managedExecute);
        try {
            progressArgs.onRetry!();
            // The retained acquisition resumes: it reads the same managed machine again, never acquires a second one.
            await vi.waitFor(() => expect(effects).toEqual(['machines.managed.get', 'action.operations.get', 'machines.managed.get']));
        } finally {
            retryFrontDoor.mockRestore();
        }
        expect(progressCloseMock).toHaveBeenCalled();
        expect(runningOn).toBe(sourceMachineId);
    });

    it('returns the receiving Machine\'s sandbox refusal to the sheet beside its machine row', async () => {
        const setInlineError = vi.fn();
        openSessionHandoffPickerMock.mockImplementationOnce(async (params: { onRetained: (close: () => void, setAwaiting: (awaiting: boolean) => void, isOpen: () => boolean, setInlineError: (code: string | null) => void) => void }) => {
            params.onRetained(vi.fn(), vi.fn(), () => true, setInlineError);
            return { targetMachineId: 'devbox', workspaceAction: { kind: 'none' } };
        });
        const refusal = { ok: false as const, error: 'handoff_target_requires_sandbox_preset', errorCode: 'handoff_target_requires_sandbox_preset' };
        executeSessionHandoffActionMock.mockResolvedValueOnce(refusal);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        })).resolves.toEqual(refusal);

        expect(setInlineError).toHaveBeenLastCalledWith('handoff_target_requires_sandbox_preset');
        expect(showRequestFailureMock).not.toHaveBeenCalled();
    });

    it('keeps a newly selected destination separate from an existing recoverable operation', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target', targetPath: '/target/repo',
            workspaceAction: { kind: 'copy_once', contentPolicy },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const operationStore = {
            subscribe: () => () => {},
            getSnapshot: () => ({
                operationsByKey: new Map([['operation', {
                    serverId: 'server',
                    snapshot: {
                        version: 1, operationId: 'operation-1', revision: 3,
                        actionId: 'session.handoff', state: 'running',
                        scope: { accountId: 'account', machineId: 'source', sessionId: 'sess_1' },
                        title: 'Handoff', requestId: 'retained-request-id', createdAt: 1,
                        startedAt: 2, cancellation: 'supported',
                    },
                }]]),
            }),
        };
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server',
            placement: 'session_info', operationStore: operationStore as never,
        });

        expect(randomUUIDMock).toHaveBeenCalledOnce();
        expect(executeSessionHandoffActionMock).toHaveBeenCalledWith(expect.objectContaining({
            context: expect.objectContaining({ actionRequestId: 'new-request-id' }),
        }));
        expect(openObservedProgressMock).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'new-request-id',
        }));
    });

    it('opens one live progress surface and registers the same surface for active-operation reentry', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target',
            targetSessionStorageMode: 'persisted',
            workspaceAction: { kind: 'none' },
        });
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult());
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });

        expect(openObservedProgressMock).toHaveBeenCalledWith(expect.objectContaining({
            requestId: expect.any(String),
            sessionId: 'sess_1',
            workspaceSyncEnabled: false,
        }));
        expect(presentationRegisterMock).toHaveBeenCalledWith(expect.objectContaining({
            requestId: expect.any(String),
            onStart: 'current',
            origin: expect.objectContaining({ resolve: expect.any(Function) }),
        }));
        const registration = presentationRegisterMock.mock.calls[0]?.[0];
        const running = { state: 'running' } as const;
        const succeeded = { state: 'succeeded' } as const;
        const reopen = registration.origin.resolve(running);
        expect(reopen).toEqual(expect.any(Function));
        reopen();
        expect(openObservedProgressMock).toHaveBeenCalledTimes(1);
        expect(registration.origin.resolve(succeeded)).toBeNull();
        expect(progressCloseMock).toHaveBeenCalledTimes(1);
    });

    it('confirms the daemon-owned committed workspace outcome on the same progress surface', async () => {
        const workspaceAction = { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy, flushBeforeCommit: true as const };
        openSessionHandoffPickerMock.mockResolvedValueOnce({
            targetMachineId: 'target', targetPath: '/target/repo', workspaceAction,
        });
        const workspace = {
            kind: 'relationship' as const,
            relationshipId: 'relationship-1',
            created: true,
            cleanupWarning: { code: 'staging_release_failed', message: 'Staging could not be released.' },
        };
        executeSessionHandoffActionMock.mockResolvedValueOnce(completedResult(workspace));
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        const result = await runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        });

        expect(result).toEqual(completedResult(workspace));
        expect(progressCloseMock).not.toHaveBeenCalled();
    });

    it('shows admission failure without claiming an observed operation', async () => {
        openSessionHandoffPickerMock.mockResolvedValueOnce({ targetMachineId: 'target', workspaceAction: { kind: 'none' } });
        executeSessionHandoffActionMock.mockResolvedValueOnce({ ok: false, error: 'target_unavailable' });
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');

        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'source', serverId: 'server', placement: 'session_info',
        })).resolves.toEqual({ ok: false, error: 'target_unavailable' });

        expect(openObservedProgressMock).toHaveBeenCalledOnce();
        expect(showRequestFailureMock).toHaveBeenCalledWith({ ok: false, error: 'target_unavailable' });
    });

    it('opens the same set from a validated blocked link and returns to the retained picker without dispatch', async () => {
        const closePicker = vi.fn();
        const resource = { kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'workspace-a',
            workspaceRefId: 'workspace-c', controllerMachineId: 'machine-a', serverId: 'server' };
        openSessionHandoffPickerMock.mockImplementationOnce(async (params: { onRetained: (close: () => void, setAwaiting: (awaiting: boolean) => void, isOpen: () => boolean, setInlineError: (code: string | null) => void) => void }) => {
            params.onRetained(closePicker, vi.fn(), () => true, vi.fn());
            return { targetMachineId: 'machine-b', targetPath: '/target', workspaceAction: { kind: 'linked_workspace' },
                workspaceSyncReviewResource: resource, workspaceSyncReviewRelationshipIds: ['a-c', 'a-b'] };
        });
        const failure = { ok: false as const, error: 'blocked', errorCode: 'workspace_sync_partial_route_blocked',
            workspacePreparation: { ok: false as const, errorCode: 'relationship_conflicted', completed: [], blockedRelationshipId: 'a-b' } };
        executeSessionHandoffActionMock.mockResolvedValueOnce(failure);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        await expect(runSessionHandoffPickerFlow({
            execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'machine-c', serverId: 'server', placement: 'session_info',
        })).resolves.toEqual(failure);
        expect(showRequestFailureMock).toHaveBeenCalledWith(failure);
        const progressArgs = openObservedProgressMock.mock.calls[0]?.[0] as {
            onOpenConflicts: (id: string) => void; onDismiss: () => void;
        };
        progressArgs.onOpenConflicts('a-b');
        expect(openConflictDetailsMock).toHaveBeenCalledWith({ ...resource, initialRelationshipId: 'a-b' });
        progressArgs.onDismiss();
        expect(closePicker).not.toHaveBeenCalled();
        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    });

    it('shows an immediate linked-route failure without claiming an unverified blocked link', async () => {
        const resource = { kind: 'workspaceSyncConflicts', hubWorkspaceRefId: 'workspace-a',
            workspaceRefId: 'workspace-c', controllerMachineId: 'machine-a', serverId: 'server' };
        openSessionHandoffPickerMock.mockResolvedValueOnce({ targetMachineId: 'machine-b',
            workspaceAction: { kind: 'linked_workspace' }, workspaceSyncReviewResource: resource,
            workspaceSyncReviewRelationshipIds: ['a-c', 'a-b'] });
        const failure = { ok: false as const, error: 'unavailable', errorCode: 'workspace_sync_unavailable' };
        executeSessionHandoffActionMock.mockResolvedValueOnce(failure);
        const { runSessionHandoffPickerFlow } = await import('./runSessionHandoffPickerFlow');
        await runSessionHandoffPickerFlow({ execute: vi.fn(), sessionId: 'sess_1', sourceMachineId: 'machine-c',
            serverId: 'server', placement: 'session_info' });
        expect(showRequestFailureMock).toHaveBeenCalledWith(failure);
        const progressArgs = openObservedProgressMock.mock.calls[0]?.[0] as { onOpenConflicts: (id: string | null) => void };
        progressArgs.onOpenConflicts(null);
        expect(openConflictDetailsMock).toHaveBeenCalledWith(resource);
        expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    });
});
