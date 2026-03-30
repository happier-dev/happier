import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installFormsCommonModuleMocks } from './formsTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options.web ?? options.default ?? null,
            },
            Dimensions: {
                get: () => ({ width: 1440, height: 1100 }),
            },
        }
        );
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#ffffff',
                    divider: '#e5e7eb',
                    input: {
                        background: '#f9fafb',
                        text: '#111827',
                        placeholder: '#9ca3af',
                    },
                    textSecondary: '#6b7280',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('TextInput', props, props.children),
}));

describe('SearchHeader', () => {
    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { SearchHeader } = await import('./SearchHeader');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<SearchHeader
                    value="codex"
                    onChangeText={() => {}}
                    placeholder="Search machines"
                />)).tree;

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) {
                    badNodes.push({ parent: parentType, value: node });
                }
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) walk(child, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
    });
});
