import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ActionInputFields } from './ActionInputFields';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function getNodeText(node: any): string {
    const children = Array.isArray(node?.children) ? node.children : node?.props?.children;
    if (Array.isArray(children)) return children.map((child) => (typeof child === 'string' ? child : getNodeText(child))).join('');
    return typeof children === 'string' ? children : '';
}

function findPressableByText(root: renderer.ReactTestInstance, text: string) {
    return root.findAllByType('Pressable').find((node: any) => {
        const textChildren = node.findAllByType('Text');
        return textChildren.some((child: any) => getNodeText(child) === text);
    });
}

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                surfaceHigh: '#222',
                surfaceHighest: '#444',
            },
        },
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('ActionInputFields', () => {
    it('does not clear the last selected value for required multiselect fields', async () => {
        const onPatch = vi.fn();
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <ActionInputFields
                    fields={[
                        {
                            path: 'engineIds',
                            title: 'Review engines',
                            widget: 'multiselect',
                            required: true,
                        } as any,
                    ]}
                    input={{ engineIds: ['claude'] }}
                    editable
                    resolveFieldOptions={() => [
                        { value: 'claude', label: 'Claude' },
                        { value: 'codex', label: 'Codex' },
                    ]}
                    onPatch={onPatch}
                />,
            );
        });

        const claudeChip = findPressableByText(tree!.root, 'Claude');
        expect(claudeChip).toBeDefined();

        await act(async () => {
            claudeChip!.props.onPress?.();
        });

        expect(onPatch).not.toHaveBeenCalled();
    });
});
