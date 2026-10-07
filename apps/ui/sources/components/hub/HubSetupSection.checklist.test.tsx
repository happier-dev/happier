import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    machines: [] as ReturnType<typeof createMachineFixture>[],
    machineListSettled: true,
    dismissed: false,
    show: null as null | ((options: unknown) => void),
    window: { width: 1600, height: 900 },
    push: null as null | ((href: unknown) => void),
}));

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
// Device storage for the recovery-key flag, and the server's feature answer (HTTP).
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getRecoveryKeyReminderDismissed: async () => state.dismissed,
            setRecoveryKeyReminderDismissed: async (value: boolean) => { state.dismissed = value; return true; },
            getCachedRecoveryKeyReminderDismissed: () => null,
        },
    };
});
// The plugins machine's cached answer (none in this launch).
vi.mock('@/components/settings/plugins/model/pluginAdministrationSummary', () => ({
    usePluginAdministrationSummary: () => ({ known: false, awaitingDecision: 0, userInstalled: 0 }),
}));
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), isLoading: false }),
}));
vi.mock('@/hooks/auth/useScannedAuthUrlProcessor', () => ({
    useScannedAuthUrlProcessor: () => ({ processAuthUrl: vi.fn() }),
}));

const initialStorageState = storage.getState();
beforeEach(() => {
    storage.setState(initialStorageState, true);
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() } });
});
afterEach(() => {
    standardCleanup();
    state.machines = [];
    state.machineListSettled = true;
    state.dismissed = false;
    state.window = { width: 1600, height: 900 };
    state.push = null;
    state.show = null;
    storage.setState(initialStorageState, true);
    vi.unstubAllGlobals();
    // No `vi.resetModules()` per case: re-importing this section's module graph for every case kept
    // each previous graph alive and ran the worker out of memory (see HubSetupSection.test.tsx).
});

async function renderSection(presentation?: 'tiles' | 'checklist') {
    const [{ HubSetupSection }, { ListPresentationProvider }, { InjectedAuthProvider }] = await Promise.all([
        import('./HubSetupSection'),
        import('@/components/ui/lists/listPresentation'),
        import('@/auth/context/AuthContext'),
    ]);
    const serverId = getActiveServerSnapshot().serverId;
    storage.setState({ machines: Object.fromEntries(state.machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [serverId]: state.machines },
        machineListStatusByServerId: { [serverId]: state.machineListSettled ? 'idle' : 'loading' } });
    // Both hubs are pages: the checklist's progress lives in the page section header.
    // This launch has no restored Home Account layout: its real owner refuses writes; no dismissal
    // is synthesized by the test. The checklist only reads machine truth and the device key flag.
    const screen = await renderScreen(
        <InjectedAuthProvider credentials={{ token: 'e30.eyJzdWIiOiJjaGVja2xpc3QtYWNjb3VudCJ9.signature', secret: 's' }}>
            <ListPresentationProvider value="page"><HubSetupSection presentation={presentation} /></ListPresentationProvider>
        </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });
    return screen;
}

/** The progress label as the mock text owner renders it. */
const progress = (done: number, total: number) => `settingsOverview.setupProgress(done=${done},total=${total})`;

describe('HubSetupSection as a checklist (Settings Overview)', () => {
    it('counts known completion and responsive pending actions, and completes the recovery key only after saving', async () => {
        // One device launch owns the recovery-key reminder. Exercise pending states first and
        // save last, so no case depends on another case's launch-global singleton state.
        state.machineListSettled = false;
        const unknown = await renderSection('checklist');
        expect(unknown.findByTestId('hub-setup.addMachine')).toBeNull();
        expect(unknown.getTextContent()).toContain(progress(0, 2));
        await unknown.unmount();

        state.machineListSettled = true;
        state.machines = [createMachineFixture({ id: 'm1', metadata: null })];
        let onSaved: (() => Promise<void>) | undefined;
        state.show = (options) => {
            const props = Reflect.get(options as object, 'props');
            onSaved = props.onSaved;
        };
        const computer = await renderSection('checklist');

        // Done: a machine exists (its row has left). Shown: the recovery key and "Add your phone".
        expect(computer.findByTestId('hub-setup.addMachine')).toBeNull();
        expect(computer.findByTestId('hub-setup.recoveryKey')).toBeTruthy();
        expect(computer.findByTestId('settings-add-your-phone-shortcut')).toBeTruthy();
        expect(computer.getTextContent()).toContain(progress(1, 3));
        await act(async () => { computer.pressByTestId('hub-setup.recoveryKey.action'); });
        expect(onSaved).toBeTypeOf('function');
        // Closing the native modal without its saved acknowledgement is not completion.
        const { Modal } = await import('@/modal');
        await act(async () => { Modal.hide('modal-id'); });
        expect(computer.findByTestId('hub-setup.recoveryKey')).toBeTruthy();
        expect(computer.getTextContent()).toContain(progress(1, 3));
        await computer.unmount();

        state.window = { width: 360, height: 800 };
        vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' });
        const phone = await renderSection('checklist');

        expect(phone.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
        // One row, two ways to complete it.
        expect(phone.findByTestId('hub-setup.connectComputer')).toBeTruthy();
        expect(phone.findByTestId('settings-connect-terminal-scan')).toBeTruthy();
        expect(phone.findByTestId('settings-connect-terminal-enter-url')).toBeTruthy();
        // Done: a machine. Shown: the recovery key and connecting a computer.
        expect(phone.getTextContent()).toContain(progress(1, 3));
        await act(async () => { phone.pressByTestId('hub-setup.recoveryKey.action'); });
        await act(async () => { await onSaved!(); });
        expect(phone.findByTestId('hub-setup.recoveryKey')).toBeNull();
        expect(phone.getTextContent()).toContain(progress(2, 3));
        await phone.unmount();

        state.window = { width: 1600, height: 900 };
        vi.unstubAllGlobals();
        const screen = await renderSection('checklist');
        expect(screen.findByTestId('hub-setup.recoveryKey')).toBeNull();
        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeTruthy();
        expect(screen.getTextContent()).toContain(progress(2, 3));
    });
});
