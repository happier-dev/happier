import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, installBrowserClipboardBoundary, renderScreen } from '@/dev/testkit';

import { BrowserUrlField } from './BrowserUrlField';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const clipboardSpies = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async (_value: string) => true),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: clipboardSpies.setClipboardStringSafe,
}));

const TEST_ID = 'browser-address';
beforeEach(() => installBrowserClipboardBoundary(async text => { await clipboardSpies.setClipboardStringSafe(text); }));

describe('BrowserUrlField on glass', () => {
    // Owner 2026-11-11 (desktop #13): the Browser panel's Enter URL field was an opaque block on the glass panel.
    it('fills its field with the containing material, so on glass it is the field-on-glass tint', async () => {
        const { HappierMaterialRoleProvider } = await import('@happier-dev/plugin-ui/presentation');
        const glass = 'rgba(235, 230, 225, 0.1)';
        const screen = await renderScreen(
            <HappierMaterialRoleProvider role="content" resolveMaterialColor={() => glass}>
                <BrowserUrlField testID={TEST_ID} value="" onSubmitUrl={vi.fn()} />
            </HappierMaterialRoleProvider>,
        );
        const style = screen.findHostByTestId(`${TEST_ID}-field-row`)?.props.style;
        const flat = Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
        expect(flat.backgroundColor).toBe(glass);
        await screen.unmount();
    });
});

describe('BrowserUrlField — toolbar address density', () => {
    it('keeps Copy out of sight until the address is hovered or focused (lab browser Q)', async () => {
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
        const slotOpacity = () => {
            const style = screen.findHostByTestId(`${TEST_ID}-trailing`)?.props.style;
            const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style ?? {});
            return flat.opacity ?? 1;
        };
        expect(slotOpacity()).toBe(0);

        await act(async () => {
            screen.findHostByTestId(`${TEST_ID}-field-row`)?.props.onPointerEnter?.({});
        });
        expect(slotOpacity()).toBe(1);

        await act(async () => {
            screen.findHostByTestId(`${TEST_ID}-field-row`)?.props.onPointerLeave?.({});
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
        });
        expect(slotOpacity()).toBe(1);
    });

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

    it('names a relay preview by the service it exposes while blurred, and keeps the real URL for focus and Copy', async () => {
        clipboardSpies.setClipboardStringSafe.mockClear();
        const realUrl = 'https://preview-abc123.example.test/docs/start';
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                displayHost="localhost:42511"
                value={realUrl}
                onSubmitUrl={vi.fn()}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.findByTestId(TEST_ID)?.props.value).toBe('localhost:42511/docs/start');

        await screen.pressByTestIdAsync(`${TEST_ID}-copy`);
        expect(clipboardSpies.setClipboardStringSafe).toHaveBeenCalledExactlyOnceWith(realUrl);

        await act(async () => {
            screen.findByTestId(TEST_ID)?.props.onFocus?.({});
            await Promise.resolve();
        });
        expect(screen.findByTestId(TEST_ID)?.props.value).toBe(realUrl);
    });

    it('does not add normal-mode focus chrome around the shared TextInput', async () => {
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

        // The parent row supplies structure and validation state, not a second focus treatment.
        expect(screen.findByTestId(`${TEST_ID}-field-row`)?.props.style[2]).toBeNull();
    });

    it('shows the authoritative URL on ordinary blur and restores it on refocus', async () => {
        const onSubmitUrl = vi.fn();
        const screen = await renderScreen(
            <BrowserUrlField
                testID={TEST_ID}
                density="toolbar"
                trailingAction="copy"
                formatWhileBlurred
                value="https://example.com/"
                onSubmitUrl={onSubmitUrl}
            />,
        );

        await act(async () => { screen.findByTestId(TEST_ID)?.props.onFocus?.({}); });
        screen.changeTextByTestId(TEST_ID, 'example.org/next');
        await act(async () => { screen.findByTestId(TEST_ID)?.props.onBlur?.({}); });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId(TEST_ID)?.props.value).toBe('example.com');
        expect(onSubmitUrl).not.toHaveBeenCalled();

        await act(async () => { screen.findByTestId(TEST_ID)?.props.onFocus?.({}); });
        expect(screen.findByTestId(TEST_ID)?.props.value).toBe('https://example.com/');
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

    it('searches a typed query with the default engine instead of failing (H-UX F-16)', async () => {
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

        expect(onNavigate).toHaveBeenCalledWith('https://duckduckgo.com/?q=how%20do%20i%20ship%20this');
        expect(screen.findByTestId(`${TEST_ID}-invalid`)).toBeNull();
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
            screen.findByTestId(TEST_ID)?.props.onChangeText?.('http://');
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

        // A typed query now searches (default engine); a malformed address is still refused.
        screen.changeTextByTestId(PANEL_ID, 'https://');
        await screen.pressByTestIdAsync(`${PANEL_ID}-open`);

        expect(onSubmitUrl).not.toHaveBeenCalled();
        expect(screen.findByTestId(`${PANEL_ID}-invalid`)).toBeTruthy();
    });

    it('submits the typed launchpad address after the Go button blurs the input', async () => {
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
        await act(async () => { screen.findByTestId(PANEL_ID)?.props.onFocus?.({}); });
        screen.changeTextByTestId(PANEL_ID, 'example.com');
        // A pointer press transfers focus before the button's release commits the submit.
        await act(async () => { screen.findByTestId(PANEL_ID)?.props.onBlur?.({}); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(onSubmitUrl).not.toHaveBeenCalled();
        await act(async () => { screen.findHostByTestId(`${PANEL_ID}-open`)?.props.onPressIn?.({}); });
        await screen.pressByTestIdAsync(`${PANEL_ID}-open`);

        expect(onSubmitUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/');
        expect(screen.findByTestId(PANEL_ID)?.props.value).toBe('');
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
