import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


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

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children,
    SafeAreaView: 'SafeAreaView',
    useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
}));

vi.mock('@/changelog', () => ({
    getChangelogEntries: () => [],
    getLatestVersion: () => 0,
    setLastViewedVersion: vi.fn(),
}));

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => 'deny',
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

        expect(ChangelogScreen()).toBeNull();
    });
});
