import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';
import { ModalCardFrame } from './WebAlertModal';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseModalSpy = vi.fn();

vi.mock('./BaseModal', () => ({
    BaseModal: (props: any) => {
        baseModalSpy(props);
        return React.createElement('BaseModal', props, props.children);
    },
}));

installModalComponentCommonModuleMocks();

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

function getTextContent(node: any): string {
    const child = node?.findByType?.('Text' as any);
    const value = child?.props?.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

function getNodeByTestID(screen: { findByTestId: (testID: string) => any }, testID: string) {
    return screen.findByTestId(testID);
}

describe('WebPromptModal', () => {
    it('wraps the dialog content in the shared card frame and keeps backdrop dismissal disabled', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebPromptModal
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
                />);

        const [baseModalProps] = baseModalSpy.mock.calls.at(-1)!;
        expect(baseModalProps.closeOnBackdrop).toBe(false);
        expect(baseModalProps.showBackdrop).toBe(true);

        const modalCardFrame = React.Children.toArray(baseModalProps.children).find((child: any) => child.type === ModalCardFrame);
        expect(modalCardFrame).toBeDefined();
    });

    it('renders cancel/confirm actions as accessible Pressables on web', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebPromptModal
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
                />);

        for (const testID of ['web-prompt-cancel', 'web-prompt-confirm']) {
            const pressable = getNodeByTestID(screen, testID);
            const text = getTextContent(pressable);

            expect(pressable.props.accessibilityRole).toBe('button');
            expect(pressable.props.accessibilityLabel).toBe(text);
        }
    });

    it('autofocuses the input and preserves text submission wiring', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebPromptModal
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
                />);

        const input = getNodeByTestID(screen, 'web-prompt-input');
        expect(input.props.autoFocus).toBe(true);
        expect(input.props.onSubmitEditing).toBeTypeOf('function');
    });

    it('keeps the typed value when pointer confirm races with modal close', async () => {
        const { WebPromptModal } = await import('./WebPromptModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebPromptModal
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
                />);

        const input = getNodeByTestID(screen, 'web-prompt-input');
        act(() => {
            input.props.onChangeText('/srv/workspace');
        });

        const confirmButton = getNodeByTestID(screen, 'web-prompt-confirm');
        expect(baseModalSpy).toHaveBeenCalled();
        const [baseModalProps] = baseModalSpy.mock.calls.at(-1)!;

        act(() => {
            confirmButton.props.onPressIn?.();
            baseModalProps.onClose();
            confirmButton.props.onPress();
        });

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm).toHaveBeenCalledWith('/srv/workspace');
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
