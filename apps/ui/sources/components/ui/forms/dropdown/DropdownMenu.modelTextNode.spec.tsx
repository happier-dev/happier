import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'web',
        select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
    },
    Dimensions: {
        get: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
    },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), prompt: vi.fn(async () => null) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: '#fff',
                textSecondary: '#999',
                textDestructive: '#f44',
                surfacePressedOverlay: 'rgba(255,255,255,0.08)',
                surfaceSelected: 'rgba(255,255,255,0.12)',
                surfaceRipple: 'rgba(255,255,255,0.12)',
                surfaceHigh: '#222',
                surfaceHighest: '#333',
                divider: '#444',
                input: { placeholder: '#666' },
                groupped: {
                    background: '#111',
                    chevron: '#888',
                    sectionTitle: '#888',
                },
                accent: { blue: '#00f' },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input({
                    dark: false,
                    colors: {
                        text: '#fff',
                        textSecondary: '#999',
                        textDestructive: '#f44',
                        surfacePressedOverlay: 'rgba(255,255,255,0.08)',
                        surfaceSelected: 'rgba(255,255,255,0.12)',
                        surfaceRipple: 'rgba(255,255,255,0.12)',
                        surfaceHigh: '#222',
                        surfaceHighest: '#333',
                        divider: '#444',
                        input: { placeholder: '#666' },
                        groupped: {
                            background: '#111',
                            chevron: '#888',
                            sectionTitle: '#888',
                        },
                        accent: { blue: '#00f' },
                    },
                }, {})
                : input,
    },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: any) => (typeof children === 'function' ? children({ maxHeight: 320, maxWidth: 320 }) : children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('DropdownMenu model-style text node guard', () => {
    it('does not emit raw period text nodes under non-Text parents when a model-id dropdown is open', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const items = [
            {
                id: '__refresh_models__',
                title: 'Refresh models',
                subtitle: 'Fetch the latest model list.',
                icon: renderDropdownItemIcon({ name: 'refresh-outline', color: '#999' }),
            },
            {
                id: 'default',
                title: 'Use CLI settings',
                icon: renderDropdownItemIcon({ name: 'layers-outline', color: '#999' }),
            },
            {
                id: '__custom__',
                title: 'Custom…',
                subtitle: 'Enter a model id',
                icon: renderDropdownItemIcon({ name: 'create-outline', color: '#999' }),
            },
        ];

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <DropdownMenu
                    open={true}
                    onOpenChange={() => {}}
                    items={items}
                    onSelect={() => {}}
                    search={true}
                    searchPlaceholder="Search models"
                    rowKind="item"
                    showCategoryTitles={false}
                    selectedId="gpt-5.3-codex-spark/medium"
                    itemTrigger={{
                        title: 'Voice agent chat model id',
                        subtitleFormatter: () => 'Used when the voice agent chat model source is set to Custom model.',
                        detailFormatter: () => 'gpt-5.3-codex-spark/medium',
                    }}
                />,
            );
        });

        const json = tree.toJSON();
        const badNodes: Array<{ parent: string | null; value: string }> = [];

        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) {
                    badNodes.push({ parent: parentType, value: node });
                }
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : null;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(json, null);

        expect(badNodes).toEqual([]);
    });
});
