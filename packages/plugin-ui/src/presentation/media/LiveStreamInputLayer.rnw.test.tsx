import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierLiveStreamInputLayer } from './LiveStreamInputLayer.js';
import type { HappierLiveStreamInputGesture } from './inputGesture.js';

describe('live stream keyboard focus', () => {
    it('leaves Shift+Tab to local traversal while retaining ordinary guest keys and text', () => {
        const gestures: HappierLiveStreamInputGesture[] = [];
        const mounted = mountThroughReactNativeWeb(
            <HappierLiveStreamInputLayer inputAccepted supports={() => true}
                onGesture={({ action }) => gestures.push(action)} testID="viewer" />,
        );
        try {
            const capture = mounted.container.querySelector<HTMLElement>('[data-testid="viewer-capture"]');
            expect(capture).not.toBeNull();
            act(() => capture!.focus());
            expect(document.activeElement).toBe(capture);

            const leave = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
            act(() => capture!.dispatchEvent(leave));
            expect(leave.defaultPrevented).toBe(false);
            expect(gestures).toEqual([]);

            for (const key of ['Tab', 'Escape', 'a']) {
                const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                act(() => capture!.dispatchEvent(event));
                expect(event.defaultPrevented).toBe(true);
            }
            expect(gestures).toEqual([
                { kind: 'keyboard_key', key: 'Tab' },
                { kind: 'keyboard_key', key: 'Escape' },
                { kind: 'keyboard_text', text: 'a' },
            ]);

            act(() => capture!.blur());
            const unfocused = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            act(() => capture!.dispatchEvent(unfocused));
            expect(unfocused.defaultPrevented).toBe(false);
            expect(gestures).toHaveLength(3);
        } finally {
            mounted.unmount();
        }
    });
});
