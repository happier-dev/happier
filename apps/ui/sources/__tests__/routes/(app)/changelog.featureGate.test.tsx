import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests } from './terminal/terminalRouteTestHelpers';


const mmkvAccess = vi.hoisted(() => ({
    getString: vi.fn((..._args: unknown[]) => undefined),
    getNumber: vi.fn((..._args: unknown[]) => undefined),
    set: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(...args: unknown[]) {
            return mmkvAccess.getString(...args);
        }
        getNumber(...args: unknown[]) {
            return mmkvAccess.getNumber(...args);
        }
        set(...args: unknown[]) {
            return mmkvAccess.set(...args);
        }
    }

    return { MMKV };
});

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();
const ChangelogScreen = (await import('@/app/(app)/changelog')).default;

describe('ChangelogScreen (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        mmkvAccess.getNumber.mockClear();
        mmkvAccess.set.mockClear();
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.changelog';
    });

    afterEach(async () => {
        await standardCleanup();
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('returns null when disabled by build policy', async () => {
        const screen = await renderScreen(React.createElement(ChangelogScreen));
        expect(screen.tree.toJSON()).toBeNull();
        expect(mmkvAccess.set).not.toHaveBeenCalled();
    });
});
