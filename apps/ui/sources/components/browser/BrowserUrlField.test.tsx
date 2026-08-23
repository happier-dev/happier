import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

import { BrowserUrlField } from './BrowserUrlField';

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

describe('BrowserUrlField — toolbar address density', () => {
    it('shows the pretty display URL while blurred', async () => {
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://www.example.com/docs"
                onSubmitUrl={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        const field = screen.findByTestId(TEST_ID);
        expect(field?.props.value).toBe('example.com/docs');
    });

    it('swaps to the full raw URL and selects all text on focus', async () => {
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://www.example.com/docs"
                onSubmitUrl={vi.fn()}
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
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                onSubmitUrl={onNavigate}
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
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                onSubmitUrl={onNavigate}
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
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                disabled
                onSubmitUrl={onNavigate}
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
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://www.example.com/docs"
                onSubmitUrl={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await screen.pressByTestIdAsync(`${TEST_ID}-copy`);

        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith('https://www.example.com/docs');
        expect(screen.findByTestId(`${TEST_ID}-copy-feedback`)).toBeTruthy();
    });

    it('surfaces an inline invalid message and does not navigate when the input is not an address', async () => {
        const onNavigate = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                onSubmitUrl={onNavigate}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('http://');
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${TEST_ID}-invalid`)).toBeTruthy();
    });

    it('says search is not configured instead of failing silently on a query', async () => {
        const onNavigate = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                onSubmitUrl={onNavigate}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('how do i ship this');
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onNavigate).not.toHaveBeenCalled();
        const message = screen.findByTestId(`${TEST_ID}-invalid`);
        expect(message).toBeTruthy();
        expect(JSON.stringify(message?.props.children ?? '')).toContain('searchUnconfigured');
    });

    it('navigates through a configured search template and clears the message', async () => {
        const onNavigate = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                searchUrlTemplate="https://search.test/?q={query}"
                onSubmitUrl={onNavigate}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('ship it');
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onNavigate).toHaveBeenCalledWith('https://search.test/?q=ship%20it');
        expect(screen.findByTestId(`${TEST_ID}-invalid`)).toBeFalsy();
    });

    it('clears a stale invalid message as soon as the user edits again', async () => {
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                onSubmitUrl={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('not an address');
            await Promise.resolve();
        });
        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });
        expect(screen.findByTestId(`${TEST_ID}-invalid`)).toBeTruthy();

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('example.org');
            await Promise.resolve();
        });

        expect(screen.findByTestId(`${TEST_ID}-invalid`)).toBeFalsy();
    });
});

describe('BrowserUrlField — panel launchpad density', () => {
    const PANEL_ID = 'url-entry';

    it('is non-editable when the caller supplies no navigation seam', async () => {
        const screen = await renderScreen(
            <BrowserUrlField
                testID={PANEL_ID}
                density="panel"
                trailingAction="go"
                clearOnSubmit
                disabled
                value=""
                onSubmitUrl={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId(PANEL_ID)?.props.editable).toBe(false);
    });

    it('infers https:// for a bare host so a one-word address still opens', async () => {
        const onSubmitUrl = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={PANEL_ID}
                density="panel"
                trailingAction="go"
                clearOnSubmit
                value=""
                onSubmitUrl={onSubmitUrl}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        screen.changeTextByTestId(PANEL_ID, 'example.test');
        await act(async () => {
            screen.findByTestId(PANEL_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onSubmitUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/');
    });

    it('submits through the trailing go affordance and clears the draft', async () => {
        const onSubmitUrl = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={PANEL_ID}
                density="panel"
                trailingAction="go"
                clearOnSubmit
                value=""
                onSubmitUrl={onSubmitUrl}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        screen.changeTextByTestId(PANEL_ID, 'https://example.test/app');
        await screen.pressByTestIdAsync(`${PANEL_ID}-open`);

        expect(onSubmitUrl).toHaveBeenCalledExactlyOnceWith('https://example.test/app');
        expect(screen.findByTestId(PANEL_ID)?.props.value).toBe('');
    });

    it('surfaces the invalid affordance and does not delegate an unparseable address', async () => {
        const onSubmitUrl = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={PANEL_ID}
                density="panel"
                trailingAction="go"
                clearOnSubmit
                value=""
                onSubmitUrl={onSubmitUrl}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        screen.changeTextByTestId(PANEL_ID, 'not a url at all');
        await screen.pressByTestIdAsync(`${PANEL_ID}-open`);

        expect(onSubmitUrl).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${PANEL_ID}-invalid`)).toBeTruthy();
    });

    it('ignores an empty submit without accusing the user of anything', async () => {
        const onSubmitUrl = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={PANEL_ID}
                density="panel"
                trailingAction="go"
                clearOnSubmit
                value=""
                onSubmitUrl={onSubmitUrl}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await act(async () => {
            screen.findByTestId(PANEL_ID)?.props.onSubmitEditing?.({});
            await Promise.resolve();
        });

        expect(onSubmitUrl).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${PANEL_ID}-invalid`)).toBeFalsy();
    });
});
