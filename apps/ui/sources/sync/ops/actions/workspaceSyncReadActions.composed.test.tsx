import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { WorkspaceSyncRelationshipsListRpcResultV1Schema, type WorkspaceSyncStatusV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { renderScreen } from '@/dev/testkit';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';
import { createWorkspaceSyncStatusWatchBoundary } from '@/dev/testkit/harness/workspaceSyncStatusWatchBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';

installSessionHandoffCommonModuleMocks({ storage: () => vi.importActual('@/sync/domains/state/storage') });
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const watch = createWorkspaceSyncStatusWatchBoundary();
const reads: string[] = [];
let statuses: readonly WorkspaceSyncStatusV1[] = [];
const workspace = createWorkspaceSyncHarness(async request => {
    if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH) {
        return watch.watch({ ...(request.payload as { sinceRevision?: number }), signal: request.signal });
    }
    reads.push(request.method);
    if (request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST) {
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
