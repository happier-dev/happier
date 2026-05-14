import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));
vi.mock('@/modal/components/card/ModalCardFrame', () => ({
    ModalCardFrame: ({ children, footer }: { children?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement('ModalCardFrame', null, children, footer),
}));

describe('KeyboardShortcutCapturePromptModal', () => {
    it('captures pressed shortcuts into the input field without submitting the prompt', async () => {
        const { KeyboardShortcutCapturePromptModal } = await import('./KeyboardShortcutCapturePromptModal');
        const onClose = vi.fn();
        const onResolve = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        const screen = await renderScreen(
            <KeyboardShortcutCapturePromptModal
                title="Set shortcut"
                message="Press a shortcut"
                placeholder="Alt+K"
                defaultValue="Alt+K"
                platform="macos"
                onClose={onClose}
                onResolve={onResolve}
            />,
        );

        const input = screen.findByTestId('keyboard-shortcut-capture-input');
        act(() => {
            input?.props.onKeyDown({
                key: 'h',
                code: 'KeyH',
                metaKey: true,
                preventDefault,
                stopPropagation,
            });
        });

        expect(preventDefault).toHaveBeenCalled();
        expect(stopPropagation).toHaveBeenCalled();
        expect(screen.findByTestId('keyboard-shortcut-capture-input')?.props.value).toBe('Mod+H');
        expect(onResolve).not.toHaveBeenCalled();
    });

    it('confirms the captured shortcut when the user presses OK', async () => {
        const { KeyboardShortcutCapturePromptModal } = await import('./KeyboardShortcutCapturePromptModal');
        const onClose = vi.fn();
        const onResolve = vi.fn();

        const screen = await renderScreen(
            <KeyboardShortcutCapturePromptModal
                title="Set shortcut"
                message="Press a shortcut"
                placeholder="Alt+K"
                defaultValue="Alt+K"
                platform="macos"
                onClose={onClose}
                onResolve={onResolve}
            />,
        );

        act(() => {
            screen.findByTestId('keyboard-shortcut-capture-input')?.props.onKeyDown({
                key: 'Tab',
                code: 'Tab',
                shiftKey: true,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });
        screen.pressByTestId('keyboard-shortcut-capture-confirm');

        expect(onResolve).toHaveBeenCalledWith('Shift+Tab');
        expect(onClose).toHaveBeenCalled();
    });
});
