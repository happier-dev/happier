import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mmkvAccess = vi.hoisted(() => ({
    getString: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.getString should not be called when changelog UI is disabled');
    }),
    getNumber: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.getNumber should not be called when changelog UI is disabled');
    }),
    set: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.set should not be called when changelog UI is disabled');
    }),
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

describe('useChangelog (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    let tree: renderer.ReactTestRenderer | null = null;

    beforeEach(() => {
        vi.resetModules();
        mmkvAccess.getString.mockClear();
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

        let latest: { hasUnread: boolean; latestReleaseId: string | null } | null = null;
        function Probe() {
            const value = useChangelog();
            latest = { hasUnread: value.hasUnread, latestReleaseId: value.latestReleaseId };
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(Probe))).tree;

        expect(latest).toEqual({ hasUnread: false, latestReleaseId: null });
    });
});
