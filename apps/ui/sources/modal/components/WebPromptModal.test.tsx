import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./BaseModal', () => ({
    BaseModal: (props: any) => React.createElement('BaseModal', props, props.children),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            TextInput: (props: any) => React.createElement('TextInput', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            Platform: {
                OS: 'web',
                select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
            },
            AppState: {
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { surface: '#fff', shadow: { color: '#000' }, divider: '#ccc', text: '#111', textLink: '#00f', input: { background: '#fff', placeholder: '#999' } } },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function getTextContent(node: any): string {
    const child = node?.findByType?.('Text' as any);
    const value = child?.props?.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

function getNodeByTestID(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findByProps({ testID });
}

describe('WebPromptModal', () => {
    it('renders cancel/confirm actions as accessible Pressables on web', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        const onClose = vi.fn();
        const onConfirm = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<WebPromptModal
                    config={{
                        id: 'test-prompt',
                        type: 'prompt',
                        title: 'Create commit',
                        message: 'Enter commit message',
                        cancelText: 'Cancel',
                        confirmText: 'OK',
                        placeholder: 'message',
                        defaultValue: '',
                        inputType: 'default',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />)).tree;

        for (const testID of ['web-prompt-cancel', 'web-prompt-confirm']) {
            const pressable = getNodeByTestID(tree!, testID);
            const text = getTextContent(pressable);

            expect(pressable.props.accessibilityRole).toBe('button');
            expect(pressable.props.accessibilityLabel).toBe(text);
        }
    });

    it('keeps the typed value when pointer confirm races with modal close', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        const onClose = vi.fn();
        const onConfirm = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<WebPromptModal
                    config={{
                        id: 'test-prompt',
                        type: 'prompt',
                        title: 'Attach location',
                        message: 'Enter path',
                        cancelText: 'Cancel',
                        confirmText: 'Attach',
                        defaultValue: '/tmp/workspace',
                        inputType: 'default',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />)).tree;

        const input = getNodeByTestID(tree!, 'web-prompt-input');
        act(() => {
            input.props.onChangeText('/srv/workspace');
        });

        const confirmButton = getNodeByTestID(tree!, 'web-prompt-confirm');
        const baseModal = tree!.root.findByType('BaseModal' as any);

        act(() => {
            confirmButton.props.onPressIn?.();
            baseModal.props.onClose();
            confirmButton.props.onPress();
        });

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm).toHaveBeenCalledWith('/srv/workspace');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
