import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionHandoffCommonModuleMocks } from './sessionHandoffTestHelpers';

installSessionHandoffCommonModuleMocks({
    storage: async importOriginal => importOriginal(),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
});
vi.doUnmock('@/components/ui/text/Text');
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
let home: Awaited<ReturnType<typeof network.addHome>>;
let commandConnection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;
const { renderScreen, standardCleanup } = await import('@/dev/testkit');
beforeEach(async () => {
    home = await network.addHome('https://handoff-progress.example.test', 'account-1');
    network.resetRequests();
    network.respond(ACTION_OPERATION_RPC_METHODS_V1.cancel, { kind: 'requested' });
});
afterEach(async () => { await standardCleanup(); await commandConnection?.dispose(); commandConnection = undefined; });
afterAll(() => network.dispose());

function findProgressIndicators(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => node.props?.accessibilityRole === 'progressbar');
}

async function expandProgressDetails(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const toggle = screen.findByTestId('session-handoff-progress-details-toggle');
    if (toggle?.props.accessibilityState?.expanded !== true) {
        await screen.pressByTestIdAsync('session-handoff-progress-details-toggle');
    }
}

describe('SessionHandoffProgressModal', () => {
    it('publishes the complete recovery navigation inventory and retires addresses', async () => {
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        commandConnection = await restoreServerAccountForTest({ serverUrl: home.serverUrl, accountId: home.accountId, request: network.request });
        const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
        const { useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        let reader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
        function Observe() { reader = useOptionalCurrentUiContextReader(); return null; }
        const close = vi.fn();
        const conflicts = vi.fn();
        const screen = await renderMountedCurrentUiContext(<><Observe /><SessionHandoffProgressModal
            onClose={close} setChrome={vi.fn()} onOpenConflicts={conflicts}
            requestFailure={{ ok: false, errorCode: 'workspace_sync_conflicts', error: 'Blocked' }} /></>);
        const current = reader!;
        const inventory = () => current.readCurrentUiContext()!.commands;
        expect(inventory().map(command => command.title)).toEqual(['workspaceSync.conflictsTitle', 'common.details']);
        const detailsAddress = inventory()[1]!.id;
        const invoke = async (address: string) => {
            const resolved = current.resolveCurrentUiCommand(address)!;
            if (resolved.command.kind !== 'hostLocal') throw new Error('Expected local command');
            await act(async () => { await resolved.command.invoke({ signal: resolved.retirementSignal, context: { surface: 'agent' } }); });
        };
        await invoke(detailsAddress);
        expect(screen.findByTestId('session-handoff-failure-technical-details')).toBeTruthy();
        await screen.pressByTestIdAsync('session-handoff-progress-details-toggle');
        expect(screen.findByTestId('session-handoff-progress-details-toggle')!.props.accessibilityState.expanded).toBe(false);
        await invoke(inventory()[0]!.id);
        expect(conflicts).toHaveBeenCalledWith(null);
        await screen.update(<><Observe /><SessionHandoffProgressModal onClose={close} setChrome={vi.fn()} onRetry={vi.fn()}
            requestFailure={{ ok: false, error: 'controller_unavailable', errorCode: 'controller_unavailable' }}
            machineCreation={{ name: 'Draft', progress: { kind: 'failed', code: 'controller_unavailable' } }} /></>);
        expect(inventory().map(command => command.title)).toEqual(['common.details', 'sessionHandoff.failure.chooseAnotherMachine']);
        await invoke(inventory()[1]!.id);
        expect(close).toHaveBeenCalledOnce();
        await screen.update(<Observe />);
        expect(inventory()).toEqual([]);
        expect(current.resolveCurrentUiCommand(detailsAddress)).toBeNull();
    });
    it('shows the destination Provider refusal alongside source recovery', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(<SessionHandoffProgressModal
            onClose={vi.fn()}
            setChrome={vi.fn()}
            status={{ handoffId: 'handoff-1', status: 'awaiting_recovery', phase: 'resuming', recoveryActions: [] }}
            requestFailure={{ ok: false, errorCode: 'SPAWN_VALIDATION_FAILED', error: 'provider_not_enabled_on_machine' }}
        />);

        const status = screen.findByTestId('session-handoff-progress-status');
        expect(status?.props.accessibilityLabel).toContain('settingsProviders.errors.notEnabledOnMachineDescription');
        expect(status?.props.accessibilityLabel).toContain('sessionHandoff.recovery.messageAfterSourceStop');
    });

    it('shows how to recover when the receiving Machine requires a sandbox preset', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={vi.fn()} setChrome={vi.fn()}
            requestFailure={{ ok: false, error: 'target refuses handoff', errorCode: 'handoff_target_requires_sandbox_preset' }} />);
        // The test text boundary returns translation keys, as every other copy check here asserts.
        expect(screen.getTextContent()).toContain('sessionHandoff.failure.targetRequiresSandboxPreset');
    });

    it('says the carried cause of a refused handoff and keeps its code and phase under Details', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={vi.fn()} setChrome={vi.fn()}
            requestFailure={{ ok: false, error: 'Request failed', errorCode: 'RPC_FORBIDDEN',
                failureCause: { phase: 'workspace_sync.relationship_owner.select', errorClass: 'Error',
                    errorCode: 'workspace_sync_requester_link_unavailable', httpStatus: null } }} />);
        expect(screen.findByTestId('session-handoff-progress-status')?.props.accessibilityLabel)
            .toContain('workspaceSync.error.requesterLinkUnavailable');
        expect(screen.getTextContent()).not.toContain('sessionHandoff.failure.message');
        await expandProgressDetails(screen);
        const details = screen.findByTestId('session-handoff-failure-technical-details');
        expect(details).toBeTruthy();
        expect(screen.getTextContent()).toContain('workspace_sync_requester_link_unavailable');
        expect(screen.getTextContent()).toContain('workspace_sync.relationship_owner.select');
    });

    it('explains a Home refusal to copy from a shared source without asking to reconnect the destination', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={vi.fn()} setChrome={vi.fn()}
            requestFailure={{ ok: false, error: 'Peer mediation route grant is unavailable', errorCode: 'peer_unavailable',
                failureCause: { phase: 'rpc.handler', errorClass: 'RpcError',
                    errorCode: 'peer_unavailable', httpStatus: null, nativeErrorReason: 'route_unavailable' } }} />);
        expect(screen.findByTestId('session-handoff-progress-status')?.props.accessibilityLabel)
            .toContain('workspaceSync.error.seedFromSharedMachineRefused');
        await expandProgressDetails(screen);
        expect(screen.getTextContent()).toContain('route_unavailable');
    });

    it.each([
        ['target', 'workspaceSync.error.ownFolderOnly', true],
        ['another-target', 'workspaceSync.error.needsAttention', false],
    ] as const)('shows the proposed private folder for Machine %s only when the Target authored it there', async (reviewMachineId, statusKey, showDestination) => {
        const { executeSessionHandoffAction } = await import('@/sync/domains/sessionHandoff/executeSessionHandoffAction');
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const requestFailure = await executeSessionHandoffAction({ sessionId: 'source', targetMachineId: 'target', context: { surface: 'ui' },
            execute: async () => ({ ok: false, error: 'Private checkout is unavailable', errorCode: 'workspace_private_checkout_review_required',
                failureCause: { phase: 'session.handoff.workspace_capture', errorClass: 'Error', errorCode: 'workspace_private_checkout_review_required',
                    httpStatus: null, nativeErrorReason: 'workspace_private_checkout_review_required' },
                details: { kind: 'refused', code: 'workspace_private_checkout_review_required', destinationReview: {
                    accountId: 'member', serverId: 'home-1', machineId: reviewMachineId,
                    destinationParentPath: '/member/workspaces', destinationDirectoryName: 'project',
                } } }) });
        if (requestFailure.ok) throw new Error('Expected the Target’s refusal');
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={vi.fn()} setChrome={vi.fn()}
            serverId="home-1" targetMachineId="target" requestFailure={requestFailure} />);
        expect(screen.findByTestId('session-handoff-progress-status')?.props.accessibilityLabel)
            .toContain(statusKey);
        await expandProgressDetails(screen);
        const details = screen.getTextContent();
        expect(details.includes('workspaceSync.endpoint.destination(label=/member/workspaces/project)')).toBe(showDestination);
        expect(details).toContain('workspace_private_checkout_review_required');
    });

    it('shows that a typed source refusal makes handoff unavailable for the Agent', async () => {
        const { executeSessionHandoffAction } = await import('@/sync/domains/sessionHandoff/executeSessionHandoffAction');
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const requestFailure = await executeSessionHandoffAction({ sessionId: 'source', targetMachineId: 'target',
            context: { surface: 'ui' }, execute: async () => ({
                ok: false, errorCode: 'handoff_unsupported', error: 'This Agent does not support handoff.',
                effectAttempted: false,
                failureCause: { phase: 'session_handoff.source_export', errorClass: 'Error',
                    errorCode: 'handoff_unsupported', httpStatus: null },
            }) });
        if (requestFailure.ok) throw new Error('Expected the source refusal');
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={vi.fn()} setChrome={vi.fn()}
            requestFailure={requestFailure} />);
        expect(screen.getTextContent()).toContain('session.actionMenu.handoffUnavailable.agentUnsupported');
        expect(screen.getTextContent()).not.toContain('sessionHandoff.failure.message');
    });

    it('says nothing moved when the new machine was not created, and offers another machine or Retry', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();
        const onClose = vi.fn();
        const onRetry = vi.fn();
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={onClose} setChrome={setChrome} onRetry={onRetry}
            machineCreation={{ name: 'Boat · Node 22', progress: { kind: 'failed', code: 'controller_unavailable' } }}
            requestFailure={{ ok: false, error: 'controller_unavailable', errorCode: 'controller_unavailable' }} />);
        expect(screen.getTextContent()).toContain('sessionHandoff.failure.nothingMoved');
        const footer = await renderScreen(setChrome.mock.calls.at(-1)?.[0].footer);
        await footer.pressByTestIdAsync('session-handoff-progress-retry');
        expect(onRetry).toHaveBeenCalledTimes(1);
        await footer.pressByTestIdAsync('session-handoff-progress-choose-another');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('offers the blocked link from validated request-local failure without redispatching on return', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const onOpenConflicts = vi.fn();
        const screen = await renderScreen(<SessionHandoffProgressModal
            onClose={vi.fn()} setChrome={vi.fn()}
            requestFailure={{
                ok: false, error: 'route blocked', errorCode: 'workspace_sync_partial_route_blocked',
                workspacePreparation: { ok: false, errorCode: 'relationship_conflicted', completed: [], blockedRelationshipId: 'a-b' },
            }}
            onOpenConflicts={onOpenConflicts}
        />);
        expect(onOpenConflicts).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-handoff-open-conflicts');
        expect(onOpenConflicts).toHaveBeenCalledWith('a-b');
        expect(onOpenConflicts).toHaveBeenCalledTimes(1);
    });

    it('offers general set review when immediate failure has no validated blocked-link detail', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const onOpenConflicts = vi.fn();
        const screen = await renderScreen(<SessionHandoffProgressModal onClose={vi.fn()} setChrome={vi.fn()}
            requestFailure={{ ok: false, error: 'unavailable', errorCode: 'workspace_sync_unavailable' }}
            onOpenConflicts={onOpenConflicts} />);
        await screen.pressByTestIdAsync('session-handoff-open-conflicts');
        expect(onOpenConflicts).toHaveBeenCalledWith(null);
    });

    const completedOperation = (workspace: unknown) => ({
        version: 1 as const,
        operationId: 'handoff-operation-outcome',
        requestId: 'handoff-request-outcome',
        revision: 2,
        actionId: 'session.handoff' as const,
        state: 'succeeded' as const,
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Hand off session',
        createdAt: 1,
        startedAt: 2,
        settledAt: 3,
        cancellation: 'supported' as const,
        result: {
            handoffId: 'handoff-1',
            status: {
                handoffId: 'handoff-1',
                status: 'completed' as const,
                phase: 'finalizing' as const,
                recoveryActions: [],
            },
            workspace,
        },
    });

    it('keeps the shared operation Stop and Collapse controls in the rich running presentation', async () => {
        // This case exercises an accepted Stop, not the separate approval flow.
        network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v2/account/settings'
            ? Response.json({ content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
            } }, version: 1 })
            : null);
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();
        const onClose = vi.fn();
        const operation = {
            version: 1 as const,
            operationId: 'handoff-operation-controls',
            requestId: 'request-controls',
            revision: 1,
            actionId: 'session.handoff',
            state: 'running' as const,
            scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
            title: 'Hand off session',
            createdAt: 1,
            startedAt: 1,
            cancellation: 'supported' as const,
        };

        await renderScreen(
            <SessionHandoffProgressModal
                onClose={onClose}
                setChrome={setChrome}
                operation={operation}
                serverId={home.id}
            />,
        );

        const chrome = setChrome.mock.calls.at(-1)?.[0];
        expect(React.isValidElement(chrome?.footer)).toBe(true);
        const footer = await renderScreen(chrome.footer);
        await footer.pressByTestIdAsync('action-operation-cancel');
        await act(async () => {
            await vi.waitFor(() => {
                expect(network.requests).toContainEqual(expect.objectContaining({
                    serverUrl: home.serverUrl,
                    targetId: 'source-machine',
                    method: ACTION_OPERATION_RPC_METHODS_V1.cancel,
                    payload: { operationId: operation.operationId },
                }));
            });
        });
        expect(footer.getTextContent()).toContain('inbox.actionOperations.cancel.requested');
        await footer.pressByTestIdAsync('action-operation-collapse');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('uses three localized primary stages and keeps technical operation details behind one disclosure', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                operation={{
                    version: 1,
                    operationId: 'handoff-operation-primary-progress',
                    requestId: 'request-primary-progress',
                    revision: 3,
                    actionId: 'session.handoff',
                    state: 'running',
                    scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
                    title: 'Hand off session',
                    createdAt: 1,
                    startedAt: 1,
                    progress: { kind: 'determinate', current: 1024, total: 4096, label: 'Packaging session state' },
                    cancellation: 'supported',
                }}
            />,
        );

        expect(screen.findByTestId('session-handoff-primary-step-preparing')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-primary-step-moving')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-primary-step-ready')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.primary.preparing');
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.primary.moving');
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.primary.ready');
        expect(screen.findByTestId('session-handoff-primary-step-preparing')?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId('session-handoff-operation-progress-bar')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-operation-progress-bar')?.props.accessibilityValue)
            .toEqual({ min: 0, max: 100, now: 25 });
        expect(screen.getTextContent()).not.toContain('Packaging session state');

        const detailsToggle = screen.findHostByTestId('session-handoff-progress-details-toggle');
        expect(detailsToggle?.props.role).toBe('button');
        expect(detailsToggle?.props.accessibilityState?.expanded).toBe(false);
        await screen.pressByTestIdAsync('session-handoff-progress-details-toggle');

        expect(screen.getTextContent()).toContain('Packaging session state');
        expect(screen.getTextContent()).toContain('1.02 KB / 4.1 KB');
        expect(screen.findHostByTestId('session-handoff-progress-details-toggle')?.props.accessibilityState?.expanded).toBe(true);
    });

    it('shows a spinner while the modal is waiting for the first status update', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(
            <SessionHandoffProgressModal onClose={() => {}} setChrome={setChrome} />,
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
                title: 'sessionHandoff.progress.title',
                testID: 'session-handoff-progress-modal',
            }),
        );
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.message');
        expect(findProgressIndicators(screen)).toHaveLength(1);
    });

    it('shows determinate session-state packaging progress before workspace preparation begins', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                operation={{
                    version: 1,
                    operationId: 'handoff-operation-1',
                    requestId: 'request-1',
                    revision: 2,
                    actionId: 'session.handoff',
                    state: 'running',
                    scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
                    title: 'Hand off session',
                    createdAt: 1,
                    startedAt: 1,
                    progress: { kind: 'determinate', current: 1024, total: 4096, label: 'Packaging session state' },
                    cancellation: 'supported',
                }}
            />,
        );

        const progressBar = screen.findByTestId('session-handoff-operation-progress-bar');
        expect(progressBar).toBeTruthy();
        expect(progressBar?.props.accessibilityLabel).toBe('sessionHandoff.progress.primary.preparing');
        expect(progressBar?.props.accessibilityValue).toEqual(expect.objectContaining({ min: 0, max: 100, now: 25 }));
        expect(screen.getTextContent()).toContain('25');
        expect(screen.getTextContent()).not.toContain('Packaging session state');
        await expandProgressDetails(screen);
        expect(screen.getTextContent()).toContain('Packaging session state');
    });

    it('maps technical operation progress onto the localized Moving primary stage', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                workspaceSyncEnabled={false}
                operation={{
                    version: 1,
                    operationId: 'handoff-operation-1',
                    requestId: 'request-1',
                    revision: 3,
                    actionId: 'session.handoff',
                    state: 'running',
                    scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
                    title: 'Hand off session',
                    createdAt: 1,
                    startedAt: 1,
                    progress: { kind: 'determinate', current: 1024, total: 4096, label: 'Transferring session data' },
                    cancellation: 'supported',
                }}
            />,
        );

        const preparing = screen.findByTestId('session-handoff-primary-step-preparing');
        const moving = screen.findByTestId('session-handoff-primary-step-moving');
        const ready = screen.findByTestId('session-handoff-primary-step-ready');

        expect(preparing?.props.accessibilityState?.checked).toBe(true);
        expect(moving?.props.accessibilityState?.selected).toBe(true);
        expect(ready?.props.accessibilityState?.selected).toBe(false);
        expect(moving?.findByProps({ testID: 'session-handoff-operation-progress-bar' })).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('Transferring session data');
    });

    it('keeps completed session bytes anchored to the session transfer step while import begins', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                operation={{
                    version: 1,
                    operationId: 'handoff-operation-2',
                    requestId: 'request-2',
                    revision: 4,
                    actionId: 'session.handoff',
                    state: 'running',
                    scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
                    title: 'Hand off session',
                    createdAt: 1,
                    startedAt: 1,
                    progress: { kind: 'determinate', current: 4096, total: 4096, label: 'Importing session state' },
                    cancellation: 'supported',
                }}
            />,
        );

        expect(screen.findByTestId('session-handoff-primary-step-moving')?.props.accessibilityState?.selected).toBe(true);
    });

    it('keeps technical workspace progress labels behind Details', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                workspaceSyncEnabled
                operation={{
                    version: 1,
                    operationId: 'handoff-operation-3',
                    requestId: 'request-3',
                    revision: 5,
                    actionId: 'session.handoff',
                    state: 'running',
                    scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
                    title: 'Hand off session',
                    createdAt: 1,
                    startedAt: 1,
                    progress: { kind: 'determinate', current: 1024, total: 4096, label: 'Transferring workspace' },
                    cancellation: 'supported',
                }}
            />,
        );

        expect(screen.getTextContent()).not.toContain('Transferring workspace');
        await expandProgressDetails(screen);
        expect(screen.getTextContent()).toContain('Transferring workspace');
    });

    it('offers Resume for an interrupted handoff but never invokes it during passive render', async () => {
        const onResume = vi.fn();
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_interrupted_1',
                    jobId: 'prepare_job_1',
                    status: 'awaiting_user_resume',
                    phase: 'staging_target',
                    recoveryActions: [],
                }}
                onResume={onResume}
            />,
        );

        expect(onResume).not.toHaveBeenCalled();
        expect(screen.findByTestId('session-handoff-progress-resume')).toBeTruthy();
        await screen.pressByTestIdAsync('session-handoff-progress-resume');
        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it('renders a full checkpoint timeline that matches the protocol checkpoint enum', async () => {
        const { SessionHandoffProgressCheckpointSchema} = await import('@happier-dev/protocol/sessions/control/handoff/handoffStatus');
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_checkpoint_parity_1',
                    status: 'pending',
                    phase: 'preparing',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'scan_source',
                        planned: {},
                        transferred: {},
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        for (const checkpoint of SessionHandoffProgressCheckpointSchema.options) {
            expect(screen.findByTestId(`session-handoff-progress-checkpoint-${checkpoint}`)).toBeTruthy();
        }
    });

    it('renders workspace preflight summary and progress details from handoff status', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                setChrome={setChrome}
                status={{
                    handoffId: 'handoff_1',
                    status: 'pending',
                    phase: 'staging_target',
                    workspacePreflightSummary: {
                        addedPathsCount: 3,
                        changedPathsCount: 2,
                        removedPathsCount: 1,
                        totalBytes: 2048,
                    },
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'transfer_blobs',
                        planned: {
                            totalFiles: 6,
                            totalBytes: 2048,
                        },
                        transferred: {
                            files: 3,
                            bytes: 1024,
                            blobs: 2,
                        },
                        applied: {
                            files: 1,
                            bytes: 256,
                        },
                        remaining: {
                            files: 3,
                            bytes: 1024,
                        },
                        current: {
                            relativePath: 'README.md',
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
                title: 'sessionHandoff.progress.title',
                testID: 'session-handoff-progress-modal',
            }),
        );
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-summary')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-stats')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-path')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-timeline')).toBeNull();
        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-summary')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-stats')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-path')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-timeline')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-stat-planned')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-stat-transferred')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-stat-remaining')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-stat-applied')).toBeTruthy();

        const currentCheckpointRow = screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs');
        expect(currentCheckpointRow?.props.accessibilityState?.selected).toBe(true);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('+3');
        expect(textContent).toContain('~2');
        expect(textContent).toContain('-1');
        expect(textContent).toContain('2.05 KB');
        expect(screen.findByTestId('session-handoff-progress-bar')?.props.accessibilityValue)
            .toEqual({ min: 0, max: 100, now: 50 });
        expect(textContent).toContain('README.md');
        expect(textContent).toContain('sessionHandoff.progress.planned');
        expect(textContent).toContain('sessionHandoff.progress.transferred');
        expect(textContent).toContain('sessionHandoff.progress.remaining');
        expect(textContent).toContain('common.applied');
    });

    it('exposes determinate progress and changing status through polite accessibility semantics', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const createStatus = (transferredBytes: number, updatedAtMs: number) => ({
            handoffId: 'handoff_accessibility_1',
            status: 'in_progress' as const,
            phase: 'staging_target' as const,
            progress: {
                updatedAtMs,
                checkpoint: 'transfer_blobs' as const,
                planned: { totalBytes: 100 },
                transferred: { bytes: transferredBytes },
                resumable: true,
            },
            recoveryActions: [],
        });

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={createStatus(25, 1)}
            />,
        );

        const progressBar = screen.findByTestId('session-handoff-progress-bar');
        expect(progressBar?.props.accessibilityRole).toBe('progressbar');
        expect(progressBar?.props.accessibilityLabel).toBe('sessionHandoff.progress.primary.moving');
        expect(progressBar?.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 25 });

        const initialStatus = screen.findByTestId('session-handoff-progress-status');
        expect(initialStatus?.props.accessibilityLiveRegion).toBe('polite');
        expect(initialStatus?.props.role).toBe('status');
        expect(initialStatus?.props.accessibilityLabel).toContain('25%');

        await screen.update(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={createStatus(50, 2)}
            />,
        );

        expect(screen.findByTestId('session-handoff-progress-bar')?.props.accessibilityValue)
            .toEqual({ min: 0, max: 100, now: 50 });
        expect(screen.findByTestId('session-handoff-progress-status')?.props.accessibilityLabel)
            .toContain('50%');
    });

    it('renders apply progress counts without a transfer progress bar during application', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_apply_progress_1',
                    status: 'pending',
                    phase: 'finalizing',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'apply',
                        planned: {
                            totalFiles: 4,
                            totalBytes: 4096,
                        },
                        transferred: {
                            files: 4,
                            bytes: 4096,
                            blobs: 2,
                        },
                        applied: {
                            files: 2,
                            bytes: 2048,
                        },
                        remaining: {
                            files: 0,
                            bytes: 0,
                        },
                        current: {
                            phaseDetail: 'applying_workspace',
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-stats')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-stat-applied')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeNull();
        expect(screen.getTextContent()).toContain('common.applied');
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.remaining');
    });

    it('does not shrink the timeline back to minimal after the daemon has already emitted a full-timeline checkpoint', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const renderProps = {
            onClose: () => {},
        };

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                {...renderProps}
                status={{
                    handoffId: 'handoff_timeline_latch_1',
                    status: 'pending',
                    phase: 'preparing',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'plan',
                        planned: {},
                        transferred: {},
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-plan')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-scan_source')).toBeNull();

        await screen.update(
                <SessionHandoffProgressModal
                    {...renderProps}
                    status={{
                        handoffId: 'handoff_timeline_latch_1',
                        status: 'pending',
                        phase: 'finalizing',
                        progress: {
                            updatedAtMs: 456,
                            checkpoint: 'import_session',
                            planned: {},
                            transferred: {},
                            resumable: true,
                        },
                        recoveryActions: [],
                    }}
                />,
        );

        expect(screen.findByTestId('session-handoff-progress-checkpoint-plan')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-scan_source')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-import_session')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-finalize')).toBeTruthy();
    });

    it('keeps the checkpoint timeline minimal when the daemon reports only minimal checkpoints (even with workspace progress)', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_minimal_with_workspace_progress_1',
                    status: 'pending',
                    phase: 'staging_target',
                    workspacePreflightSummary: {
                        addedPathsCount: 1,
                        changedPathsCount: 0,
                        removedPathsCount: 0,
                        totalBytes: 1024,
                    },
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'import_session',
                        planned: {
                            totalFiles: 1,
                            totalBytes: 1024,
                        },
                        transferred: {
                            bytes: 128,
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-stage_target')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-import_session')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-finalize')).toBeTruthy();

        expect(screen.findByTestId('session-handoff-progress-checkpoint-scan_source')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-plan')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-apply')).toBeNull();
    });

    it('shows a failure presentation without a spinner when the handoff status is failed', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                setChrome={setChrome}
                status={{
                    handoffId: 'handoff_failed_1',
                    status: 'failed',
                    phase: 'transferring',
                    recoveryActions: [],
                }}
            />,
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
                title: 'sessionHandoff.failure.title',
            }),
        );
        expect(screen.getTextContent()).toContain('sessionHandoff.failure.message');
        expect(findProgressIndicators(screen)).toHaveLength(0);
    });

    it.each([
        ['workspace_sync_update_required', 'workspaceSync.error.updateRequired'],
        ['machine_carrier_unavailable', 'workspaceSync.error.machineOffline'],
    ] as const)('presents the owned %s operation failure guidance and no retry control', async (errorCode, expectedKey) => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                setChrome={setChrome}
                operation={{
                    version: 1,
                    operationId: 'handoff-operation-update-required',
                    requestId: 'handoff-request-update-required',
                    revision: 2,
                    actionId: 'session.handoff',
                    state: 'failed',
                    scope: { accountId: 'account-1', machineId: 'source-machine', sessionId: 'session-1' },
                    title: 'Hand off session',
                    createdAt: 1,
                    startedAt: 2,
                    settledAt: 3,
                    cancellation: 'supported',
                    error: {
                        errorCode,
                        error: errorCode,
                    },
                }}
            />,
        );

        expect(screen.getTextContent()).toContain(expectedKey);
        expect(screen.getTextContent()).not.toContain('sessionHandoff.failure.message');

        const chrome = setChrome.mock.calls.at(-1)?.[0];
        const footer = await renderScreen(chrome.footer);
        expect(footer.findByTestId('action-operation-done')).toBeTruthy();
        expect(footer.findByTestId('action-operation-cancel')).toBeNull();
    });

    it('surfaces the phase detail when the handoff is awaiting recovery', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                setChrome={setChrome}
                status={{
                    handoffId: 'handoff_recovery_1',
                    status: 'awaiting_recovery',
                    phase: 'resuming',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'transfer_blobs',
                        planned: {
                            totalBytes: 1024,
                        },
                        transferred: {
                            bytes: 1024,
                        },
                        current: {
                            phaseDetail: 'daemon_restart_detected',
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
                title: 'sessionHandoff.recovery.title',
            }),
        );
        await expandProgressDetails(screen);
        expect(screen.getTextContent()).toContain('sessionHandoff.recovery.messageAfterSourceStop');
        expect(screen.getTextContent()).toContain('daemon_restart_detected');
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeNull();
        expect(findProgressIndicators(screen)).toHaveLength(0);
    });

    it('does not render a percent/progress bar when the checkpoint is import_session (even if byte counters are present)', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_import_session_1',
                    status: 'pending',
                    phase: 'staging_target',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'import_session',
                        planned: {
                            totalBytes: 1024,
                        },
                        transferred: {
                            bytes: 1024,
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeNull();
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.timeline.importSession');
    });

    it('renders the current checkpoint label when no current path and no progress fraction are available', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_3',
                    status: 'pending',
                    phase: 'staging_target',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'stage_target',
                        planned: {},
                        transferred: {},
                        current: {
                            phaseDetail: 'preparing_target',
                        },
                        resumable: false,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-timeline')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-path')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.timeline.stageTarget');
    });

    it('renders a minimal checkpoint timeline when workspace transfer is not in play', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_minimal_1',
                    status: 'pending',
                    phase: 'staging_target',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'stage_target',
                        planned: {},
                        transferred: {},
                        resumable: false,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-stage_target')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-import_session')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-finalize')).toBeTruthy();

        expect(screen.findByTestId('session-handoff-progress-checkpoint-scan_source')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-plan')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-apply')).toBeNull();
    });

    it('keeps the daemon-emitted checkpoint selected when the handoff status is completed', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_4',
                    status: 'completed',
                    phase: 'finalizing',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'import_session',
                        planned: {},
                        transferred: {},
                        resumable: false,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        const currentCheckpointRow = screen.findByTestId('session-handoff-progress-checkpoint-import_session');
        expect(currentCheckpointRow?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-finalize')?.props.accessibilityState?.selected).toBe(false);
    });

    it('ignores stale progress updates (by updatedAtMs) so the checkpoint selection never regresses', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const renderProps = {
            onClose: () => {},
        };

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                {...renderProps}
                status={{
                    handoffId: 'handoff_out_of_order_1',
                    status: 'in_progress',
                    phase: 'transferring',
                    progress: {
                        updatedAtMs: 200,
                        checkpoint: 'transfer_blobs',
                        planned: {},
                        transferred: {},
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')?.props.accessibilityState?.selected).toBe(true);

        await screen.update(
                <SessionHandoffProgressModal
                    {...renderProps}
                    status={{
                        handoffId: 'handoff_out_of_order_1',
                        status: 'in_progress',
                        phase: 'staging_target',
                        progress: {
                            updatedAtMs: 100,
                            checkpoint: 'plan',
                            planned: {},
                            transferred: {},
                            resumable: true,
                        },
                        recoveryActions: [],
                    }}
                />,
        );

        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-plan')?.props.accessibilityState?.selected).toBe(false);
    });

    it('keeps the last daemon checkpoint visible when a terminal status update arrives without progress', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const setChrome = vi.fn();

        const renderProps = {
            onClose: () => {},
            setChrome,
        };

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                {...renderProps}
                status={{
                    handoffId: 'handoff_terminal_without_progress_1',
                    status: 'in_progress',
                    phase: 'transferring',
                    progress: {
                        updatedAtMs: 200,
                        checkpoint: 'transfer_blobs',
                        planned: {},
                        transferred: {},
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')?.props.accessibilityState?.selected).toBe(true);

        await screen.update(
                <SessionHandoffProgressModal
                    {...renderProps}
                    status={{
                        handoffId: 'handoff_terminal_without_progress_1',
                        status: 'aborted',
                        phase: 'finalizing',
                        recoveryActions: [],
                    }}
                />,
        );

        expect(setChrome).toHaveBeenLastCalledWith(
            expect.objectContaining({
                kind: 'card',
                title: 'sessionHandoff.failure.title',
            }),
        );
        expect(screen.getTextContent()).toContain('sessionHandoff.failure.message');
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')?.props.accessibilityState?.selected).toBe(true);
    });

    it('anchors ready_for_cutover to the daemon-reported checkpoint (import_session)', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_ready_for_cutover_1',
                    status: 'ready_for_cutover',
                    phase: 'cutover',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'import_session',
                        planned: {},
                        transferred: {},
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-stage_target')).toBeTruthy();
        const importSessionRow = screen.findByTestId('session-handoff-progress-checkpoint-import_session');
        expect(importSessionRow?.props.accessibilityState?.selected).toBe(true);
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')).toBeNull();
    });

    it('does not render summary chips when workspace preflight summary is missing', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_2',
                    status: 'in_progress',
                    phase: 'transferring',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'transfer_blobs',
                        planned: {
                            added: 2,
                            changed: 1,
                            removed: 3,
                            totalBytes: 2048,
                        },
                        transferred: {
                            bytes: 0,
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        await expandProgressDetails(screen);
        expect(screen.findByTestId('session-handoff-progress-summary')).toBeNull();
        const textContent = screen.getTextContent();
        expect(textContent).not.toContain('+2');
        expect(textContent).not.toContain('~1');
        expect(textContent).not.toContain('-3');
    });

    it('confirms the daemon-owned committed workspace outcome and keeps its cleanup warning visible', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                operation={completedOperation({
                    kind: 'relationship',
                    relationshipId: 'relationship-1',
                    created: true,
                    cleanupWarning: { code: 'staging_release_failed', message: 'Staging could not be released.' },
                })}
            />,
        );

        expect(screen.findByTestId('session-handoff-workspace-outcome')).toBeTruthy();
        const textContent = screen.getTextContent();
        expect(textContent).toContain('sessionHandoff.workspaceOutcome.relationshipCreated');
        expect(textContent).not.toContain('sessionHandoff.workspaceOutcome.relationshipReused');
        expect(screen.findByTestId('session-handoff-workspace-outcome-cleanup-warning')).toBeTruthy();
        expect(textContent).toContain('Staging could not be released.');
        // Raw relationship identity stays diagnostic-only (A4.5).
        expect(textContent).not.toContain('relationship-1');
    });

    it('distinguishes a reused relationship from a committed one-shot copy', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const reused = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                operation={completedOperation({ kind: 'relationship', relationshipId: 'relationship-1', created: false })}
            />,
        );
        expect(reused.getTextContent()).toContain('sessionHandoff.workspaceOutcome.relationshipReused');
        expect(reused.findByTestId('session-handoff-workspace-outcome-cleanup-warning')).toBeNull();

        const copied = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                operation={completedOperation({ kind: 'copied', operationId: 'operation-1' })}
            />,
        );
        expect(copied.getTextContent()).toContain('sessionHandoff.workspaceOutcome.copied');
    });

    it('confirms only the linked route that actually completed', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const status = {
            relationshipId: 'c-a', controllerMachineId: 'machine-a', state: 'watching',
            alphaPath: '/a', betaPath: '/c', mode: 'keep_both_in_sync',
            endpointStates: {
                alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
                beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
            },
            conflictCount: 0, lastCycleObservedAtMs: 1,
        };
        const screen = await renderScreen(<SessionHandoffProgressModal
            onClose={() => {}}
            operation={completedOperation({ kind: 'linked_workspace', traversed: [
                { relationshipId: 'c-a', policyDigest: 'a'.repeat(64), status },
                { relationshipId: 'a-b', policyDigest: 'b'.repeat(64), status: { ...status, relationshipId: 'a-b' } },
            ], cleanupWarning: { code: 'workspace_sync_commit_failed', message: 'Fence cleanup needs attention.' } })}
        />);
        expect(screen.getTextContent()).toContain('sessionHandoff.workspaceOutcome.linked');
        expect(screen.getTextContent()).toContain('Fence cleanup needs attention.');
        expect(screen.getTextContent()).not.toContain('Current everywhere');
    });

    it('states partial linked transfer rather than presenting a generic failure', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const screen = await renderScreen(<SessionHandoffProgressModal
            onClose={() => {}}
            operation={{
                ...completedOperation({ kind: 'none' }),
                state: 'failed', result: undefined,
                error: { errorCode: 'workspace_sync_partial_route_blocked', error: 'Some files synchronized through C–A; A–B is blocked.' },
            }}
        />);
        expect(screen.findByTestId('session-handoff-progress-status')?.props.children).toBe('sessionHandoff.failure.partialLinked');
        await expandProgressDetails(screen);
        expect(screen.getTextContent()).toContain('Some files synchronized through C–A; A–B is blocked.');
    });

});
