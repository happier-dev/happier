import { describe, expect, it } from 'vitest';
import { listHappierAppCatalogV1 } from './happierAppCatalog.js';

describe('Happier app catalog listing', () => {
  it('carries each app template category on its summary, where the Store category condition reads it', () => {
    const page = listHappierAppCatalogV1({ sourceId: 'data-services', fetchedAt: 1, catalog: { schemaVersion: 1, apps: [
      { itemId: 'postgresql', app: { schemaVersion: 1, title: 'PostgreSQL', category: 'database' } },
      { itemId: 'notes', app: { schemaVersion: 1, title: 'Notes' } },
    ] } as never });
    expect(page.items.map((item) => [item.itemId, item.appMetadata?.category])).toEqual([
      ['postgresql', 'database'], ['notes', undefined],
    ]);
  });
});
