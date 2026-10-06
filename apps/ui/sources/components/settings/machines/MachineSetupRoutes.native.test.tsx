import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const expoRouterMock = createExpoRouterMock({ router: { push: vi.fn() } });
const nativeSsh = vi.hoisted(() => ({ available: true }));

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
// Whether this build links the native SSH transport is a native-module boundary.
vi.mock('@happier-dev/ssh-native', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/ssh-native')>(),
    getNativeSshAvailability: () => (nativeSsh.available
        ? { available: true }
        : { available: false, reason: 'native_module_missing' }),
}));

async function renderAddMachine() {
    const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
    return renderScreen(React.createElement(AddMachineRoute));
}

describe('Machines add route in the native app', () => {
    it('offers SSH machine setup where the native SSH transport is available', async () => {
        nativeSsh.available = true;
        const screen = await renderAddMachine();

        expect(screen.findByTestId('settings.machines.draft.form.path:ssh')).toBeTruthy();
        expect(screen.findByTestId('settings.machines.draft.form.path:thisComputer')).toBeNull();
    });

    it('keeps another-computer setup reachable without offering SSH when the native transport is unavailable', async () => {
        nativeSsh.available = false;
        const screen = await renderAddMachine();

        expect(screen.findByTestId('settings.machines.draft.form.path:ssh')).toBeNull();
        expect(screen.findByTestId('settings.machines.draft.form.path:anotherComputer')).toBeTruthy();
    });
});
