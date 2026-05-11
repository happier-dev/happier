import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    contentWidthMode: 'compact' as 'compact' | 'medium' | 'full',
}));

installUiListsCommonModuleMocks();

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting: ((key: string) => {
                if (key === 'uiContentWidthMode') return shared.contentWidthMode;
                if (key === 'uiFontScale') return 1;
                if (key === 'uiItemDensity') return 'cozy';
                return undefined;
            }) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
        },
    });
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({
        getState: () => ({
            localSettings: {
                uiContentWidthMode: shared.contentWidthMode,
            },
        }),
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function findItemGroupMaxWidth(screen: Awaited<ReturnType<typeof renderScreen>>): unknown {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.width === '100%' && style.maxWidth !== undefined;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style).maxWidth : undefined;
}

describe('ItemGroup content width', () => {
    it('updates its max width when the local content width setting changes', async () => {
        shared.contentWidthMode = 'compact';
        const { ItemGroup } = await import('./ItemGroup');

        const screen = await renderScreen(
            <ItemGroup title="Group">
                {React.createElement('View')}
            </ItemGroup>,
        );

        expect(findItemGroupMaxWidth(screen)).toBe(850);

        shared.contentWidthMode = 'full';
        await act(async () => {
            screen.tree.update(
                <ItemGroup title="Group">
                    {React.createElement('View')}
                </ItemGroup>,
            );
        });

        expect(findItemGroupMaxWidth(screen)).toBe(Number.POSITIVE_INFINITY);
    });

    it('can opt out of main content width constraints for embedded surfaces', async () => {
        shared.contentWidthMode = 'compact';
        const { ItemGroup } = await import('./ItemGroup');

        const screen = await renderScreen(
            <ItemGroup title="Group" constrainToContentWidth={false}>
                {React.createElement('View')}
            </ItemGroup>,
        );

        expect(findItemGroupMaxWidth(screen)).toBeUndefined();
    });
});
