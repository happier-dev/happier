import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, renderHook, renderScreen, type RenderHookResult } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { DaemonLocalServiceLauncherSnapshotRequestV1Schema, LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const rpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const { storage } = await import('@/sync/domains/state/storage');
const { resetLocalServiceInventoryStoreForTests } = await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } = await import('@/sync/domains/local/services/launch/sharedStore');
const { useBrowserSurfaceHostFeed } = await import('@/components/browser/surfaces/useBrowserSurfaceHostProps');
const { LocalServicesSurfaceHost } = await import('./LocalServicesSurfaceHost');

afterEach(async () => {
    resetLocalServiceLauncherStoreForTests();
    resetLocalServiceInventoryStoreForTests();
    vi.restoreAllMocks();
    await home.reset();
});

it('shares the Session workspace feed between the real Services pane and Browser launchpad', async () => {
    const serverId = await home.addHome({ name: 'Session services', serverUrl: 'https://session-services.test', accountId: 'account', currentAccount: true });
    const previous = storage.getState();
    const machine = createMachineFixture({ id: 'machine-a' });
    storage.setState({ sessions: { 'session-a': createSessionFixture({ id: 'session-a', serverId,
        metadata: { machineId: 'machine-a', path: '/repo/session-checkout', host: 'devbox', homeDir: '/home/person' } }) },
        machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    // The declared, stopped Service shape used by the launchpad's Ready to start section.
    const targets = ['/repo/session-checkout', '/repo/other-checkout'].map((rootPath, index) => LocalServiceLaunchTargetV1Schema.parse({
        id: `managed:web-${index}`, source: 'managed_service', machineId: 'machine-a', sessionId: 'session-a',
        title: index === 0 ? 'Session Web' : 'Other workspace Web', cwd: rootPath,
        workspace: { serverId, machineId: 'machine-a', workspaceId: `workspace-${index}`, rootPath },
        declaration: { workspaceRefId: `workspace-${index}`, selection: { kind: 'manifest', name: 'web' } },
        serviceState: 'stopped', confidence: 'high', state: 'available', actions: ['start'],
    }));
    const reads: unknown[] = [];
    // Only the Machine RPC boundary is replaced: query resolution, stores, wire parsing,
    // row grouping, the pane and Browser feed all run their production implementation.
    vi.spyOn(rpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof rpc.machineRpcWithServerScope>[0]) => {
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
            return await new Promise<Response>((_resolve, reject) => {
                request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            });
        }
        let response: unknown;
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
            response = { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1000,
                refreshState: 'idle', entries: [], diagnostics: [] } };
        } else if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) {
            const input = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse(request.payload);
            reads.push(input);
            response = { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 1000,
                targets: input.workspaceRoot && input.scope !== 'machine' ? targets.filter(target => target.cwd === input.workspaceRoot) : targets } };
        } else throw new Error(`Unexpected RPC ${request.method}`);
        return response as Response; // Generic network response is validated by the real RPC adapters.
    });
    const pane = await renderScreen(<LocalServicesSurfaceHost machineId="machine-a" serverId={serverId}
        sessionId="session-a" pluginUiProjection={null} testID="session-services" />);
    let browser: RenderHookResult<ReturnType<typeof useBrowserSurfaceHostFeed>, void> | undefined;
    try {
        await waitForHomeGovernance(() => expect(pane.getTextContent()).toContain('Session Web'));
        expect(pane.getTextContent()).not.toContain('Other workspace Web');
        const paneReads = reads.length;
        browser = await renderHook(() => useBrowserSurfaceHostFeed({ machineId: 'machine-a', serverId, sessionId: 'session-a',
            localServicePreviewState: null }));
        await waitForHomeGovernance(() => expect(browser?.getCurrent().feed.rows.map(row => row.title)).toEqual(['Session Web']));
        expect(reads).toHaveLength(paneReads);
    } finally {
        await browser?.unmount();
        await pane.unmount();
        storage.setState(previous, true);
    }
});
