import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    contentWidthMode: 'compact' as 'compact' | 'medium' | 'full',
}));

installFormsCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

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
    TextInput: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('TextInput', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function findSearchHeaderConstrainedStyle(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.width === '100%' && style.alignSelf === 'center' && style.maxWidth !== undefined;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

function findSearchHeaderContainerStyle(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.borderBottomWidth === 1 && style.paddingBottom !== undefined;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

describe('SearchHeader content width', () => {
    it('updates the search field max width when the local content width setting changes', async () => {
        shared.contentWidthMode = 'compact';
        const { SearchHeader } = await import('./SearchHeader');

        const screen = await renderScreen(
            <SearchHeader value="" onChangeText={() => {}} placeholder="Search actions" />,
        );

        expect(findSearchHeaderConstrainedStyle(screen).maxWidth).toBe(850);
        expect(findSearchHeaderConstrainedStyle(screen).paddingHorizontal).toBe(16);
        expect(findSearchHeaderContainerStyle(screen).paddingTop).toBe(0);
        expect(findSearchHeaderContainerStyle(screen).paddingBottom).toBe(12);

        shared.contentWidthMode = 'full';
        await act(async () => {
            screen.tree.update(
                <SearchHeader value="" onChangeText={() => {}} placeholder="Search actions" />,
            );
        });

        expect(findSearchHeaderConstrainedStyle(screen).maxWidth).toBe(Number.POSITIVE_INFINITY);
        expect(findSearchHeaderConstrainedStyle(screen).paddingHorizontal).toBe(16);
    });
});
