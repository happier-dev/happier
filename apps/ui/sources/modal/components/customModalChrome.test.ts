import { describe, expect, it } from 'vitest';
import { areChromeConfigsEqual, mergeChromeConfig, resolveCustomModalPresentation } from './customModalChrome';

describe('custom modal chrome ownership', () => {
    it.each(['phone', 'tablet'] as const)('lets a media stage own its fullscreen presentation on %s', device => {
        expect(resolveCustomModalPresentation({ kind: 'stage', title: 'Photo' }, device)).toMatchObject({
            card: null, placement: 'fullscreen', scrollHost: 'body', showBackdrop: false, motion: 'none',
        });
    });
    it('merges a stage update without losing its anchor and recognizes stable chrome', () => {
        const merged = mergeChromeConfig({ kind: 'stage', title: 'First', testID: 'gallery' }, { kind: 'stage', title: 'Second' });
        expect(merged).toEqual({ kind: 'stage', title: 'Second', testID: 'gallery' });
        expect(areChromeConfigsEqual(merged, { kind: 'stage', title: 'Second', testID: 'gallery' })).toBe(true);
        expect(areChromeConfigsEqual(merged, { kind: 'stage', title: 'Third', testID: 'gallery' })).toBe(false);
        expect(areChromeConfigsEqual(merged, { kind: 'card', title: 'Second', testID: 'gallery' })).toBe(false);
    });
    it('hangs a card with a trigger anchor from that trigger on wide layouts; a phone keeps its sheet', () => {
        const anchor = { kind: 'rect' as const, rect: { left: 900, top: 320, width: 32, height: 32 } };
        const card = { kind: 'card' as const, title: 'Share', phonePresentation: 'sheet' as const, anchor };
        expect(resolveCustomModalPresentation(card, 'tablet')).toMatchObject({ anchor, phoneSheet: false });
        expect(resolveCustomModalPresentation(card, 'phone')).toMatchObject({ anchor: null, phoneSheet: true, placement: 'bottom' });
        expect(resolveCustomModalPresentation({ kind: 'card', title: 'Share' }, 'tablet')).toMatchObject({ anchor: null, placement: 'center' });
        // A content-published chrome update keeps the trigger it opened from.
        const merged = mergeChromeConfig(card, { kind: 'card', subtitle: 'Workflow' });
        expect(merged).toMatchObject({ anchor, subtitle: 'Workflow' });
        expect(areChromeConfigsEqual(merged, { ...card, subtitle: 'Workflow', anchor: { kind: 'view', ref: { current: null } } })).toBe(false);
    });
    it('centers a wide card when its trigger ref is no longer available', () => {
        const anchor = { kind: 'view' as const, ref: { current: null } };
        expect(resolveCustomModalPresentation({ kind: 'card', title: 'Share', anchor }, 'tablet'))
            .toMatchObject({ anchor: null, placement: 'center' });
    });
});
