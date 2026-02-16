import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mmkvAccess = vi.hoisted(() => ({
    getNumber: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.getNumber should not be called when changelog UI is disabled');
    }),
    set: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.set should not be called when changelog UI is disabled');
    }),
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getNumber(...args: any[]) {
            return mmkvAccess.getNumber(...args);
        }
        set(...args: any[]) {
            return mmkvAccess.set(...args);
        }
    }

    return { MMKV };
});

describe('useChangelog (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        vi.resetModules();
        mmkvAccess.getNumber.mockClear();
        mmkvAccess.set.mockClear();
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.changelog';
    });

    afterEach(() => {
        if (tree) {
            act(() => {
                tree?.unmount();
            });
            tree = null;
        }
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('reports no unread entries when changelog UI is disabled', async () => {
        const { useChangelog } = await import('./useChangelog');

        let latest: { hasUnread: boolean; latestVersion: number } | null = null;
        function Probe() {
            const value = useChangelog();
            latest = { hasUnread: value.hasUnread, latestVersion: value.latestVersion };
            return React.createElement('View');
        }

        act(() => {
            tree = renderer.create(React.createElement(Probe));
        });

        expect(latest).toEqual({ hasUnread: false, latestVersion: 0 });
    });
});
