import { describe, expect, it } from 'vitest';

import {
  parseTriageSearchQuery,
  projectTriageEntrySearchText,
  triageEntryMatchesSearch,
} from '../../projection/entrySearch.js';
import { TRIAGE_LIST_NO_FILTERS_V1 } from '../../projection/listWindow.js';
import { hasSelectedTriageFacetV1, readTriageLensNarrowingV1 } from './narrowing.js';

const SOURCE = { pluginId: 'happier.example.source', localId: 'example-forge' } as const;

describe('the one lens-narrowing predicate', () => {
  it('counts a selected value in any of the five facets', () => {
    expect(hasSelectedTriageFacetV1(TRIAGE_LIST_NO_FILTERS_V1)).toBe(false);
    expect(hasSelectedTriageFacetV1({ ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: SOURCE }] }))
      .toBe(true);
    expect(hasSelectedTriageFacetV1({
      ...TRIAGE_LIST_NO_FILTERS_V1,
      types: [{ source: SOURCE, kindId: 'pull-request' }],
    })).toBe(true);
    expect(hasSelectedTriageFacetV1({
      ...TRIAGE_LIST_NO_FILTERS_V1,
      scopes: [{ source: SOURCE, collisionScope: 'acme/widgets' }],
    })).toBe(true);
    expect(hasSelectedTriageFacetV1({ ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] })).toBe(true);
    expect(hasSelectedTriageFacetV1({ ...TRIAGE_LIST_NO_FILTERS_V1, attention: ['required'] }))
      .toBe(true);
  });

  it('calls a query narrowing exactly when the one search owner removes a row for it', () => {
    // The discriminating case, and the whole reason this predicate is not
    // `query.length > 0`: the search owner trims and splits on whitespace, so a
    // query of spaces alone yields no term and keeps every row. Calling that
    // "filtered" makes the empty slot tell a reader that nothing matches their
    // filters while the list they are looking at was never narrowed at all.
    const text = projectTriageEntrySearchText([]);
    for (const query of ['', ' ', '   ', '\t', '\n ']) {
      expect(parseTriageSearchQuery(query)).toEqual([]);
      expect(triageEntryMatchesSearch(text, parseTriageSearchQuery(query))).toBe(true);
      expect(readTriageLensNarrowingV1({ filters: TRIAGE_LIST_NO_FILTERS_V1, query }))
        .toEqual({ facets: false, search: false, narrowed: false });
    }

    expect(readTriageLensNarrowingV1({ filters: TRIAGE_LIST_NO_FILTERS_V1, query: 'parser' }))
      .toEqual({ facets: false, search: true, narrowed: true });
    // Padding around a real term is still that term, so it still narrows.
    expect(readTriageLensNarrowingV1({ filters: TRIAGE_LIST_NO_FILTERS_V1, query: '  parser  ' }).search)
      .toBe(true);
  });

  it('keeps the two causes apart so each names its own way out', () => {
    const facetOnly = readTriageLensNarrowingV1({
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] },
      query: '  ',
    });
    expect(facetOnly).toEqual({ facets: true, search: false, narrowed: true });

    const both = readTriageLensNarrowingV1({
      filters: { ...TRIAGE_LIST_NO_FILTERS_V1, states: ['done'] },
      query: 'parser',
    });
    expect(both).toEqual({ facets: true, search: true, narrowed: true });
  });
});
