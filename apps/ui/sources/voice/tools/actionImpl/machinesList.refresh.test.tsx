import * as React from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';

const home = createHomeGovernanceHarness();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const disposeExecutorLoader = await installRealActionExecutorModuleLoader();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { MachineHomeUnreadableRow } = await import('@/components/settings/machines/collection/MachineCollectionList');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');
const initial = storage.getState();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;

function answerMachineRead(machineId: string): void {
    home.answer(serverId, 'GET /v1/machines', { body: [createPlainMachineRowFixture({ id: machineId, accountId: 'alice' })] });
}

beforeEach(async () => {
    await home.reset();
    storage.setState(initial, true);
    serverId = await home.addHome({ name: 'Home', serverUrl: 'https://machine-refresh.test', accountId: 'alice' });
    answerMachineRead('cached-machine');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-refresh.test', accountId: 'alice' });
    installHomeGovernanceBoundaries(home);
    const cached = createMachineFixture({ id: 'cached-machine' });
    storage.setState({ machines: { [cached.id]: cached }, machineListByServerId: { [serverId]: [cached] },
        machineListStatusByServerId: { [serverId]: 'idle' }, settings: { ...storage.getState().settings,
            voice: { ...storage.getState().settings.voice, privacy: { ...storage.getState().settings.voice.privacy, shareDeviceInventory: false } } } });
});
afterEach(async () => {
    standardCleanup();
    await act(async () => { await connection.dispose(); });
    await home.reset();
    storage.setState(initial, true);
});

it('refreshes through the real UI Action, fetch/apply owner and inventory store while preserving Voice privacy', async () => {
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('machines.list', { serverId, refresh: true }, { surface: 'voice', serverId }))
        .toMatchObject({ ok: false, errorCode: 'privacy_disabled' });
    expect(storage.getState().machines['cached-machine']).toBeDefined();
    answerMachineRead('new-machine');
    const result = await executor.execute('machines.list', { serverId, refresh: true }, { surface: 'ui', serverId });
    expect(result).toMatchObject({ ok: true, result: { items: [{ machineId: 'new-machine' }] } });
    expect(storage.getState().machines['cached-machine']).toBeUndefined();
    expect(storage.getState().machines['new-machine']).toBeDefined();
});

it('the collection Retry invokes that same Action and publishes the freshly loaded machine', async () => {
    const screen = await renderScreen(React.createElement(MachineHomeUnreadableRow, {
        group: { serverId, serverName: 'Home' }, canRetry: true, compact: false,
    }));
    answerMachineRead('new-machine');
    await screen.pressByTestIdAsync('settings.machines.unreadable.retry');
    await waitForTestEvent(storage.subscribe, () => storage.getState().machines['new-machine'], machine => machine !== undefined);
    expect(storage.getState().machines['new-machine']).toBeDefined();
    expect(storage.getState().machines['cached-machine']).toBeUndefined();
});

it('explains when the focused Home refuses its Machine collection Retry', async () => {
    await home.setActionPolicy(serverId, 'machines.list', 'ui', 'off');
    const screen = await renderScreen(React.createElement(MachineHomeUnreadableRow, {
        group: { serverId, serverName: 'Home' }, canRetry: true, compact: false,
    }));
    vi.mocked(Modal.alert).mockClear();
    try {
        await screen.pressByTestIdAsync('settings.machines.unreadable.retry');
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(
            t('common.error'), t('actionConfirmations.turnedOffUnnamedMessage'),
        ));
        expect(storage.getState().machines['cached-machine']).toBeDefined();
        expect(storage.getState().machines['new-machine']).toBeUndefined();
    } finally {
        await screen.unmount();
    }
});

it('keeps cached reads and retains the last-known inventory when an explicit refresh fails', async () => {
    const current = storage.getState().settings;
    storage.setState({ settings: { ...current, voice: { ...current.voice,
        privacy: { ...current.voice.privacy, shareDeviceInventory: true } } } });
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('machines.list', { serverId }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { items: [{ machineId: 'cached-machine' }] } });
    home.answer(serverId, 'GET /v1/machines', { status: 503, body: {} });
    expect(await executor.execute('machines.list', { serverId, refresh: true }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: false });
    expect(storage.getState().machines['cached-machine']).toBeDefined();
});

// The test loader owns only its Node/Vite bridge, and restores it after this file's final test.
afterAll(disposeExecutorLoader);
