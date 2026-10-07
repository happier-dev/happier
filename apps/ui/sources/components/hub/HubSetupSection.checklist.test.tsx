import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { HubSetupSection } from './HubSetupSection';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import '@/sync/syncEngine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    machines: [] as Machine[],
    machineListSettled: true,
    show: null as null | ((options: unknown) => void),
    window: { width: 1600, height: 900 },
    push: null as null | ((href: unknown) => void),
}));
installDisconnectedServerSocketBoundary();
let artifact = createHomeHubArtifactHttpBoundary('account-checklist');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
// Resolve the real presentation/Action graph at collection, outside per-behavior deadlines.
const restoreActionLoader = await installRealActionExecutorModuleLoader();

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // The window size decides computer vs phone-sized web.
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ ...state.window, scale: 2, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock();
    router.spies.push.mockImplementation((href: unknown) => { state.push?.(href); });
    return router.module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    // The modal boundary: the test captures what the step asked it to show.
    const show = ((options: unknown) => {
        state.show?.(options);
        return 'modal-id';
    }) as never;
    return createModalModuleMock({ spies: { show } }).module;
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    artifact = createHomeHubArtifactHttpBoundary('account-checklist');
    state.machines = [];
    state.machineListSettled = true;
    state.window = { width: 1600, height: 900 };
    state.push = null;
    vi.unstubAllGlobals();
});
afterAll(() => restoreActionLoader());

function publishMachines() {
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'account-checklist' };
    storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope,
        machines: Object.fromEntries(state.machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: state.machines },
        machineListStatusByServerId: { [scope.serverId]: state.machineListSettled ? 'idle' : 'loading' } });
}

async function renderSection() {
    connection = await restoreServerAccountForTest({ serverUrl: 'https://checklist-layout.test', accountId: 'account-checklist', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features') return Promise.resolve(Response.json(createRootLayoutFeaturesResponse()));
        if (path === '/v1/machines') return Promise.resolve(Response.json(state.machines.map(machine => ({
            ...machine, metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState),
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } satisfies FetchedMachineRow))));
        return artifact.request(url, init);
    } });
    publishMachines();
    // Both hubs are pages: the checklist's progress lives in the page section header.
    const screen = await renderScreen(
        <InjectedAuthProvider credentials={connection.credentials}>
            <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
                phase: 'current', interactionEnabled: true, machineId: null, serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), platform: 'web',
                clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
                <ListPresentationProvider value="page"><HubSetupSection presentation="checklist" /></ListPresentationProvider>
            </AppShellPluginUiProjectionValueProvider>
        </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });
    return screen;
}

/** The progress label as the mock text owner renders it. */
const progress = (done: number, total: number) => `settingsOverview.setupProgress(done=${done},total=${total})`;

describe('HubSetupSection as a checklist (Settings Overview)', () => {
    it('counts every row it shows on this computer, plus the steps already done', async () => {
        state.machines = [createMachineFixture({ id: 'm1', metadata: null })];
        const screen = await renderSection();

        // A plain Account has no recovery key. The existing machine is done; phone setup remains.
        expect(screen.findByTestId('hub-setup.addMachine')).toBeNull();
        expect(screen.findByTestId('hub-setup.recoveryKey')).toBeNull();
        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeTruthy();
        expect(screen.getTextContent()).toContain(progress(1, 2));
    });

    it('on a phone, connecting a computer is one step: Scan, with "Paste link" beside it', async () => {
        state.machines = [createMachineFixture({ id: 'm1', metadata: null })];
        state.window = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' });
        const screen = await renderSection();

        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
        // One row, two ways to complete it.
        expect(screen.findByTestId('hub-setup.connectComputer')).toBeTruthy();
        expect(screen.findByTestId('settings-connect-terminal-scan')).toBeTruthy();
        expect(screen.findByTestId('settings-connect-terminal-enter-url')).toBeTruthy();
        expect(screen.findByTestId('hub-setup.recoveryKey')).toBeNull();
        // Done: a machine. Shown: connecting a computer, with two actions but counted once.
        expect(screen.getTextContent()).toContain(progress(1, 2));
    });

    it('does not count "Add a machine" while the machine list is not known yet', async () => {
        const screen = await renderSection();
        // The restored Account performs a real machine hydration. Exercise a subsequent unknown
        // snapshot after that hydration, rather than racing its successful HTTP answer.
        await act(async () => {
            state.machineListSettled = false;
            publishMachines();
        });

        expect(screen.findByTestId('hub-setup.addMachine')).toBeNull();
        expect(screen.getTextContent()).toContain(progress(0, 1));
    });

    it('a step that is done leaves the list and counts as done', async () => {
        const screen = await renderSection();
        expect(screen.findByTestId('hub-setup.addMachine')).toBeTruthy();
        expect(screen.getTextContent()).toContain(progress(0, 2));

        await act(async () => {
            state.machines = [createMachineFixture({ id: 'm1', metadata: null })];
            publishMachines();
        });

        expect(screen.findByTestId('hub-setup.addMachine')).toBeNull();
        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeTruthy();
        expect(screen.getTextContent()).toContain(progress(1, 2));
    });
});
