import { describe, expect, it } from 'vitest';

import {
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 as ROOT_PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 as ROOT_PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
} from '../../index.js';
import {
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  PluginCollectionMutationRequestV1Schema,
  PluginCollectionQueryRequestV1Schema,
} from './collectionsV1.js';

describe('generic Collection row limits', () => {
  it('exposes the schema-owned bounds through the Protocol root entrypoint', () => {
    expect(ROOT_PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1)
      .toBe(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1);
    expect(ROOT_PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1)
      .toBe(PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1);
  });

  it('exports the same Protocol-owned ceilings enforced by the wire schemas', () => {
    expect(PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1).toBe(200);
    expect(PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1).toBe(100);

    expect(PluginCollectionQueryRequestV1Schema.safeParse({
      pluginId: 'acme.plugin',
      collectionId: 'items',
      indexId: 'byKind',
      order: 'asc',
      limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 + 1,
    }).success).toBe(false);
    expect(PluginCollectionMutationRequestV1Schema.safeParse({
      pluginId: 'acme.plugin',
      collectionId: 'items',
      writerContext: { kind: 'plugin', pluginId: 'acme.plugin' },
      operations: Array.from(
        { length: PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 + 1 },
        (_, index) => ({
          kind: 'delete',
          rowId: `row-${String(index)}`,
          expectedRevision: 1,
        }),
      ),
    }).success).toBe(false);
  });
});
