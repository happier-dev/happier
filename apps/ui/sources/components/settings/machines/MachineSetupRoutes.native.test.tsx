import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const expoRouterMock = createExpoRouterMock({ router: { push: vi.fn() } });
const nativeSsh = vi.hoisted(() => ({ available: true }));

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
// Whether this build links the native SSH transport is a native-module boundary.
vi.mock('@happier-dev/ssh-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/ssh-native')>(),
    getNativeSshAvailability: () => (nativeSsh.available
        ? { available: true, platform: 'ios', engine: 'russh', moduleVersion: '1', supportsLoopbackTunnel: true, supportsPersistentHostKeyStorage: true }
        : { available: false, reason: 'native-module-missing' }),
}));

const [{ default: AddMachineRoute }, { InjectedAuthProvider }, { discardMachineAdd }] = await Promise.all([
    import('@/app/(app)/settings/machines/add'),
    import('@/auth/context/AuthContext'),
    import('@/components/machines/add/useMachineAddFlow'),
]);

async function renderAddMachine() {
    return renderScreen(<InjectedAuthProvider credentials={null}><AddMachineRoute /></InjectedAuthProvider>);
}

afterEach(standardCleanup);

beforeEach(async () => {
    await act(async () => discardMachineAdd());
});

describe('Machines add route in the native app', () => {
    it('offers SSH machine setup where the native SSH transport is available', async () => {
        nativeSsh.available = true;
        const screen = await renderAddMachine();

        expect(screen.findByTestId('settings.machines.draft.form.path:ssh')).toBeTruthy();
        expect(screen.findByTestId('settings.machines.draft.form.path:thisComputer')).toBeNull();
        expect(screen.findByTestId('settings.machines.draft.form.path:anotherComputer')?.props.accessibilityState?.checked).toBe(true);
        const { readMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
        expect(readMachineAddFlowDraft().path).toBe('anotherComputer');
        await screen.pressByTestIdAsync('settings.machines.draft.form.path:ssh');
        expect(readMachineAddFlowDraft().path).toBe('ssh');
    });

    it('keeps another-computer setup reachable without offering SSH when the native transport is unavailable', async () => {
        nativeSsh.available = false;
        const screen = await renderAddMachine();

        expect(screen.findByTestId('settings.machines.draft.form.path:ssh')).toBeNull();
        expect(screen.findByTestId('settings.machines.draft.form.path:anotherComputer')).toBeTruthy();
    });
});
