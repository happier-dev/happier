import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Platform: {
                        OS: 'web',
                        select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
                    },
                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

describe('ScrollEdgeIndicators', () => {
    it('does not emit raw period text nodes under non-Text parents', async () => {
        const { ScrollEdgeIndicators } = await import('./ScrollEdgeIndicators');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ScrollEdgeIndicators
                    edges={{ bottom: true }}
                    color="#999"
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
