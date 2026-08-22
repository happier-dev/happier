import { describe, expect, it } from 'vitest';

import {
  MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
  TRIAGE_LIST_DEFAULT_LENS_V1,
  TRIAGE_LIST_NO_FILTERS_V1,
} from '../../projection/listWindow.js';
import { TRIAGE_SURFACE_INITIAL_STATE_V1 } from '../state/surface.js';
import { readTriageWindowLensV1 } from './lens.js';

const SOURCE = { pluginId: 'acme.scm', localId: 'github' } as const;

describe('the window lens the shell reads from the one reducer', () => {
  it('composes to exactly the window owner default when the reader has changed nothing', () => {
    // This is what keeps a fresh mount from marking its own window stale before
    // its first pass has even settled: the lens it publishes IS the store's.
    expect(readTriageWindowLensV1(TRIAGE_SURFACE_INITIAL_STATE_V1))
      .toEqual(TRIAGE_LIST_DEFAULT_LENS_V1);
  });

  it('carries the reducer order, facets and Smart precedence to the window', () => {
    const lens = readTriageWindowLensV1({
      ...TRIAGE_SURFACE_INITIAL_STATE_V1,
      order: 'smart',
      smartPolicy: { v: 1, precedence: ['activity', 'attention'] },
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: SOURCE }], states: ['open'] },
    });

    expect(lens.order).toBe('smart');
    expect(lens.smartPolicy).toEqual({ v: 1, precedence: ['activity', 'attention'] });
    expect(lens.filters.sources).toEqual([{ source: SOURCE }]);
    expect(lens.filters.states).toEqual(['open']);
  });

  it('sends the settled query and never the IME-intermediate text', () => {
    // The composition is not a value yet. A window rebuilt from it would filter
    // the list on half-typed text and then filter it again on the settled text.
    expect(readTriageWindowLensV1({
      ...TRIAGE_SURFACE_INITIAL_STATE_V1,
      search: { query: 'auth', composing: 'ふぁ' },
    }).query).toBe('auth');
  });

  it('takes the row bound from the window owner rather than naming a second number', () => {
    expect(readTriageWindowLensV1(TRIAGE_SURFACE_INITIAL_STATE_V1).limit)
      .toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
  });
});
