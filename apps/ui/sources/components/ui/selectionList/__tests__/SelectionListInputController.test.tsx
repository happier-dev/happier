import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                input: { placeholder: '#123456' },
                text: { secondary: '#ABCDEF' },
            },
        },
    });
});

describe('SelectionListInputController (Phase 2.7)', () => {
    it('renders the placeholder and the controlled input value', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value="~/Doc"
                onChangeText={() => {}}
                placeholder="Search or path"
                ghostSuffix=""
                onCaretAtEndChange={() => {}}
            />,
        );
        const input = screen.findByTestId('ic:input');
        expect(input).not.toBeNull();
        expect(input?.props.value).toBe('~/Doc');
        expect(input?.props.placeholder).toBe('Search or path');
        expect(input?.props.placeholderTextColor).toBe('#123456');
    });

    it('renders the inputPrefix slot when provided', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value=""
                onChangeText={() => {}}
                placeholder=""
                ghostSuffix=""
                inputPrefix={<span data-testid="prefix-marker">[icon]</span>}
                onCaretAtEndChange={() => {}}
            />,
        );
        expect(screen.findByTestId('ic:prefix')).not.toBeNull();
    });

    it('renders the inputSuffix slot when provided', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value=""
                onChangeText={() => {}}
                placeholder=""
                ghostSuffix=""
                inputSuffix={<span data-testid="suffix-marker">[button]</span>}
                onCaretAtEndChange={() => {}}
            />,
        );
        expect(screen.findByTestId('ic:suffix')).not.toBeNull();
    });

    it('renders the ghost when ghostSuffix is non-empty', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value="~/Doc"
                onChangeText={() => {}}
                placeholder=""
                ghostSuffix="uments/"
                onCaretAtEndChange={() => {}}
            />,
        );
        expect(screen.getTextContent()).toContain('uments/');
    });

    it('reports caretAtEnd via onCaretAtEndChange after onSelectionChange', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const onCaretAtEndChange = vi.fn();
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value="hello"
                onChangeText={() => {}}
                placeholder=""
                ghostSuffix=""
                onCaretAtEndChange={onCaretAtEndChange}
            />,
        );
        const input = screen.findByTestId('ic:input');
        // Simulate selection change with caret at end (selection.start = 5 for "hello")
        const onSelectionChange = input?.props.onSelectionChange;
        expect(typeof onSelectionChange).toBe('function');
        onSelectionChange?.({ nativeEvent: { selection: { start: 5, end: 5 } } });
        expect(onCaretAtEndChange).toHaveBeenCalledWith(true);
        onSelectionChange?.({ nativeEvent: { selection: { start: 2, end: 2 } } });
        expect(onCaretAtEndChange).toHaveBeenLastCalledWith(false);
    });

    it('shows the clear button when value is non-empty and clearable is enabled', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const onChangeText = vi.fn();
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value="abc"
                onChangeText={onChangeText}
                placeholder=""
                ghostSuffix=""
                clearable
                onCaretAtEndChange={() => {}}
            />,
        );
        const clear = screen.findByTestId('ic:clear');
        expect(clear).not.toBeNull();
        screen.pressByTestId('ic:clear');
        expect(onChangeText).toHaveBeenCalledWith('');
    });

    it('hides the clear button when value is empty even if clearable is enabled', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value=""
                onChangeText={() => {}}
                placeholder=""
                ghostSuffix=""
                clearable
                onCaretAtEndChange={() => {}}
            />,
        );
        const hostClear = screen.findAllByTestId('ic:clear').filter((n) => typeof n.type === 'string');
        expect(hostClear).toEqual([]);
    });

    it('IME composition events drive isComposing via onIsComposingChange', async () => {
        const { SelectionListInputController } = await import('../SelectionListInputController');
        const onIsComposingChange = vi.fn();
        const screen = await renderScreen(
            <SelectionListInputController
                testID="ic"
                value=""
                onChangeText={() => {}}
                placeholder=""
                ghostSuffix=""
                onCaretAtEndChange={() => {}}
                onIsComposingChange={onIsComposingChange}
            />,
        );
        const input = screen.findByTestId('ic:input');
        input?.props.onCompositionStart?.();
        expect(onIsComposingChange).toHaveBeenLastCalledWith(true);
        input?.props.onCompositionEnd?.();
        expect(onIsComposingChange).toHaveBeenLastCalledWith(false);
    });
});
