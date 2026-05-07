import { describe, expect, it } from 'vitest';
import { applyPaneFocusModeLayoutOverride } from './applyPaneFocusModeLayoutOverride';

describe('applyPaneFocusModeLayoutOverride', () => {
    it('returns the base layout when focus mode is inactive', () => {
        const base = { kind: 'twoPane', right: 'docked', details: 'hidden' } as const;
        expect(applyPaneFocusModeLayoutOverride({
            paneFocusModeActive: false,
            rightOpen: true,
            detailsOpen: false,
            baseLayout: base,
        })).toEqual(base);
    });

    it('returns the base layout when no panes are open', () => {
        const base = { kind: 'single', right: 'hidden', details: 'hidden' } as const;
        expect(applyPaneFocusModeLayoutOverride({
            paneFocusModeActive: true,
            rightOpen: false,
            detailsOpen: false,
            baseLayout: base,
        })).toEqual(base);
    });

    it('forces threePane docked when both panes are open', () => {
        expect(applyPaneFocusModeLayoutOverride({
            paneFocusModeActive: true,
            rightOpen: true,
            detailsOpen: true,
            baseLayout: { kind: 'overlayStack', right: 'hidden', details: 'overlay' },
        })).toEqual({ kind: 'threePane', right: 'docked', details: 'docked' });
    });

    it('forces right docked when only right is open', () => {
        expect(applyPaneFocusModeLayoutOverride({
            paneFocusModeActive: true,
            rightOpen: true,
            detailsOpen: false,
            baseLayout: { kind: 'overlayStack', right: 'overlay', details: 'hidden' },
        })).toEqual({ kind: 'twoPane', right: 'docked', details: 'hidden' });
    });

    it('forces details docked when only details is open', () => {
        expect(applyPaneFocusModeLayoutOverride({
            paneFocusModeActive: true,
            rightOpen: false,
            detailsOpen: true,
            baseLayout: { kind: 'overlayStack', right: 'hidden', details: 'overlay' },
        })).toEqual({ kind: 'twoPane', right: 'hidden', details: 'docked' });
    });
});
