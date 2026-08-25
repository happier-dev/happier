import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

/**
 * Pin one `react-native` for the whole module graph — see the identical hoisted
 * declaration in `Item.webTestId.test.tsx` for why the helper's own registration
 * is not enough once this file's imports have already evaluated shared modules.
 */
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * Query the way an assistive technology does: find the control by ROLE, then read
 * the accessible name off that same node.
 */
function findControlsByRole(screen: RenderScreenResult, role: string): ReactTestInstance[] {
    return screen.findAll((node) => (
        node.props?.role === role || node.props?.accessibilityRole === role
    ));
}

function accessibleNameOf(node: ReactTestInstance): string | undefined {
    return node.props?.['aria-label'] ?? node.props?.accessibilityLabel;
}

describe('Item accessory accessible name (web)', () => {
    it('names an unlabelled switch accessory with the row title', async () => {
        const { Item } = await import('./Item');
        const { Switch } = await import('@/components/ui/forms/Switch.web');

        const screen = await renderScreen(
            <Item
                title="Environment badge"
                subtitle="Show which environment this build points at"
                rightElement={<Switch value={false} onValueChange={() => {}} />}
                showChevron={false}
            />,
        );

        const switches = findControlsByRole(screen, 'switch');
        expect(switches).toHaveLength(1);
        expect(accessibleNameOf(switches[0]!)).toBe('Environment badge');
    });

    it('names a switch rendered as a sibling of the row pressable', async () => {
        const { Item } = await import('./Item');
        const { Switch } = await import('@/components/ui/forms/Switch.web');

        const screen = await renderScreen(
            <Item
                title="Settings sidebar"
                onPress={() => {}}
                rightElement={<Switch value onValueChange={() => {}} />}
                rightElementOutsidePressable
                showChevron={false}
            />,
        );

        const switches = findControlsByRole(screen, 'switch');
        expect(switches).toHaveLength(1);
        expect(accessibleNameOf(switches[0]!)).toBe('Settings sidebar');
    });

    it('keeps an explicit switch label instead of the row title', async () => {
        const { Item } = await import('./Item');
        const { Switch } = await import('@/components/ui/forms/Switch.web');

        const screen = await renderScreen(
            <Item
                title="Diagnostics"
                rightElement={(
                    <Switch
                        value={false}
                        onValueChange={() => {}}
                        accessibilityLabel="Record voice diagnostics"
                    />
                )}
                showChevron={false}
            />,
        );

        const switches = findControlsByRole(screen, 'switch');
        expect(switches).toHaveLength(1);
        expect(accessibleNameOf(switches[0]!)).toBe('Record voice diagnostics');
    });

    it('leaves a standalone switch outside any row unnamed rather than inventing copy', async () => {
        const { Switch } = await import('@/components/ui/forms/Switch.web');

        const screen = await renderScreen(<Switch value={false} onValueChange={() => {}} />);

        const switches = findControlsByRole(screen, 'switch');
        expect(switches).toHaveLength(1);
        expect(accessibleNameOf(switches[0]!)).toBeUndefined();
    });
});
