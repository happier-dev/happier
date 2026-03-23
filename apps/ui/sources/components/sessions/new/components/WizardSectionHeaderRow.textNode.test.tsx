import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: () => <>{'.'}</>,
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

describe('WizardSectionHeaderRow', () => {
    it('does not emit raw text nodes under non-Text parents when icons render as text on web', async () => {
        const { WizardSectionHeaderRow } = await import('./WizardSectionHeaderRow');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<WizardSectionHeaderRow
                    rowStyle={{}}
                    iconName="folder-outline"
                    title="Section"
                    action={{
                        accessibilityLabel: 'Refresh',
                        iconName: 'refresh-outline',
                        onPress: () => {},
                    }}
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
            const nextParent = typeof node.type === 'string' ? node.type : null;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
    });
});
