import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createDeferred, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { EmbeddedTerminalPaneFrame } from '@/components/terminal/embedded/EmbeddedTerminalPaneFrame';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { Modal } from '@/modal';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

// Machine RPC and the terminal DOM renderer are external boundaries. The mounted
// header, Action front door, schemas, adapter and terminal controller stay real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle, { onReady(cols: number, rows: number): void }>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ write: () => {}, clear: () => {}, hasSelection: () => false, getSelectionText: () => '' }), []);
        React.useEffect(() => { props.onReady(80, 24); }, []);
        return React.createElement('xterm-boundary');
    }),
}));

const { MachinePageHeader } = await import('./MachinePageHeader');
afterEach(() => standardCleanup());

it.each([
    { role: 'manage', refusal: null },
    { role: 'use', refusal: null },
    { role: 'manage', refusal: 'terminal_unavailable' },
    { role: 'manage', refusal: 'terminal_forbidden' },
] as const)('settles a shared $role Shell through the real header and Action ($refusal)', async ({ role, refusal }) => {
    let machine = createMachineFixture({ id: 'shared-shell', isShared: true, active: true, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, homeDir: '/custodian/private' },
        access: { role, resourceMode: 'plain', accessState: 'ready', custodian: { accountId: 'alice', displayName: 'Alice' } } });
    const serverUrl = `https://shared-shell-${role}.test`;
    const serverIdentityId = `srv_shared_shell_${role}`;
    let cwd = '/members/bob';
    let pendingAvailability: Promise<unknown> | null = null;
    const availabilityReads: Array<{ input: unknown }> = [];
    const authenticatedAccounts: Array<string | null> = [];
    const openedShells: unknown[] = [];
    const listBoundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'bob',
        custodian: { accountId: 'alice', displayName: 'Alice' }, machineId: machine.id,
        actionId: 'machines.terminal.list', tokenEpoch: 0, requesterInvocation: 'credentials', execute: input => {
            availabilityReads.push({ input });
            return refusal ? { ok: false, errorCode: refusal, error: refusal }
                : pendingAvailability ?? { ok: true, terminals: [], machineShell: { ok: true, cwd, ...(role === 'use' ? { preparation: 'member_not_prepared' } : {}) } };
        }, failure: () => refusal ? { errorCode: refusal, error: refusal } : null });
    const openBoundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId: 'bob',
        custodian: { accountId: 'alice', displayName: 'Alice' }, machineId: machine.id,
        actionId: 'machines.terminal.open', tokenEpoch: 0, requesterInvocation: 'credentials', execute: input => {
            openedShells.push(input);
            return { ok: false, errorCode: 'terminal_forbidden', error: 'foreign_terminal' };
        } });
    const row = () => ({ ...createPlainMachineRowFixture({ id: machine.id, accountId: 'alice', machine }),
        installationPublicKey: listBoundary.machine.installationPublicKey });
    const home = await serveActionHomes({ homes: [{ key: 'member', serverUrl, serverIdentityId, accountId: 'bob', currentAccount: true }],
        route: async request => {
            if (request.path === '/v1/machines') return Response.json([row()]);
            if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body, () => row());
            if (request.path === `/v1/machines/${machine.id}`) return Response.json({ machine: row() });
            if (request.path.startsWith('/v1/actions/')) authenticatedAccounts.push(request.accountId);
            const init = { method: request.method, headers: request.headers, body: JSON.stringify(request.body), signal: request.signal };
            return await listBoundary.handle(request.url, init) ?? await openBoundary.handle(request.url, init) ?? undefined;
        } });
    const serverId = home.homes.member!.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await publishMachineInventoryForTest({ serverId, accountId: 'bob' }, [machine]);
    rpc.mockReset();
    rpc.mockResolvedValue({ ok: false, errorCode: 'terminal_forbidden', error: 'foreign_terminal' });
    const listReads = () => availabilityReads;
    const body = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented}>
        <MachinePageHeader target={{ machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId,
            machine, machineName: 'Shared box', machineSentenceName: 'Shared box', isServerSwitching: false,
            isHydratingMachine: false, switchReady: true }} managedIdentity={null} renaming={false} onRename={() => {}} />
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(body(false));
    try {
        await flushHookEffects();
        expect(listReads()).toHaveLength(0);
        await screen.update(body(true));
        if (refusal) {
            await vi.waitFor(() => expect(screen.findByTestId('machine-detail-shell-unavailable')).not.toBeNull());
            expect(screen.findByTestId('machine-detail-open-terminal')).toBeNull();
            const line = screen.findByType(SurfaceFreshnessLine);
            expect(line.props.reason).toBe(t(refusal === 'terminal_forbidden' ? 'machines.terminals.denied' : 'machines.terminals.unavailable'));
            await act(async () => line.props.action.onPress());
            expect(vi.mocked(Modal.alert).mock.calls.at(-1)).toEqual([t('approvals.technicalDetails'), refusal]);
            expect(listReads()).toHaveLength(1);
            expect(openedShells).toHaveLength(0);
            return;
        }
        await vi.waitFor(() => expect(screen.findByTestId('machine-detail-open-terminal')).not.toBeNull());
        expect(listReads()).toHaveLength(1);
        expect(listReads()[0]).toMatchObject({ input: { serverId, machineId: machine.id, machineShell: true } });
        expect(authenticatedAccounts.length).toBeGreaterThan(0);
        expect(authenticatedAccounts.every(accountId => accountId === 'bob')).toBe(true);
        for (let sample = 1; sample <= 3; sample++) {
            machine = { ...machine, daemonStateVersion: sample + 1 };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            await screen.update(body(true));
        }
        const changedPolicy = createDeferred<unknown>();
        pendingAvailability = changedPolicy.promise;
        machine = { ...machine, metadata: { ...machine.metadata!, agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } };
        await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
        await screen.update(body(true));
        await vi.waitFor(() => expect(listReads()).toHaveLength(2));
        expect(screen.findByTestId('machine-detail-open-terminal')).toBeNull();
        cwd = '/members/bob/new-policy';
        await act(async () => changedPolicy.resolve({ ok: true, terminals: [], machineShell: { ok: true, cwd } }));
        pendingAvailability = null;
        await vi.waitFor(() => expect(screen.findByTestId('machine-detail-open-terminal')).not.toBeNull());
        await screen.update(body(false));
        await flushHookEffects();
        expect(listReads()).toHaveLength(2);
        await screen.update(body(true));
        await vi.waitFor(() => expect(listReads()).toHaveLength(3));
        await vi.waitFor(() => expect(screen.findByTestId('machine-detail-open-terminal')).not.toBeNull());
        await act(async () => screen.findByTestId('machine-detail-open-terminal')!.props.onPress());
        const config = vi.mocked(Modal.show).mock.calls.at(-1)![0] as {
            component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> };
        const Card = config.component;
        const sheet = await renderScreen(<Card {...config.props} />);
        try {
            await vi.waitFor(() => expect(openedShells).toHaveLength(1));
            expect(openedShells[0]).toMatchObject({ serverId, machineId: machine.id, cwd: '/members/bob/new-policy' });
            await vi.waitFor(() => expect(sheet.findByType(EmbeddedTerminalPaneFrame).props.controller)
                .toMatchObject({ status: 'error', terminalId: null, error: 'terminal_forbidden' }));
            expect(openedShells).toHaveLength(1);
        } finally { await sheet.unmount(); }
    } finally { await screen.unmount(); await home.dispose(); }
});

it.each([
    { ok: false, errorCode: 'terminal_cwd_denied', error: 'requester_root_unavailable' },
    undefined,
])('keeps Shell unavailable when terminal listing has no admitted requester root: %j', async machineShell => {
    const machine = createMachineFixture({ id: 'unavailable-shell', isShared: false, active: true, activeAt: Date.now() });
    const row = createPlainMachineRowFixture({ id: machine.id, accountId: 'bob', machine });
    const home = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: `https://unavailable-shell-${machineShell ? 'denied' : 'old'}.test`,
        accountId: 'bob', currentAccount: true }], route: request => request.path === '/v1/machines/read-batch'
        ? createMachineReadBatchResponseFixture(request.body, () => row) : undefined });
    const serverId = home.homes.owner!.id;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await publishMachineInventoryForTest({ serverId, accountId: 'bob' }, [machine]);
    rpc.mockReset();
    rpc.mockResolvedValue({ ok: true, terminals: [], ...(machineShell ? { machineShell } : {}) });
    const screen = await renderScreen(<MachinePageHeader target={{ machineId: machine.id, requestedServerId: serverId,
        serverId, activeServerId: serverId, machine, machineName: 'Box', machineSentenceName: 'Box', isServerSwitching: false,
        isHydratingMachine: false, switchReady: true }} managedIdentity={null} renaming={false} onRename={() => {}} />);
    try {
        await vi.waitFor(() => expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_LIST)).toHaveLength(1));
        await flushHookEffects();
        expect(screen.findByTestId('machine-detail-open-terminal')).toBeNull();
        if (machineShell) {
            expect(screen.findByType(SurfaceFreshnessLine).props.reason).toBe(t('terminalEmbedded.errors.cwdDenied'));
            await act(async () => screen.findByType(SurfaceFreshnessLine).props.action.onPress());
            expect(vi.mocked(Modal.alert).mock.calls.at(-1)).toEqual([t('approvals.technicalDetails'), machineShell.errorCode]);
        }
    } finally { await screen.unmount(); await home.dispose(); }
});
