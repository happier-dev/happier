import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('Pressable', props, props.children),
                                Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                    React.createElement('Text', props, props.children),
                                ActivityIndicator: (props: Record<string, unknown>) =>
                                    React.createElement('ActivityIndicator', props, null),
                            }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('ResumeChip', () => {
    it('does not emit raw text nodes under Pressable when icons render as text on web', async () => {
        const { ResumeChip } = await import('./ResumeChip');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ResumeChip
                    onPress={() => {}}
                    showLabel={false}
                    resumeSessionId={null}
                    iconColor="#000"
                    labelTitle="Resume"
                    labelOptional="Optional"
                    pressableStyle={() => ({})}
                    textStyle={{}}
                />)).tree;

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

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
        expect(tree.root.findByProps({ testID: 'agent-input-resume-chip' })).toBeTruthy();
    });
});
