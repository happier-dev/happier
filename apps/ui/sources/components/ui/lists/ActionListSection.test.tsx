import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: false,
        colors: {
            surface: '#fff',
            divider: '#ddd',
            shadow: { color: '#000', opacity: 0.2 },
            text: '#111111',
            textSecondary: '#666666',
        },
    };

    return {
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme, {}) : input) },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('react-native', () => {
    const React = require('react');
    return {
        Platform: { OS: 'web', select: (m: any) => m?.web ?? m?.default ?? m?.ios },
        AppState: { addEventListener: () => ({ remove: () => {} }) },
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
    };
});

let selectableRowProps: any | null = null;
vi.mock('./SelectableRow', () => ({
    SelectableRow: (props: any) => {
        selectableRowProps = props;
        return React.createElement('SelectableRow', props);
    },
}));

describe('ActionListSection', () => {
    it('wraps string icons so they do not render as raw text nodes under <View>', async () => {
        const { ActionListSection } = await import('./ActionListSection');

        selectableRowProps = null;

        act(() => {
            renderer.create(
                <ActionListSection
                    title="Actions"
                    actions={[
                        {
                            id: 'dot',
                            label: 'Dot action',
                            icon: '.',
                        },
                    ]}
                />,
            );
        });

        expect(selectableRowProps).toBeTruthy();
        expect(selectableRowProps.left).toBeTruthy();

        // The left icon container is a <View> and must not contain a raw string child on web.
        expect((selectableRowProps.left.type as any)?.name ?? selectableRowProps.left.type).toBe('View');
        expect(typeof selectableRowProps.left.props.children).not.toBe('string');
        expect(React.isValidElement(selectableRowProps.left.props.children)).toBe(true);
        expect(selectableRowProps.left.props.children.props.children).toBe('.');
    });

    it('normalizes icon fragments so they do not render raw text nodes under <View>', async () => {
        const { ActionListSection } = await import('./ActionListSection');

        selectableRowProps = null;

        act(() => {
            renderer.create(
                <ActionListSection
                    actions={[
                        {
                            id: 'fragment',
                            label: 'Fragment icon',
                            icon: <>{'.'}</>,
                        },
                    ]}
                />,
            );
        });

        expect(selectableRowProps).toBeTruthy();
        expect(selectableRowProps.left).toBeTruthy();
        expect((selectableRowProps.left.type as any)?.name ?? selectableRowProps.left.type).toBe('View');

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
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

        walk(renderer.create(selectableRowProps.left).toJSON(), null);
        expect(badNodes).toEqual([]);
    });
});
