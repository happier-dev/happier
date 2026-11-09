import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { installSessionShellCommonModuleMocks } from '../sessionShellTestHelpers';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: React.Attributes & Record<string, unknown> & Readonly<{
        trigger?: (input: { toggle: () => void }) => React.ReactNode;
    }>) => React.createElement('DropdownMenu', props, props.trigger?.({ toggle: vi.fn() })),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    storage: async () => ({
        useLocalSettingMutable: () => ['all', vi.fn()] as const,
    }),
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => true }));

afterEach(standardCleanup);

describe('SessionListSearchChrome native layout', () => {
    it('keeps the title row and gives the open field its own full-width row beneath it', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const screen = await renderScreen(
            <SessionListSearchChrome
                filterControl={React.createElement('FilterControl', { testID: 'session-list-filter-control' })}
                searchQuery="responsive"
                onSearchQueryChange={vi.fn()}
            />,
        );

        const titleRow = screen.root.findByProps({ testID: 'session-list-search-primary-controls' });
        expect(titleRow.findByProps({ testID: 'session-list-filter-control' })).toBeTruthy();
        expect(titleRow.findAllByProps({ testID: 'session-list-search-trigger' }).length).toBeGreaterThan(0);
        expect(titleRow.findAllByProps({ testID: 'session-list-view-options-trigger' }).length).toBeGreaterThan(0);
        expect(titleRow.findAllByProps({ testID: 'session-list-search-input' })).toHaveLength(0);

        const [field] = screen.root.findAllByProps({ testID: 'session-list-search-input.field' });
        expect(field?.findAllByProps({ testID: 'session-list-search-input' }).length).toBeGreaterThan(0);
    });

    it('gives every header and field action the touch floor on a touch platform', async () => {
        const { SessionListSearchChrome } = await import('./SessionListSearchChrome');
        const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <SessionListSearchChrome
                    searchQuery="responsive"
                    onSearchQueryChange={vi.fn()}
                />
            </HappierUiPlatformProvider>,
        );

        // Each action keeps its drawn square; a finger reaches the iOS floor through the hit area.
        for (const testID of ['session-list-search-trigger', 'session-list-view-options-trigger', 'session-list-search-close']) {
            const host = screen.findHostByTestId(testID);
            const style = flattenTestStyle(host?.props.style);
            const area = await layoutHitArea(() => screen.findHostByTestId(testID), { width: Number(style.width), height: Number(style.height) });
            expect(area.height, testID).toBe(resolveHappierMinimumInteractiveTargetSize('ios'));
        }
    });
});
