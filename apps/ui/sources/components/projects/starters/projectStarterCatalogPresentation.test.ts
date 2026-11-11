import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStarterCatalogV1, listHappierStarterCatalogV1, readHappierStarterCatalogItemV1 } from '@happier-dev/protocol/registries/formats/happierStarterCatalog';
import { RegistryItemV1Schema } from '@happier-dev/protocol/registries/registryItemsV1';

const catalog = parseStarterCatalogV1(JSON.parse(readFileSync(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/starters.json', import.meta.url), 'utf8')));

describe('registry Project starter presentation data', () => {
  it('lists the shipped catalog and reads each displayed choice as a validated starter', () => {
    const page = listHappierStarterCatalogV1({ sourceId: 'builtin:starters', catalog, fetchedAt: 1 });
    expect(page.items.length).toBeGreaterThan(0);
    for (const summary of page.items) {
      const item = RegistryItemV1Schema.parse(readHappierStarterCatalogItemV1({ sourceId: page.sourceId, catalog, fetchedAt: 1, itemId: summary.itemId }));
      expect(item.summary).toMatchObject(summary);
      expect(item.payload.kind).toBe('starter');
      if (item.payload.kind !== 'starter') throw new Error('Expected starter payload');
      expect(item.payload.starter.title).toBe(summary.title);
      expect(item.payload.starter.description).toBe(summary.description);
    }
  });
});
