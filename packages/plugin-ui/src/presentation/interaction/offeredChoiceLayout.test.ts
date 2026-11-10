import { describe, expect, it } from 'vitest';
import { arrangeOfferedChoices, resolveOfferedChoiceLayout, type OfferedChoice } from './offeredChoiceLayout.js';

const choice = (id: string, refusal = false): OfferedChoice => ({ id, label: id, refusal, available: true });

describe('offered choice presentation layout', () => {
  it('shares a row while it fits and the primary leads, and lists in a narrow column', () => {
    const wide = { narrow: false, primaryLeadsApprovals: true, rowNaturalWidthPx: 480, containerWidthPx: 900 };
    expect(resolveOfferedChoiceLayout(wide)).toBe('row');
    expect(resolveOfferedChoiceLayout({ ...wide, rowNaturalWidthPx: 960 })).toBe('list');
    expect(resolveOfferedChoiceLayout({ ...wide, narrow: true })).toBe('list');
    expect(resolveOfferedChoiceLayout({ ...wide, primaryLeadsApprovals: false })).toBe('list');
    expect(resolveOfferedChoiceLayout({ ...wide, rowNaturalWidthPx: null, containerWidthPx: null })).toBe('row');
  });

  it('reads inward from the row end in caller order and separates trailing refusals', () => {
    const arranged = arrangeOfferedChoices([choice('once'), choice('session'), choice('always'), choice('reject', true)]);
    expect(arranged.rowStart.map(c => c.id)).toEqual(['reject']);
    expect(arranged.rowEnd.map(c => c.id)).toEqual(['always', 'session', 'once']);
    expect(arranged.refusalsTrail).toBe(true);
    expect(arrangeOfferedChoices([choice('reject', true), choice('once')]).refusalsTrail).toBe(false);
  });
});
