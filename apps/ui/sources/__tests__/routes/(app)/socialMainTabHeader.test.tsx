import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from '@/components/navigation/shell/navigationShellTestHelpers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
    useIsTablet: () => false,
}));

vi.mock('@/hooks/inbox/useRequireInboxAvailable', () => ({
    useRequireInboxAvailable: () => true,
}));

vi.mock('@/hooks/friends/useRequireFriendsEnabled', () => ({
    useRequireFriendsEnabled: () => true,
}));

vi.mock('@/components/navigation/shell/InboxView', () => ({
    InboxView: 'InboxView',
}));

vi.mock('@/components/navigation/shell/FriendsView', () => ({
    FriendsView: 'FriendsView',
}));

function findBackAffordances(tree: Awaited<ReturnType<typeof renderScreen>>['tree']) {
    return tree.findAllByProps({ accessibilityLabel: 'common.back' });
}

describe('social main tab headers', () => {
    it('does not render a back affordance on the inbox tab root', async () => {
        const Page = (await import('@/app/(app)/inbox/index')).default;

        const { tree } = await renderScreen(React.createElement(Page));

        expect(findBackAffordances(tree)).toHaveLength(0);
    });

    it('does not render a back affordance on the friends tab root', async () => {
        const Page = (await import('@/app/(app)/friends/index')).default;

        const { tree } = await renderScreen(React.createElement(Page));

        expect(findBackAffordances(tree)).toHaveLength(0);
    });
});
