import { describe, expect, it } from 'vitest';
import { resolveCollectionColumns } from './collectionColumns';

const columns = [{ id: 'identity', title: 'Name', primary: true }, { id: 'state', title: 'State' }, { id: 'runsOn', title: 'Runs on' }];
describe('Collection column placement', () => {
  it('keeps identity first and visible, allows every other built-in to hide and reorder, and resets defaults', () => {
    const result = resolveCollectionColumns(columns, { orderedIds: ['runsOn', 'identity', 'state'], placements: { identity: 'hidden', state: 'hidden' } });
    expect(result.visibleIds).toEqual(['identity', 'runsOn']);
    expect(result.ordered.map(column => column.id)).toEqual(['identity', 'runsOn', 'state']);
    expect(resolveCollectionColumns(columns).visibleIds).toEqual(['identity', 'state', 'runsOn']);
  });
  it('retains absent column preferences without adding missing columns to the live table', () => {
    expect(resolveCollectionColumns(columns, { orderedIds: ['retired', 'runsOn'], placements: { retired: 'pinned' } }).visibleIds)
      .toEqual(['identity', 'runsOn', 'state']);
  });
});
