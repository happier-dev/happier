import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./BaseModal', () => ({
    BaseModal: ({ children }: any) => React.createElement('BaseModal', null, children),
}));

vi.mock('react-native', () => {
    const React = require('react');
    return {
        View: (props: any) => React.createElement('View', props, props.children),
        Text: (props: any) => React.createElement('Text', props, props.children),
        TextInput: (props: any) => React.createElement('TextInput', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Platform: { OS: 'web' },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({ theme: { colors: { surface: '#fff', shadow: { color: '#000' }, divider: '#ccc', text: '#111', textLink: '#00f', input: { background: '#fff', placeholder: '#999' } } } }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

function getTextContent(node: any): string {
    const child = node?.findByType?.('Text' as any);
    const value = child?.props?.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

describe('WebPromptModal', () => {
    it('renders cancel/confirm actions as accessible Pressables on web', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        const onClose = vi.fn();
        const onConfirm = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <WebPromptModal
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
