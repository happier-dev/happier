import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createServedTerminalActionRelay, servedMachineActionRelayInstallationPublicKey } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { EmbeddedTerminalPaneFrame } from '@/components/terminal/embedded/EmbeddedTerminalPaneFrame';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { CustomModalDismissGuard } from '@/modal/types';

// Machine RPC and xterm are transport/platform boundaries; the sheet, controller,
// request builder, Action admission and protocol parsing remain real.
const rpc = vi.hoisted(() => vi.fn());
// test-policy-boundary: Machine RPC crosses to the daemon outside the UI process.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle, { onReady(cols: number, rows: number): void }>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ write: () => {}, clear: () => {}, hasSelection: () => false, getSelectionText: () => '' }), []);
        return React.createElement('xterm-boundary', { onReady: props.onReady });
    }),
}));

const { showMachineTerminalSheet } = await import('./MachineTerminalSheet');
const { Modal } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storageStore');

afterEach(() => standardCleanup());

it.each(['service', 'machine'] as const)('requests a %s shell through the existing sheet and real terminal Action', async kind => {
    const machine = createMachineFixture({ id: `sheet-${kind}`, active: true, activeAt: Date.now() });
    const row = { ...createPlainMachineRowFixture({ id: machine.id, accountId: 'sheet-owner', machine }),
        installationPublicKey: await servedMachineActionRelayInstallationPublicKey() };
    const serverUrl = `https://sheet-${kind}.test`;
    const serverIdentityId = `srv_sheet_${kind}`;
    let relay: Awaited<ReturnType<typeof createServedTerminalActionRelay>> | undefined;
    const home = await serveActionHomes({
        homes: [{ key: 'owner', serverUrl, serverIdentityId,
            accountId: 'sheet-owner', currentAccount: true,
            settings: { featureToggles: { 'terminal.embeddedPty': true },
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                    'machines.terminal.open': ['ui'], 'machines.terminal.close': ['ui'],
                } } } }],
        route: async request => (await relay?.handle(request)) ?? (request.path === '/v1/machines' ? Response.json([row])
            : request.path === '/v1/machines/read-batch'
            ? createMachineReadBatchResponseFixture(request.body, () => row)
            : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(createRootLayoutFeaturesResponse({ features: { terminal: { embeddedPty: { enabled: true } } } }))
            : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined),
    });
    const serverId = home.homes.owner!.id;
    relay = await createServedTerminalActionRelay({ machineIds: [machine.id],
        homes: [{ serverId, serverUrl, serverIdentityId, accountId: 'sheet-owner' }],
        machineRpc: request => rpc(request) });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await getServerFeaturesSnapshot({ serverId, force: true });
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    await publishMachineInventoryForTest({ serverId, accountId: 'sheet-owner' }, [machine]);
    rpc.mockReset();
    const terminalId = 'owned-pty';
    rpc.mockImplementation(async ({ method }) => {
        if (method === RPC_METHODS.DAEMON_TERMINAL_ENSURE) return { ok: true, terminalId, reused: false };
        if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) {
            return { ok: true, terminalId, frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true };
        }
        return { ok: true };
    });
    const launch = { kind: 'service_shell' as const, serviceId: 'environment-instance/app', expectedGeneration: 'generation-a' };
    showMachineTerminalSheet({ serverId, machineId: machine.id, machineName: 'Box',
        ...(kind === 'service' ? { launch } : { machineShell: { ok: true as const, cwd: '/owner/home' } }) });
    const config = vi.mocked(Modal.show).mock.calls.at(-1)![0] as {
        component: React.ComponentType<Record<string, unknown>>;
        props: Record<string, unknown>;
        onDismissRequest?: CustomModalDismissGuard;
    };
    const Card = config.component;
    function SheetFixture() {
        const presence = useMachinePresenceSummary(serverId, machine.id);
        return <>{React.createElement('sheet-fixture-presence', presence)}<Card {...config.props} /></>;
    }
    try {
        const screen = await renderScreen(<SheetFixture />);
        try {
            await flushHookEffects();
            const presence = () => screen.findByType('sheet-fixture-presence').props;
            expect(presence().reachability, JSON.stringify(presence())).toBe('reachable');
            const renderer = screen.findByType('xterm-boundary');
            expect(typeof renderer.props.onReady).toBe('function');
            await act(async () => renderer.props.onReady(80, 24));
            const openRequests = () => rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE);
            await vi.waitFor(() => {
                const controller = screen.findByType(EmbeddedTerminalPaneFrame).props.controller;
                expect(openRequests(), JSON.stringify({ presence: presence(), rendererReady: { cols: 80, rows: 24 },
                    status: controller.status, error: controller.error })).toHaveLength(1);
            });
            const request = openRequests()[0]![0];
            expect(request).toMatchObject({ serverId, machineId: machine.id });
            if (kind === 'service') {
                expect(request.payload.launch).toEqual(launch);
                expect(request.payload).not.toHaveProperty('cwd');
                expect(request.payload).not.toHaveProperty('workspace');
            } else {
                expect(request.payload.cwd).toBe('/owner/home');
                expect(request.payload).not.toHaveProperty('launch');
            }
            await vi.waitFor(() => expect(screen.findByType(EmbeddedTerminalPaneFrame).props.controller.terminalId).toBe(terminalId));
            await act(async () => { expect(await config.onDismissRequest?.('shared')).toBe(true); });
            expect(rpc.mock.calls.filter(([entry]) => entry.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE))
                .toMatchObject([[{ serverId, machineId: machine.id, payload: { terminalId } }]]);
        } finally { await screen.unmount(); }
        expect(rpc.mock.calls.filter(([entry]) => entry.method === RPC_METHODS.DAEMON_TERMINAL_CLOSE)).toHaveLength(1);
    } finally { await home.dispose(); }
});

// A settled Shell consumes the requester's admitted root, so resource samples
// and unrelated custodian metadata never redraw its card.
it('keeps the terminal card quiet for its Machine\'s resource samples', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const base = createMachineFixture({ id: 'terminal-machine', active: true, activeAt: Date.now() });
    let machine: Machine = { ...base, metadata: { ...base.metadata!, homeDir: '/custodian/private' },
        daemonState: { status: 'running', pid: 1, startedAt: 1, contributionRegistryProjectionRevision: 1 } as Machine['daemonState'], daemonStateVersion: 1 };
    storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
    showMachineTerminalSheet({ serverId, machineId: machine.id, machineName: 'Box', machineShell: { ok: true, cwd: '/members/bob' } });
    const config = vi.mocked(Modal.show).mock.calls.at(-1)![0] as { component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
    let renders = 0;
    const Card = config.component;
    const screen = await renderScreen(<React.Profiler id="card" onRender={() => { renders += 1; }}><Card {...config.props} /></React.Profiler>);
    try {
        await flushHookEffects();
        expect(screen.findByTestId('machine-terminal-waiting')).toBeNull();
        renders = 0;
        for (let sample = 1; sample <= 3; sample++) {
            machine = { ...machine, daemonStateVersion: (machine.daemonStateVersion ?? 0) + 1,
                daemonState: { ...(machine.daemonState ?? {}), resources: { v: 1, sampledAt: sample } } as Machine['daemonState'] };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
        }
        expect(renders).toBe(0);
    } finally { await screen.unmount(); }
});
