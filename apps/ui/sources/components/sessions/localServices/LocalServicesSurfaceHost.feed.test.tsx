import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { act, createMachineFixture, createSessionFixture, renderHook, renderScreen, type RenderHookResult } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { DaemonLocalServiceLauncherSnapshotRequestV1Schema, LocalServiceLaunchTargetV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { t } from '@/text';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const rpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const { storage } = await import('@/sync/domains/state/storage');
const { resetLocalServiceInventoryStoreForTests } = await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } = await import('@/sync/domains/local/services/launch/sharedStore');
const { useBrowserSurfaceHostFeed } = await import('@/components/browser/surfaces/useBrowserSurfaceHostProps');
const { LocalServicesSurfaceHost } = await import('./LocalServicesSurfaceHost');
const { SessionRightPanelServicesView } = await import('../panes/services/SessionRightPanelServicesView');
const { getLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch/sharedStore');
const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');

afterEach(async () => {
    resetLocalServiceLauncherStoreForTests();
    resetLocalServiceInventoryStoreForTests();
    vi.restoreAllMocks();
    await home.reset();
});

it.each(['empty', 'refused', 'unbound'] as const)('settles a VIEW recipient Services read as %s without owner Machine metadata', async outcome => {
    const serverId = await home.addHome({ name: 'Recipient', serverUrl: 'https://recipient-services.test', accountId: 'qa-verify-1116c', currentAccount: true });
    const previous = storage.getState();
    storage.setState({ sessions: { 'session-a': createSessionFixture({ id: 'session-a', serverId, accessLevel: 'view',
        metadataLayoutVersion: 1, metadata: null, ownerMetadataView: null,
        ...(outcome === 'unbound' ? {} : { computerMachineBinding: { homeId: serverId, machineId: 'machine-a' } }) }) },
        machines: {}, machineListByServerId: { [serverId]: [] } });
    const reads: string[] = [];
    // Only the daemon transport is substituted; recipient identity, hooks, stores,
    // wire parsing and the rendered loading/empty/refusal states remain real.
    vi.spyOn(rpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof rpc.machineRpcWithServerScope>[0]) => {
        if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
            return await new Promise<Response>((_resolve, reject) => {
                request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
            });
        }
        reads.push(request.method);
        const response = request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT
            ? outcome === 'refused' ? { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Access denied' }
                : { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 1000, targets: [] } }
            : { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1000, refreshState: 'idle', entries: [], diagnostics: [] } };
        return response as Response; // Real adapters validate the external network reply.
    });
    const pane = await renderScreen(<SessionRightPanelServicesView sessionId="session-a" serverId={serverId} pluginUiProjection={null} />);
    try {
        await waitForHomeGovernance(() => expect(pane.findByTestId(`session-rightpanel-services-${outcome === 'empty' ? 'empty' : 'error'}`)).toBeTruthy());
        if (outcome === 'unbound') {
            expect(reads).toEqual([]);
            await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
                'session-a': { ...state.sessions['session-a']!, computerMachineBinding: { homeId: serverId, machineId: 'machine-a' } } } })));
            await waitForHomeGovernance(() => expect(pane.findByTestId('session-rightpanel-services-empty')).toBeTruthy());
        }
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://recipient-services.test');
        if (!credentials) throw new Error('Missing recipient fixture credentials');
        const state = getLocalServiceLauncherState({ serverId, machineId: 'machine-a', sessionId: 'session-a',
            scope: 'workspace', workspaceRoot: null, accountId: 'qa-verify-1116c', credentialKey: resolveAuthCredentialsScopeKey(credentials) });
        expect(state).toMatchObject(outcome === 'refused' ? { refreshStatus: 'error', refreshError: RPC_ERROR_CODES.FORBIDDEN }
            : { refreshStatus: 'idle', updatedAt: 1000, targetIds: [] });
        if (outcome === 'refused') expect(pane.getTextContent()).toContain(t('localServices.actions.failure.refused'));
        expect(reads.filter(method => method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)).toHaveLength(1);
    } finally {
        await pane.unmount();
        storage.setState(previous, true);
    }
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
