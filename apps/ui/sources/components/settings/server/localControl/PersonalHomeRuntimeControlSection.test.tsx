import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmMock = vi.fn(async () => true);
const alertMock = vi.fn(async () => {});

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ View: 'View', Platform: { OS: 'web', select: (o: Record<string, unknown>) => o?.web ?? o?.default } });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => ({ Modal: { confirm: confirmMock, alert: alertMock } }),
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme: { colors: { accent: { blue: 'blue', orange: 'orange', indigo: 'indigo' } } } });
    },
});

vi.mock('./LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, footer }: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) => React.createElement('ItemGroup', { title, footer }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('PersonalHomeRuntimeControlSection', () => {
    it('composes the canonical runtime owner and keeps status/recovery local', async () => {
        const { PersonalHomeRuntimeControlSection } = await import('./PersonalHomeRuntimeControlSection');
        const restart = vi.fn(async () => {});
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, { operations: { restart } }));

        expect(screen.findByType('LocalRelayRuntimeControlSection' as never)).toBeTruthy();
        await screen.pressByTestIdAsync('settings.personalHomeRuntime.restart');
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('keeps profile removal, runtime uninstall, and data erase as distinct confirmed operations', async () => {
        confirmMock.mockClear();
        const removeProfile = vi.fn(async () => {});
        const uninstallRuntime = vi.fn(async () => {});
        const eraseData = vi.fn(async () => {});
        const { PersonalHomeRuntimeControlSection } = await import('./PersonalHomeRuntimeControlSection');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection, {
            operations: { removeProfile, uninstallRuntime, eraseData },
        }));

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.removeProfile');
        expect(removeProfile).toHaveBeenCalledTimes(1);
        expect(uninstallRuntime).not.toHaveBeenCalled();
        expect(eraseData).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.uninstallRuntime');
        expect(uninstallRuntime).toHaveBeenCalledTimes(1);
        expect(eraseData).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings.personalHomeRuntime.eraseData');
        expect(eraseData).toHaveBeenCalledTimes(1);
        expect(confirmMock).toHaveBeenCalledTimes(3);
        expect(confirmMock.mock.calls.every(([, , options]) => (options as { destructive?: boolean }).destructive === true)).toBe(true);
    });

    it('does not render destructive controls when Lane 07 has not supplied its operation API', async () => {
        const { PersonalHomeRuntimeControlSection } = await import('./PersonalHomeRuntimeControlSection');
        const screen = await renderScreen(React.createElement(PersonalHomeRuntimeControlSection));
        expect(screen.findByTestId('settings.personalHomeRuntime.removeProfile')).toBeNull();
        expect(screen.findByTestId('settings.personalHomeRuntime.uninstallRuntime')).toBeNull();
        expect(screen.findByTestId('settings.personalHomeRuntime.eraseData')).toBeNull();
    });
});
