import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('/friends redirect', () => {
    it('does not redirect /friends to /inbox', async () => {
        const replace = vi.fn();
        const back = vi.fn();

        vi.doMock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { replace, back },
    });
    return expoRouterMock.module;
});

        vi.doMock('@/hooks/friends/useRequireFriendsEnabled', () => ({
            useRequireFriendsEnabled: () => true,
        }));

        vi.doMock('@/utils/platform/responsive', () => ({
            useIsTablet: () => true,
            useHeaderHeight: () => 44,
        }));

        vi.doMock('@/components/navigation/shell/FriendsView', () => ({
            FriendsView: 'FriendsView',
        }));

        const Page = (await import('@/app/(app)/friends/index')).default;

        await renderScreen(React.createElement(Page));

        expect(replace).not.toHaveBeenCalledWith('/inbox');
    });
});
