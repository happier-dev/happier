import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { BrowserAddressField } from './BrowserAddressField';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const clipboardSpies = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async (_value: string) => true),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: clipboardSpies.setClipboardStringSafe,
}));

const TEST_ID = 'browser-address';

describe('BrowserAddressField', () => {
    it('shows the pretty display URL while blurred', async () => {
        const screen = await renderScreen(
            <BrowserAddressField
                testID={TEST_ID}
                value="https://www.example.com/docs"
                onNavigate={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        const field = screen.findByTestId(TEST_ID);
        expect(field?.props.value).toBe('example.com/docs');
    });

    it('swaps to the full raw URL and selects all text on focus', async () => {
        const screen = await renderScreen(
            <BrowserAddressField
                testID={TEST_ID}
                value="https://www.example.com/docs"
                onNavigate={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });

        const field = screen.findByTestId(TEST_ID);
        expect(field?.props.value).toBe('https://www.example.com/docs');
        expect(field?.props.selection).toEqual({ start: 0, end: 'https://www.example.com/docs'.length });
    });

    it('reverts the draft and blurs on Escape without navigating', async () => {
        const onNavigate = vi.fn();
        const screen = await renderScreen(
            <BrowserAddressField
                testID={TEST_ID}
                value="https://example.com/"
                onNavigate={onNavigate}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('https://edited.example.org/');
            await Promise.resolve();
        });
        expect(screen.findByTestId(TEST_ID)?.props.value).toBe('https://edited.example.org/');

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onKeyPress?.({ nativeEvent: { key: 'Escape' } });
            await Promise.resolve();
        });

        // Esc reverts to the pretty (blurred) display of the original value and does not navigate.
        expect(screen.findByTestId(TEST_ID)?.props.value).toBe('example.com');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('submits the edited raw value unchanged on enter', async () => {
        const onNavigate = vi.fn();
        const screen = await renderScreen(
            <BrowserAddressField
                testID={TEST_ID}
                value="https://example.com/"
                onNavigate={onNavigate}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('example.org/next');
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onNavigate).toHaveBeenCalledWith('https://example.org/next');
    });

    it('does not submit when disabled', async () => {
        const onNavigate = vi.fn();
        const screen = await renderScreen(
            <BrowserAddressField
                testID={TEST_ID}
                value="https://example.com/"
                disabled
                onNavigate={onNavigate}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.findByTestId(TEST_ID)?.props.editable).toBe(false);
    });

    it('copies the authoritative full URL from the chrome affordance', async () => {
        clipboardSpies.setClipboardStringSafe.mockClear();
        const screen = await renderScreen(
            <BrowserAddressField
                testID={TEST_ID}
                value="https://www.example.com/docs"
                onNavigate={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await screen.pressByTestIdAsync(`${TEST_ID}-copy`);

        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith('https://www.example.com/docs');
        expect(screen.findByTestId(`${TEST_ID}-copy-feedback`)).toBeTruthy();
    });
});
