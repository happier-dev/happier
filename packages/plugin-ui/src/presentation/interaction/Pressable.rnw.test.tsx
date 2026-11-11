import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierPressable } from './Pressable.js';

describe('shared pressable focus ownership', () => {
    it('keeps the opener focusable while an asynchronous press is admitted, refusing duplicate activation', async () => {
        let finish!: () => void;
        let activations = 0;
        const admission = new Promise<void>(resolve => { finish = resolve; });
        const mounted = mountThroughReactNativeWeb(<HappierPressable testID="opener" accessibilityLabel="New view"
            onPress={async () => { activations++; await admission; }} />);
        try {
            const opener = mounted.container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
            await act(async () => { opener.focus(); opener.click(); });
            expect(opener.disabled).toBe(false);
            expect(document.activeElement).toBe(opener);
            expect(opener.getAttribute('aria-busy')).toBe('true');
            expect(opener.getAttribute('aria-disabled')).toBe('true');
            await act(async () => opener.click());
            expect(activations).toBe(1);
            await act(async () => finish());
            expect(document.activeElement).toBe(opener);
            expect(opener.getAttribute('aria-disabled')).not.toBe('true');
        } finally { finish(); mounted.unmount(); }
    });
    it('uses pressed for toggle buttons and checked for checkboxes', () => {
        const mounted = mountThroughReactNativeWeb(<>
            <HappierPressable accessibilityRole="button" accessibilityLabel="Editor first" selected checked />
            <HappierPressable accessibilityRole="checkbox" accessibilityLabel="Show editor" checked />
        </>);
        try {
            const button = mounted.container.querySelector('[role="button"]')!;
            expect(button.getAttribute('aria-label')).toBe('Editor first');
            expect(button.getAttribute('aria-pressed')).toBe('true');
            expect(button.hasAttribute('aria-checked')).toBe(false);
            expect(mounted.container.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
        } finally { mounted.unmount(); }
    });
    it.each([false, true])('preserveFocusOnPress=%s retains the input only when requested and still activates', preserveFocusOnPress => {
        let activations = 0;
        const mounted = mountThroughReactNativeWeb(<>
            <input data-testid="input" />
            <HappierPressable preserveFocusOnPress={preserveFocusOnPress} onPress={() => { activations++; }} accessibilityLabel="Keyboard" testID="keyboard" />
        </>);
        const input = mounted.container.querySelector<HTMLInputElement>('input')!;
        const button = mounted.container.querySelector<HTMLElement>('[data-testid="keyboard"]')!;
        try {
            act(() => input.focus());
            const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
            act(() => button.dispatchEvent(down));
            // jsdom has no browser default focus transfer; this is the OS boundary.
            if (!down.defaultPrevented) act(() => button.focus());
            act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })));
            expect(document.activeElement).toBe(preserveFocusOnPress ? input : button);
            expect(activations).toBe(1);
        } finally { mounted.unmount(); }
    });
});
