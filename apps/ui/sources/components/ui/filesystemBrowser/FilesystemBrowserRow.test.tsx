import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            View: 'View',
            Platform: {
                OS: 'web',
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => null,
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => null,
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

function findHostNodeByTestID(
    screen: { findAllByTestId: (testID: string) => ReactTestInstance[] },
    testID: string,
) {
    return screen.findAllByTestId(testID).find((node) => typeof node.type === 'string');
}

describe('FilesystemBrowserRow', () => {
    const errorNode = {
        path: 'src',
        name: 'src',
        type: 'error',
        depth: 2,
        isExpanded: false,
        isLoadingChildren: false,
        errorMessage: 'load failed',
    } as const;

    it('preserves interactive host semantics for error rows', async () => {
        const onRetryError = vi.fn();
        const { FilesystemBrowserRow } = await import('./FilesystemBrowserRow');

        const screen = await renderScreen(
            <FilesystemBrowserRow
                node={errorNode}
                index={0}
                totalCount={1}
                title="Ignored"
                icon={<Icon />}
                testID="filesystem-error-row"
                webRole="treeitem"
                onRetryError={onRetryError}
            />,
        );

        const row = findHostNodeByTestID(screen, 'filesystem-error-row');
        if (!row) {
            throw new Error('Expected error row host node to render');
        }

        expect(row.type).toBe('Pressable');
        expect(row.props.testID).toBe('filesystem-error-row');
        expect(row.props['data-testid']).toBe('filesystem-error-row');
        expect(row.props.role).toBe('treeitem');

        row.props.onPress();

        expect(onRetryError).toHaveBeenCalledWith(errorNode);
    }, 120_000);

    it('merges error-row padding with custom row style', async () => {
        const { FilesystemBrowserRow } = await import('./FilesystemBrowserRow');

        const screen = await renderScreen(
            <FilesystemBrowserRow
                node={errorNode}
                index={0}
                totalCount={1}
                title="Ignored"
                icon={<Icon />}
                basePaddingLeft={20}
                depthIndent={10}
                paddingRight={18}
                style={{ borderTopWidth: 3 }}
            />,
        );

        const rowContainer = screen.tree.root.findAllByType('View' as never).find((node) => {
            const style = flattenTestStyle(node.props.style);
            return style.paddingLeft === 40;
        });

        if (!rowContainer) {
            throw new Error('Expected error row container to render');
        }

        expect(flattenTestStyle(rowContainer.props.style)).toMatchObject({
            paddingLeft: 40,
            paddingRight: 18,
            borderTopWidth: 3,
        });
    }, 120_000);
});

function Icon() {
    return null;
}
