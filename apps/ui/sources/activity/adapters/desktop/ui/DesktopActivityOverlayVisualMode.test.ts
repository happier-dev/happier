import { describe, expect, it } from 'vitest';

import { resolveDesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';

describe('resolveDesktopActivityOverlayVisualMode', () => {
    it('prefers resolved host mode over explicit presentation mode when host diagnostics are available', () => {
        expect(resolveDesktopActivityOverlayVisualMode({
            presentationMode: 'notch_integrated',
            hostMode: 'floating',
        })).toBe('floating_overlay');

        expect(resolveDesktopActivityOverlayVisualMode({
            presentationMode: 'floating_overlay',
            hostMode: 'notch_integrated',
        })).toBe('notch_integrated');
    });

    it('uses native host mode when presentation mode is automatic', () => {
        expect(resolveDesktopActivityOverlayVisualMode({
            presentationMode: 'automatic',
            hostMode: 'notch_integrated',
        })).toBe('notch_integrated');

        expect(resolveDesktopActivityOverlayVisualMode({
            presentationMode: 'automatic',
            hostMode: 'floating',
        })).toBe('floating_overlay');
    });

    it('falls back to floating chrome when automatic presentation mode has no host diagnostics', () => {
        expect(resolveDesktopActivityOverlayVisualMode({
            presentationMode: 'automatic',
            hostMode: null,
        })).toBe('floating_overlay');

        expect(resolveDesktopActivityOverlayVisualMode({
            presentationMode: 'automatic',
            hostMode: null,
        })).toBe('floating_overlay');
    });
});
