import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('WizardSectionHeaderRow', () => {
    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { WizardSectionHeaderRow } = await import('./WizardSectionHeaderRow');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <WizardSectionHeaderRow
                    rowStyle={{}}
                    iconName="folder-outline"
                    title="Section"
                    action={{
                        accessibilityLabel: 'Refresh',
                        iconName: 'refresh-outline',
                        onPress: () => {},
                    }}
                />,
            );
        });

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

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
    });
});
