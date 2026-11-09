import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationCancelV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createActionOperationStore, type ActionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationAddressKey } from '@/sync/domains/actionOperations/qualifiedActionOperation';

import { installSessionHandoffCommonModuleMocks } from './sessionHandoffTestHelpers';

const modalShowMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => 'handoff-progress-modal'));
const modalHideMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));
const modalUpdateMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => {}));
const SERVER_ID = 'srv_handoff_progress';
const HOME_URL = 'https://handoff-progress.test';

function merge(store: ActionOperationStore, snapshots: readonly ActionOperationSnapshotV1[]): void {
    store.mergeSnapshots({ serverId: SERVER_ID, snapshots });
}

// The common helper owns the react-native/unistyles/text mock registrations.
// The modal factory keeps the same spy triples the direct component tests
// assert against; it is read lazily when `@/modal` is first imported.
installSessionHandoffCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: unknown[]) => modalShowMock(...args),
                hide: (...args: unknown[]) => modalHideMock(...args),
                update: (...args: unknown[]) => modalUpdateMock(...args),
            },
        }).module;
    },
});

vi.doUnmock('@/sync/domains/state/storage');
const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { createAccountTokenForTests, waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { parseToken } = await import('@/utils/auth/parseToken');

afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
});
afterAll(() => network.dispose());

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Item', props, props.children),
}));

vi.mock('@/components/ui/lists/ExpandableItem', () => ({
    ExpandableItem: (props: React.PropsWithChildren<Record<string, unknown> & {
        expanded: boolean;
        onExpandedChange: (next: boolean) => void;
        header: (state: Readonly<{
            expanded: boolean;
            headerProps: Readonly<{
                onPress: () => void;
                accessibilityRole: 'button';
                accessibilityState: Readonly<{ expanded: boolean }>;
            }>;
        }>) => React.ReactNode;
    }>) => React.createElement(
        'ExpandableItem',
        props,
        props.header({
            expanded: props.expanded,
            headerProps: {
                onPress: () => props.onExpandedChange(!props.expanded),
                accessibilityRole: 'button',
                accessibilityState: { expanded: props.expanded },
            },
        }),
        props.expanded ? props.children : null,
    ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProgressModalComponent = React.ComponentType<Record<string, unknown> & {
    onClose?: () => void;
    setChrome?: (chrome: unknown) => void;
    operation?: ActionOperationSnapshotV1;
}>;

function findProgressIndicators(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => node.props?.accessibilityRole === 'progressbar');
}

async function expandProgressDetails(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const toggle = screen.findByTestId('session-handoff-progress-details-toggle');
    if (toggle?.props.accessibilityState?.expanded !== true) {
        await screen.pressByTestIdAsync('session-handoff-progress-details-toggle');
    }
}

/**
 * Renders the exact component/props pair the modal host mounts for the
 * observed handoff operation, including the latest operation the live
 * subscription pushed through `Modal.update`.
 */
async function renderObservedModal(operation: ActionOperationSnapshotV1) {
    const shown = modalShowMock.mock.calls[0]?.[0] as {
        component: ProgressModalComponent;
        props?: Record<string, unknown>;
    } | undefined;
    if (!shown) throw new Error('openObservedSessionHandoffProgressModal never showed the modal');
    const setChrome = vi.fn();
    const screen = await renderScreen(
        React.createElement(shown.component, {
            ...(shown.props ?? {}),
            operation,
            onClose: () => {},
            setChrome,
        }),
    );
    return { screen, setChrome };
}

function runningSnapshot(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'handoff-operation-terminal',
        requestId: 'handoff-request-terminal',
        revision: 1,
        actionId: 'session.handoff',
        state: 'running',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
        title: 'Hand off session',
        createdAt: 1,
        startedAt: 2,
        progress: { kind: 'determinate', current: 1, total: 4, label: 'Transferring' },
        cancellation: 'supported',
        ...overrides,
    };
}

function lastPushedOperation(): ActionOperationSnapshotV1 {
    const update = modalUpdateMock.mock.calls.at(-1)?.[1] as { operation?: ActionOperationSnapshotV1 } | undefined;
    if (!update?.operation) throw new Error('the live observation never pushed an operation to the modal');
    return update.operation;
}

describe('observed session handoff progress presentation', () => {
    beforeEach(() => {
        modalShowMock.mockClear();
        modalHideMock.mockClear();
        modalUpdateMock.mockClear();
        network.resetRequests();
    });

    it('updates only the active modal with request-local blocked-link failure and retains its conflict opener', async () => {
        const { openObservedSessionHandoffProgressModal } = await import('./openSessionHandoffProgressModal');
        const onOpenConflicts = vi.fn();
        const presentation = openObservedSessionHandoffProgressModal({
            requestId: 'blocked-request', sessionId: 'session-1', serverId: SERVER_ID,
            accountId: 'account-1', store: createActionOperationStore(), onOpenConflicts,
        });
        const failure = { ok: false as const, error: 'blocked', errorCode: 'workspace_sync_partial_route_blocked',
            workspacePreparation: { ok: false as const, errorCode: 'relationship_conflicted', completed: [], blockedRelationshipId: 'a-b' } };
        presentation.showRequestFailure(failure);
        expect(modalShowMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            props: expect.objectContaining({ onOpenConflicts }),
        }));
        expect(modalUpdateMock).toHaveBeenCalledWith('handoff-progress-modal', { requestFailure: failure });
    });

    it('routes Stop from the observed handoff modal through its exact Home and operation', async () => {
        await network.addHome(HOME_URL, 'account-1', {
            credentials: { token: createAccountTokenForTests('account-1', { currentAccount: true }) },
        });
        await setServerProfileIdentityForUrl(HOME_URL, SERVER_ID);
        network.setHttpResponder(async (url) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({ capabilities: {
                    serverIdentity: { serverIdentityId: SERVER_ID },
                } }));
            }
            if (path === '/v2/account/settings') {
                return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {
                    actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
                } }, version: 1 }));
            }
            return null;
        });
        network.respond('actionOperation.cancel.v1', ActionOperationCancelV1ResponseSchema.parse({ kind: 'requested' }));
        const { openObservedSessionHandoffProgressModal } = await import('./openSessionHandoffProgressModal');
        const store = createActionOperationStore();
        openObservedSessionHandoffProgressModal({
            requestId: 'handoff-request-stop',
            sessionId: 'session-1',
            serverId: SERVER_ID,
            accountId: 'account-1',
            store,
        });

        merge(store, [runningSnapshot({
            operationId: 'handoff-operation-stop',
            requestId: 'handoff-request-stop',
        })]);
        const running = await renderObservedModal(lastPushedOperation());
        const chrome = running.setChrome.mock.calls.at(-1)?.[0] as { footer?: React.ReactNode } | undefined;
        if (!React.isValidElement(chrome?.footer)) throw new Error('Expected the observed handoff modal footer');

        const footer = await renderScreen(chrome.footer);
        await footer.pressByTestIdAsync('action-operation-cancel');

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            const cancellations = network.requests.filter(request => request.method === 'actionOperation.cancel.v1');
            expect(cancellations.map(({ serverUrl, targetId, method, payload }) => ({
                serverUrl, targetId, method, payload,
            }))).toEqual([{
                serverUrl: HOME_URL,
                targetId: 'machine-1',
                method: 'actionOperation.cancel.v1',
                payload: { operationId: 'handoff-operation-stop' },
            }]);
            expect(cancellations.map(request => request.token ? parseToken(request.token) : null)).toEqual(['account-1']);
        });
    });

    it('streams pushed operation revisions into the modal and detaches observation when collapsed', async () => {
        const { openObservedSessionHandoffProgressModal } = await import('./openSessionHandoffProgressModal');
        const store = createActionOperationStore();
        const presentation = openObservedSessionHandoffProgressModal({
            requestId: 'handoff-request-1',
            sessionId: 'session-1',
            serverId: SERVER_ID,
            accountId: 'account-1',
            workspaceSyncEnabled: true,
            store,
        });

        merge(store, [{
            version: 1,
            operationId: 'handoff-operation-1',
            requestId: 'handoff-request-1',
            revision: 1,
            actionId: 'session.handoff',
            state: 'running',
            scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
            title: 'Hand off session',
            createdAt: 1,
            startedAt: 2,
            progress: { kind: 'phase', phase: 'transfer', label: 'Transferring' },
            cancellation: 'supported',
        }]);

        expect(modalUpdateMock).toHaveBeenCalledWith('handoff-progress-modal', {
            operation: expect.objectContaining({ revision: 1, requestId: 'handoff-request-1' }),
        });
        expect(presentation.isAttached()).toBe(true);

        const config = modalShowMock.mock.calls[0]?.[0] as { onRequestClose?: () => void } | undefined;
        config?.onRequestClose?.();
        merge(store, [{
            ...store.getSnapshot().operationsByKey.get(actionOperationAddressKey({
                serverId: SERVER_ID,
                operationId: 'handoff-operation-1',
            }))!.snapshot,
            revision: 2,
        }]);

        expect(presentation.isAttached()).toBe(false);
        expect(modalUpdateMock).toHaveBeenCalledTimes(1);
    });

    it('derives one terminal failure presentation from the live operation when no legacy status exists', async () => {
        const { openObservedSessionHandoffProgressModal } = await import('./openSessionHandoffProgressModal');
        const store = createActionOperationStore();
        openObservedSessionHandoffProgressModal({
            requestId: 'handoff-request-terminal',
            sessionId: 'session-1',
            serverId: SERVER_ID,
            accountId: 'account-1',
            store,
        });

        // While the operation runs, the modal presents active progress.
        merge(store, [runningSnapshot()]);
        const running = await renderObservedModal(lastPushedOperation());
        expect(running.setChrome).toHaveBeenLastCalledWith(
            expect.objectContaining({ title: 'sessionHandoff.progress.title' }),
        );
        expect(findProgressIndicators(running.screen).length).toBeGreaterThanOrEqual(1);

        // A failed terminal revision must stop the spinner and present the
        // bounded actionable failure, with the technical error under Details.
        merge(store, [runningSnapshot({
            revision: 2,
            state: 'failed',
            settledAt: 3,
            progress: undefined,
            error: {
                errorCode: 'handoff_prepare_failed',
                error: 'The target machine rejected the handoff preparation',
            },
        })]);
        const failed = await renderObservedModal(lastPushedOperation());
        expect(lastPushedOperation().state).toBe('failed');
        expect(failed.setChrome).toHaveBeenLastCalledWith(
            expect.objectContaining({ title: 'sessionHandoff.failure.title' }),
        );
        expect(failed.screen.getTextContent()).toContain('sessionHandoff.failure.message');
        expect(findProgressIndicators(failed.screen)).toHaveLength(0);

        await expandProgressDetails(failed.screen);
        expect(failed.screen.getTextContent()).toContain('The target machine rejected the handoff preparation');
        expect(failed.screen.findByTestId('session-handoff-operation-error')).toBeTruthy();
    });

    it('derives one terminal cancelled presentation from the live operation when no legacy status exists', async () => {
        const { openObservedSessionHandoffProgressModal } = await import('./openSessionHandoffProgressModal');
        const store = createActionOperationStore();
        openObservedSessionHandoffProgressModal({
            requestId: 'handoff-request-terminal',
            sessionId: 'session-1',
            serverId: SERVER_ID,
            accountId: 'account-1',
            store,
        });

        merge(store, [runningSnapshot()]);
        const running = await renderObservedModal(lastPushedOperation());
        expect(findProgressIndicators(running.screen).length).toBeGreaterThanOrEqual(1);

        merge(store, [runningSnapshot({
            revision: 2,
            state: 'cancelled',
            settledAt: 3,
            progress: undefined,
        })]);
        const cancelled = await renderObservedModal(lastPushedOperation());
        expect(lastPushedOperation().state).toBe('cancelled');
        expect(cancelled.setChrome).toHaveBeenLastCalledWith(
            expect.objectContaining({ title: 'sessionHandoff.cancelled.title' }),
        );
        expect(cancelled.screen.getTextContent()).toContain('sessionHandoff.cancelled.message');
        expect(findProgressIndicators(cancelled.screen)).toHaveLength(0);
        await expandProgressDetails(cancelled.screen);
        expect(cancelled.screen.findByTestId('session-handoff-operation-error')).toBeNull();
    });

    it('renders the committed workspace outcome from the canonical Action operation result', async () => {
        const { openObservedSessionHandoffProgressModal } = await import('./openSessionHandoffProgressModal');
        const store = createActionOperationStore();
        openObservedSessionHandoffProgressModal({
            requestId: 'handoff-request-outcome',
            sessionId: 'session-1',
            serverId: SERVER_ID,
            accountId: 'account-1',
            workspaceSyncEnabled: true,
            store,
        });

        merge(store, [runningSnapshot({
            requestId: 'handoff-request-outcome',
            revision: 2,
            state: 'succeeded',
            settledAt: 3,
            progress: undefined,
            result: {
                handoffId: 'handoff-1',
                status: {
                    handoffId: 'handoff-1',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
                workspace: {
                    kind: 'relationship',
                    relationshipId: 'relationship-1',
                    created: true,
                    cleanupWarning: { code: 'staging_release_failed', message: 'Staging could not be released.' },
                },
            },
        })]);
        const completed = await renderObservedModal(lastPushedOperation());

        expect(completed.screen.getTextContent()).toContain('sessionHandoff.workspaceOutcome.relationshipCreated');
        expect(completed.screen.getTextContent()).toContain('Staging could not be released.');
        expect(modalHideMock).not.toHaveBeenCalled();
    });
});
