import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mmkvAccess = vi.hoisted(() => ({
    getString: vi.fn((..._args: unknown[]) => undefined),
    getNumber: vi.fn((..._args: unknown[]) => undefined),
    set: vi.fn((..._args: unknown[]) => {}),
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(...args: any[]) {
            return mmkvAccess.getString(...args);
        }
        getNumber(...args: any[]) {
            return mmkvAccess.getNumber(...args);
        }
        set(...args: any[]) {
            return mmkvAccess.set(...args);
        }
    }

    return { MMKV };
});

installRouteRootCommonModuleMocks();

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

describe('ChangelogScreen (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        mmkvAccess.getNumber.mockClear();
        mmkvAccess.set.mockClear();
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.changelog';
    });

    afterEach(() => {
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('returns null when disabled by build policy', async () => {
        const mod = await import('@/app/(app)/changelog');
        const ChangelogScreen = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ChangelogScreen))).tree;

        expect(tree.toJSON()).toBeNull();
    });
});
