import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) =>
            typeof factory === 'function'
                ? factory({
                    colors: {
                        text: '#fff',
                        textSecondary: '#aaa',
                        textDestructive: '#f44',
                        surfacePressed: '#111',
                        surfacePressedOverlay: '#222',
                        surfaceSelected: '#333',
                        surfaceHigh: '#444',
                        surfaceHighest: '#555',
                        divider: '#666',
                        accent: { blue: '#08f' },
                        input: { placeholder: '#888' },
                        groupped: {
                            background: '#111',
                            chevron: '#888',
                            sectionTitle: '#777',
                        },
                    },
                    dark: false,
                    modal: { border: '#000' },
                    shadow: { color: '#000', opacity: 0.2 },
                })
                : factory,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#aaa',
                textDestructive: '#f44',
                surfacePressed: '#111',
                surfacePressedOverlay: '#222',
                surfaceSelected: '#333',
                surfaceHigh: '#444',
                surfaceHighest: '#555',
                divider: '#666',
                accent: { blue: '#08f' },
                input: { placeholder: '#888' },
                groupped: {
                    background: '#111',
                    chevron: '#888',
                    sectionTitle: '#777',
                },
            },
            dark: false,
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('model dropdown item node normalization', () => {
    it('does not leave raw text nodes under item-row view slots when icon components resolve to primitive text', async () => {
        const { getModelDropdownMenuItems } = await import('./modelDropdownItems');
        const { SelectableMenuResults } = await import('@/components/ui/forms/dropdown/SelectableMenuResults');

        const items = getModelDropdownMenuItems({
            modelOptions: [
                {
                    value: 'default',
                    label: 'Use CLI settings',
                    description: 'Use the backend default.',
                },
            ],
            iconColor: '#aaa',
        });

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <SelectableMenuResults
                    categories={[
                        {
                            id: 'models',
                            title: '',
                            items: items.map((item) => ({
                                id: item.id,
                                title: item.title,
                                subtitle: item.subtitle,
                                left: item.icon ?? null,
                                right: item.rightElement ?? null,
                                disabled: item.disabled,
                            })),
                        },
                    ]}
                    selectedIndex={0}
                    onSelectionChange={() => {}}
                    onPressItem={() => {}}
                    rowVariant="slim"
                    emptyLabel="Empty"
                    rowKind="item"
                />,
            );
        });

        const json = (tree! as any).toJSON();
        const seen: { dotCount: number; badDotCount: number; badParents: Array<string | null> } = {
            dotCount: 0,
            badDotCount: 0,
            badParents: [],
        };

        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (node === '.') {
                    seen.dotCount += 1;
                    if (parentType !== 'Text') {
                        seen.badDotCount += 1;
                        seen.badParents.push(parentType);
                    }
                }
                return;
            }

            const nextParent = typeof node.type === 'string' ? node.type : null;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(json, null);

        expect(seen.dotCount).toBeGreaterThan(0);
        expect({ badDotCount: seen.badDotCount, badParents: seen.badParents }).toEqual({
            badDotCount: 0,
            badParents: [],
        });
    });
});
