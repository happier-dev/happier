import * as React from 'react';
import { act } from 'react';
import { TextInput } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { LinkBubbleEditInput } from '../LinkBubbleEditInput';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: { children?: React.ReactNode }) => React.createElement('Text', props, props.children),
    TextInput: (props: React.ComponentProps<typeof TextInput>) => React.createElement(TextInput, props),
}));

describe('LinkBubbleEditInput', () => {
    it('renders a text input pre-filled with the initial href', async () => {
        const screen = await renderScreen(
            <LinkBubbleEditInput
                initialHref="https://example.com"
                onSave={vi.fn()}
                onCancel={vi.fn()}
                testID="edit-input"
            />,
        );
        const input = screen.findByTestId('edit-input:input');
        expect(input).toBeTruthy();
        expect(input!.props.value).toBe('https://example.com');
    });

    it('uses markdown link bubble copy for the input and buttons', async () => {
        const screen = await renderScreen(
            <LinkBubbleEditInput
                initialHref="https://example.com"
                onSave={vi.fn()}
                onCancel={vi.fn()}
                testID="edit-input"
            />,
        );

        expect(screen.findByTestId('edit-input:input')?.props.placeholder)
            .toBe('markdown.linkBubble.inputPlaceholder');
        expect(screen.findByTestId('edit-input:cancel')?.props.accessibilityLabel)
            .toBe('markdown.linkBubble.cancel');
        expect(screen.findByTestId('edit-input:save')?.props.accessibilityLabel)
            .toBe('markdown.linkBubble.save');
    });

    it('calls onSave with the current value when save is pressed', async () => {
        const onSave = vi.fn();
        const screen = await renderScreen(
            <LinkBubbleEditInput
                initialHref="https://old.com"
                onSave={onSave}
                onCancel={vi.fn()}
                testID="edit-input"
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('edit-input:input', 'https://new.com');
        });
        await screen.pressByTestIdAsync('edit-input:save');
        expect(onSave).toHaveBeenCalledWith('https://new.com');
    });

    it('calls onCancel when cancel is pressed', async () => {
        const onCancel = vi.fn();
        const screen = await renderScreen(
            <LinkBubbleEditInput
                initialHref="https://example.com"
                onSave={vi.fn()}
                onCancel={onCancel}
                testID="edit-input"
            />,
        );
        screen.pressByTestId('edit-input:cancel');
        expect(onCancel).toHaveBeenCalled();
    });

    it('trims whitespace before saving', async () => {
        const onSave = vi.fn();
        const screen = await renderScreen(
            <LinkBubbleEditInput
                initialHref="https://example.com"
                onSave={onSave}
                onCancel={vi.fn()}
                testID="edit-input"
            />,
        );
        await act(async () => {
            screen.changeTextByTestId('edit-input:input', '  https://trimmed.com  ');
        });
        await screen.pressByTestIdAsync('edit-input:save');
        expect(onSave).toHaveBeenCalledWith('https://trimmed.com');
    });
});
