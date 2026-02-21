import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./BaseModal', () => ({
    BaseModal: ({ children }: any) => React.createElement('BaseModal', null, children),
}));

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        AppState: rn.AppState,
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Platform: { ...rn.Platform, OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
    };
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

function getTextContent(node: any): string {
    const child = node?.findByType?.('Text' as any);
    const value = child?.props?.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

describe('WebAlertModal', () => {
    it('renders confirm buttons as accessible Pressables on web', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

        const onClose = vi.fn();
        const onConfirm = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <WebAlertModal
                    config={{
                        id: 'test-confirm',
                        type: 'confirm',
                        title: 'Push local commits',
                        message: 'Remote: origin',
                        cancelText: 'Cancel',
                        confirmText: 'Push',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />
            );
        });

        const pressables = tree!.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(2);

        for (const pressable of pressables) {
            const text = getTextContent(pressable);
            expect(pressable.props.accessibilityRole).toBe('button');
            expect(pressable.props.accessibilityLabel).toBe(text);
        }
    });
});
