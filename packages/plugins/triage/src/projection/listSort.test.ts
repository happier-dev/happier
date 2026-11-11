import { describe, expect, it } from 'vitest';
import { TRIAGE_LIST_NO_FILTERS_V1 } from './listWindow.js';
import { readTriageListSortFieldsV1, selectTriageListSourcesV1 } from './listSort.js';
const A = { pluginId: 'acme.tasks', localId: 'work' };
const B = { pluginId: 'acme.forge', localId: 'issues' };
const sources = [
 { source: A, sourceInstanceId: 'a1', sortFields: ['updated', 'created', 'status'] as const },
 { source: A, sourceInstanceId: 'a2', sortFields: ['created', 'updated'] as const },
 { source: B, sourceInstanceId: 'b1', sortFields: ['updated', 'due'] as const },
];
describe('source-owned list sorting', () => {
 it('intersects every selected connection and treats omitted capability as empty', () => {
  expect(readTriageListSortFieldsV1(sources)).toEqual(['updated']);
  expect(readTriageListSortFieldsV1([...sources, { source: B, sourceInstanceId: 'b2' }])).toEqual([]);
  expect(readTriageListSortFieldsV1([])).toEqual([]);
 });
 it('selects possible source lanes from the same conjunctive source, type and scope facets', () => {
  const filters = { ...TRIAGE_LIST_NO_FILTERS_V1, sources: [{ source: A }],
    types: [{ source: A, kindId: 'task' }], scopes: [{ source: A, sourceInstanceId: 'a2', unitId: 'team' }] };
  expect(selectTriageListSourcesV1(sources, filters)).toEqual([sources[1]]);
  expect(readTriageListSortFieldsV1(selectTriageListSourcesV1(sources, filters))).toEqual(['updated', 'created']);
  expect(selectTriageListSourcesV1(sources, { ...filters, types: [{ source: B, kindId: 'issue' }] })).toEqual([]);
 });
});
