import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WorkspaceSyncRelationshipsListRpcResultV1Schema, type WorkspaceSyncStatusV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { expandDisclosureAsync, renderScreen } from '@/dev/testkit';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';
import { createWorkspaceSyncStatusWatchBoundary } from '@/dev/testkit/harness/workspaceSyncStatusWatchBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

installSessionHandoffCommonModuleMocks({
    storage: () => vi.importActual('@/sync/domains/state/storage'),
    modal: () => vi.importActual('@/modal'),
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Test Renderer has no DOM for the SDK's focus and outside-dismiss listeners.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());

const watch = createWorkspaceSyncStatusWatchBoundary();
const reads: string[] = [];
let statuses: readonly WorkspaceSyncStatusV1[] = [];
let refuseStatusRead = false;
const refusal = {
    error: 'Request refused', errorCode: 'credential_scope_denied', effectAttempted: false,
    failureCause: { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: 403 },
};
const dispatchReason = 'Synthetic Workspace Sync dispatch description';
const dispatchToken = 'fixture-sync-dispatch-token';
const flushRefusal = { ...refusal, errorCode: 'outcome_unknown' };
let flushFailure = flushRefusal;
const workspace = createWorkspaceSyncHarness(async request => {
    if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH) {
        return watch.watch({ ...(request.payload as { sinceRevision?: number }), signal: request.signal });
    }
    reads.push(request.method);
    if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH) return flushFailure;
    if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET) {
        if (refuseStatusRead) return refusal;
        const { relationshipId } = request.payload as { relationshipId: string };
        return { status: statuses.find(status => status.relationshipId === relationshipId) ?? null };
    }
    if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST) {
        if (refuseStatusRead) return refusal;
        const { storage } = await import('@/sync/domains/state/storage');
        return WorkspaceSyncRelationshipsListRpcResultV1Schema.parse({ controllerMachineId: request.machineId,
            sets: [], relationships: storage.getState().projectAccountRows?.relationships.map(definition => ({
                definition, status: statuses.find(status => status.relationshipId === definition.relationshipId) ?? null,
            })) ?? [], remoteRelationships: [], membership: { workspaceRefId: null, found: null }, discoveryAvailable: true });
    }
    throw new Error(`Unexpected Sync list request: ${request.method}`);
});
await workspace.ready;
const { WorkspaceSyncRelationshipList, WorkspaceSyncRelationshipRow } = await import('@/components/workspaces/sync/WorkspaceSyncRelationshipList');
let restoreLoader: (() => void) | undefined;

beforeEach(async () => {
    await workspace.reset();
    restoreLoader = await installRealActionExecutorModuleLoader();
    await workspace.seedProject({ includeThirdEndpoint: true });
    statuses = ['link-1', 'link-2'].map(relationshipId => ({ relationshipId, controllerMachineId: 'machine-a',
        state: 'watching', alphaPath: '/hub', betaPath: '/spoke', mode: 'keep_both_in_sync',
        endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: 1 }));
    reads.length = 0;
    refuseStatusRead = false;
    flushFailure = flushRefusal;
});
afterEach(async () => { watch.reset(); await workspace.dispose(); restoreLoader?.(); vi.unstubAllGlobals(); });

it('keeps the Sync list at one read per controller, zero per rerender, with pushed status updates', async () => {
    // Observed baseline: two relationships on one controller share one list read and one parked watch.
    const screen = await renderScreen(<WorkspaceSyncRelationshipList serverId={workspace.serverId} />);
    try {
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await vi.waitFor(() => expect(watch.parkedCount()).toBe(1));
        for (const title of ['Copies', 'Linked folders', 'Workspace sync']) {
            await act(async () => screen.update(<WorkspaceSyncRelationshipList serverId={workspace.serverId} title={title} />));
        }
        expect(reads).toHaveLength(1);
        await act(async () => watch.publish(statuses.map(status => ({ ...status, state: 'disconnected' }))));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.state.peerOffline'));
        expect(reads).toHaveLength(1);
    } finally { await screen.unmount(); }
});

it.each(['off', 'allowed'] as const)('reveals a local endpoint through the real open-path Action (%s)', async policy => {
    await workspace.home.setActionPolicy(workspace.serverId, 'relay.runtime.open_path', 'ui', policy);
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const { useWorkspaceSyncRelationshipSummaries } = await import('@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries');
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    function LocalRow() {
        const summary = useWorkspaceSyncRelationshipSummaries(undefined, workspace.serverId)[0];
        return summary ? <WorkspaceSyncRelationshipRow summary={summary} localMachineId="machine-a" /> : null;
    }
    const screen = await renderScreen(<LocalRow />);
    try {
        await act(async () => screen.findByType(DropdownMenu).props.onSelect('reveal-alpha'));
        if (policy === 'allowed') {
            await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('system_tasks_open_log_path', { path: '/hub' }));
        } else {
            expect(invoke).not.toHaveBeenCalled();
        }
    } finally { await screen.unmount(); }
});

it.each([
    { phase: 'rpc.admission.machine', error: refusal.error },
    { phase: 'dispatch', error: `${dispatchReason}; token=${dispatchToken}`, reason: dispatchReason },
])('lets the person inspect a refused Sync now with the real Action references ($phase)', ({ phase, error, reason }) => withPopoverWebGlobals(async () => {
    flushFailure = { ...flushRefusal, error, failureCause: { ...refusal.failureCause, phase } };
    const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
    const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
    const { readActionFailureDetails } = await import('@/dev/testkit/fixtures/actionFailureDetails');
    let activeAlert: import('@/modal/types').AlertModalConfig | undefined;
    function ObserveAlerts() {
        activeAlert = useModal().state.modals.find((modal): modal is import('@/modal/types').AlertModalConfig =>
            modal.type === 'alert' && 'visible' in modal && modal.visible === true);
        return null;
    }
    await workspace.home.setActionPolicy(workspace.serverId, 'workspace.sync.relationship.flush', 'ui', 'allowed');
    const screen = await renderScreen(<WorkspaceSyncRelationshipList serverId={workspace.serverId} />, {
        wrapper: ({ children }) => <ModalProvider><ObserveAlerts />{children}</ModalProvider>,
    });
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.state.watching'));
        await act(async () => screen.findAllByType(DropdownMenu)[0]?.props.onSelect('sync'));
        await vi.waitFor(() => expect(reads).toContain(RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH));
        await vi.waitFor(() => expect(activeAlert?.message).toBe('workspaceSync.error.manageRequired'));
        expect(screen.getTextContent()).not.toContain(phase);
        await screen.pressByTestIdAsync('web-modal-button-0');
        await vi.waitFor(() => expect(activeAlert?.title).toBe('approvals.technicalDetails'));
        const details = readActionFailureDetails(activeAlert?.message);
        expect(details).toMatchObject({
            code: 'outcome_unknown', causePhase: phase, causeCode: 'machine_manage_required',
            effectAttempted: 'false', httpStatus: '403', requestId: expect.any(String),
        });
        if (reason) expect(details.reason).toContain(reason);
        expect(activeAlert?.message).not.toContain(dispatchToken);
    } finally { await screen.unmount(); }
}));

it('keeps Retry and exposes the typed refusal on an unavailable Sync status', async () => {
    refuseStatusRead = true;
    const screen = await renderScreen(<WorkspaceSyncRelationshipList serverId={workspace.serverId} />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.error.manageRequired'));
        expect(screen.getTextContent()).not.toContain('rpc.admission.machine');
        await expandDisclosureAsync(screen.findAllByTestId('workspace-sync-relationship-link-1-status-technical-details'), 'status refusal details');
        expect(screen.getTextContent()).toContain('rpc.admission.machine');
        expect(screen.getTextContent()).toContain('machine_manage_required');

        refuseStatusRead = false;
        await screen.pressByTestIdAsync('workspace-sync-relationship-link-1-status-retry');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('workspaceSync.state.watching'));
    } finally { await screen.unmount(); }
});
