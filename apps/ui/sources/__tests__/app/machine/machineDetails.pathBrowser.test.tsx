import React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

const boundary = vi.hoisted(() => ({
    params: { id: 'machine-1' } as Record<string, string>,
    push: vi.fn(),
    rpc: vi.fn(),
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => boundary.params, router: { push: boundary.push },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
// Presentation and human confirmation are boundaries; render the real modal body.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true, confirmResult: true,
}).module);
// The daemon is outside this UI process. Schemas, policy, dispatch and store reads stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults, settingsParse } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { Modal, ModalProvider } = await import('@/modal');
const { EmbeddedTerminalPaneFrame } = await import('@/components/terminal/embedded/EmbeddedTerminalPaneFrame');
const { AuthProvider } = await import('@/auth/context/AuthContext');

describe('Machine detail navigation and terminal entry', () => {
    let serverId: string;
    let scopeServerId: string;
    // The census and the exact by-id Machine read (read-batch) answer the same row.
    const answerMachineRow = (row: ReturnType<typeof createPlainMachineRowFixture>) => {
        home.answer(serverId, '/v1/machines', { body: [row] });
        home.answer(serverId, '/v1/machines/machine-1', { body: { machine: row } });
    };
    let disposeLoader: (() => void) | undefined;
    beforeEach(async () => {
        await standardCleanup();
        await loadSyncSingletonForTests();
        await home.reset();
        boundary.params = { id: 'machine-1' };
        boundary.push.mockReset();
        boundary.rpc.mockReset();
        boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.DAEMON_TERMINAL_ENSURE) return { ok: true, terminalId: 'machine-shell-pty', reused: false };
            if (method === RPC_METHODS.DAEMON_TERMINAL_LIST) return { ok: true, terminals: [], machineShell: { ok: true, cwd: '/Users/tester' } };
            if (method === RPC_METHODS.DAEMON_TERMINAL_CLOSE) return { ok: true };
            if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ) return { ok: true, terminalId: 'machine-shell-pty',
                events: [], nextCursor: 0, done: true };
            if (method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) return { ok: true, terminalId: 'machine-shell-pty',
                frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true };
            return { supported: false, reason: 'not-supported' };
        });
        serverId = await home.addHome({ name: 'Machine Home', serverUrl: 'https://machine-detail.test', serverIdentityId: 'srv_machine_detail', accountId: 'account-a', currentAccount: true });
        scopeServerId = getActiveServerSnapshot().serverId;
        answerMachineRow(createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }));
        await storage.getState().activateProfileScope({ serverId, accountId: 'account-a' });
        await storage.getState().activateSettingsScope({ serverId, accountId: 'account-a' });
        storage.getState().applySettings(settingsDefaults, (storage.getState().settingsVersion ?? 0) + 1);
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', activeAt: Date.now(), isShared: false })], true);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        disposeLoader = await installRealActionExecutorModuleLoader();
        vi.mocked(Modal.show).mockClear();
    });
    afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); disposeLoader?.(); disposeLoader = undefined; });

    const render = (body: React.ReactNode) => renderScreen(
        <AuthProvider initialCredentials={{ token: createAccountTokenForTests('account-a', { currentAccount: true }) }}>
            <AppPaneProvider><ModalProvider>{body}</ModalProvider></AppPaneProvider>
        </AuthProvider>,
    );

    it('shows the inherited effective host without implying that override-off disables hosting', async () => {
        storage.getState().applySettings({ ...settingsDefaults, sessionTerminalHost: 'herdr' }, (storage.getState().settingsVersion ?? 0) + 1);
        boundary.params = { id: 'machine-1', page: 'terminal' };
        const screen = await render(<MachineSubPageScreen />);
        expect(screen.findAllByTestId('machine-terminal-effective-host').some(row => row.props.subtitle === 'Herdr')).toBe(true);
    });

    it('keeps the Windows launch override on the Terminal page of a Windows machine, and only there', async () => {
        const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
        storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, platform: 'win32' } }], true);
        boundary.params = { id: 'machine-1', page: 'terminal' };
        const screen = await render(<MachineSubPageScreen />);
        expect(screen.findAll(node => node.props?.title === 'machine.windows.remoteSessionModeOverrideTitle').length).toBeGreaterThan(0);
        await screen.unmount();
        boundary.params = { id: 'machine-1' };
        const overview = await render(<MachinePageScreen />);
        expect(overview.findAll(node => node.props?.title === 'machine.windows.remoteSessionModeOverrideTitle')).toHaveLength(0);
        expect(overview.findByTestId('machine-page-row-terminal')).toBeTruthy();
    });

    it('shows the retained host choice even after an older UI removes its legacy tmux record', async () => {
        storage.getState().applySettings({ ...settingsDefaults, sessionTerminalHostByMachineId: { 'machine-1': 'herdr' }, sessionTmuxByMachineId: {} }, (storage.getState().settingsVersion ?? 0) + 1);
        boundary.params = { id: 'machine-1', page: 'terminal' };
        const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
        const screen = await render(<MachineSubPageScreen />);
        expect(screen.findAllByType(SegmentedChoiceItem).some(row => row.props.value === 'herdr')).toBe(true);
    });

    it('opens the composer with this machine chosen on its Home', async () => {
        boundary.params = { id: 'machine-1', serverId };
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        const scope = storage.getState().profileScope!;
        const screen = await render(<MachinePageScreen />);
        await screen.pressByTestIdAsync('machine-detail-start-session');
        const route = boundary.push.mock.calls.at(-1)?.[0] as { pathname: string; params: { draftId: string } };
        expect(route).toEqual({ pathname: '/new', params: { draftId: expect.any(String) } });
        expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId })).toMatchObject({
            selectedMachineId: 'machine-1', targetServerId: serverId,
            executionTarget: { kind: 'machine', target: { serverId, machineId: 'machine-1' } },
        });
    });

    it.each([
        { isShared: false, active: true, visible: true },
        { isShared: true, active: true, visible: true },
        { isShared: false, active: false, visible: false },
    ])('offers an admitted header Shell while online, including shared Machines ($isShared, $active)', async ({ isShared, active, visible }) => {
        const row = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
        const access = { ...row.access!, role: isShared ? 'use' as const : 'manage' as const };
        const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(), isShared, active, access,
            presenceProtocolVersion: 1 });
        answerMachineRow(createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine }));
        storage.getState().applyMachines([machine], true, { sourceServerId: scopeServerId, sourceAccountId: 'account-a' });
        observeMachinePresenceForTest({ serverId: scopeServerId, accountId: 'account-a' }, [machine.id]);
        const screen = await render(<MachinePageScreen />);
        await waitForHomeGovernance(() => expect(screen.findAll(node => node.props?.testID === 'machine-detail-open-terminal' && typeof node.props.onPress === 'function').length > 0).toBe(visible));
    });

    it('opens the admitted requester root even when Machine metadata has no home folder', async () => {
        const row = createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' });
        const metadata = { ...createMachineFixture().metadata!, homeDir: '' };
        answerMachineRow({ ...row, metadata: encodePlainMachineStoredContent(metadata) });
        storage.getState().applyMachines([], true);
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', activeAt: Date.now(), isShared: false, metadata })], true);
        const screen = await render(<MachinePageScreen />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-detail-open-terminal')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-detail-open-terminal');
        expect(screen.findAll(node => node.props?.testID === 'machine-terminal-waiting')).toHaveLength(0);
        expect(screen.findAllByType(EmbeddedTerminalPaneFrame).length).toBeGreaterThan(0);
        await act(async () => {
            for (const frame of screen.findAllByType(EmbeddedTerminalPaneFrame)) frame.props.controller.onReady(80, 24);
        });
        await flushHookEffects({ cycles: 3, turns: 2 });
        await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.[0])
            .toMatchObject({ payload: { cwd: '/Users/tester' } }));
    });

    it('says the terminal waits on the person and offers the Approvals shortcut when Ask first holds the open', async () => {
        await home.requireUiApproval(serverId, 'machines.terminal.open');
        const screen = await render(<MachinePageScreen />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-detail-open-terminal')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-detail-open-terminal');
        await act(async () => {
            for (const frame of screen.findAllByType(EmbeddedTerminalPaneFrame)) frame.props.controller.onReady(80, 24);
        });
        await flushHookEffects({ cycles: 3, turns: 2 });
        await waitForHomeGovernance(() => expect(screen.findAllByType(EmbeddedTerminalPaneFrame)[0]?.props.controller)
            .toMatchObject({ approvalPending: true, approvalId: expect.any(String) }));
        expect(screen.findByTestId('machine-terminal-state-line')).toBeTruthy();
        const action = screen.findByTestId('machine-terminal-state-line-action');
        expect(action).toBeTruthy();
        await act(async () => action?.props.onPress());
        expect(boundary.push).toHaveBeenCalledWith(expect.stringContaining('/inbox/approvals/'));
    });

    it.each([false, true])('opens the header shell through real Machine Action admission (Action disabled: %s)', async disabled => {
        if (disabled) {
            const settings = settingsParse({ ...storage.getState().settings,
                actionsSettingsV1: { v: 1, actions: { 'machines.terminal.open': { enabled: false } } },
            });
            // This Account is already restored: Action admission reads its live scoped policy before HTTP.
            storage.getState().applySettingsLocal({ actionsSettingsV1: settings.actionsSettingsV1 });
            home.answer(serverId, '/v2/account/settings', { body: {
                version: (storage.getState().settingsVersion ?? 0) + 1, content: { t: 'plain', v: settings },
            } });
        }
        const screen = await render(<MachinePageScreen />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('machine-detail-open-terminal')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-detail-open-terminal');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ serverId: scopeServerId, machineId: 'machine-1' }),
            chrome: expect.objectContaining({ testID: 'machine-terminal-modal' }),
        }));
        // react-test-renderer cannot deliver DOM geometry; deliver the actual renderer readiness event.
        await act(async () => {
            for (const frame of screen.findAllByType(EmbeddedTerminalPaneFrame)) frame.props.controller.onReady(80, 24);
        });
        await flushHookEffects({ cycles: 3, turns: 2 });
        if (disabled) {
            await waitForHomeGovernance(() => expect(screen.findAllByType(EmbeddedTerminalPaneFrame)[0]?.props.controller)
                .toMatchObject({ status: 'error', error: 'action_disabled' }));
            expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toHaveLength(0);
            return;
        }
        await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toHaveLength(1));
        const request = boundary.rpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)?.[0];
        expect(request).toMatchObject({ serverId: scopeServerId, machineId: 'machine-1', payload: {
            cwd: '/Users/tester', terminalKey: expect.stringMatching(/^machine-shell:machine-1:/),
        } });
    });
});
