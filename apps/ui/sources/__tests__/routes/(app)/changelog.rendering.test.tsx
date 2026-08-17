import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

describe('ChangelogScreen', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
    });

    afterEach(() => {
        if (previousDeny === undefined) {
            delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        } else {
            process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('renders one MarkdownView per changelog entry', async () => {
        const { getChangelogEntries } = await import('@/changelog');
        const entries = getChangelogEntries();
        expect(entries.length).toBeGreaterThan(0);

        const mod = await import('@/app/(app)/changelog');
        const ChangelogScreen = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ChangelogScreen))).tree;

        expect(tree.root.findAllByType('MarkdownView' as any)).toHaveLength(entries.length);
    });
});
