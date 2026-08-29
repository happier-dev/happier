import { describe, expect, it } from 'vitest';

import {
  PluginCollectionOpaqueCursorV1Schema,
} from './collectionOpaqueCursorV1.js';
import {
  PluginCollectionUiQueryRequestV1Schema,
  PluginCollectionUiQueryResultV1Schema,
} from './collectionUiQueryWireV1.js';
import * as collectionsWire from './collectionsV1.js';

/**
 * The one opaque Collection cursor grammar, pinned at its canonical leaf.
 *
 * This is the exact bound every direct query, UI query, encryption-migration
 * page and plugin Action carries: 1–4096 base64url characters. The incumbent
 * Zod wire parents admit the same values through the one `asProtocolZod`
 * bridge, so a value the canonical parser refuses cannot enter any Collection
 * wire through a parallel local spelling.
 */

const MAX_CURSOR = 'a'.repeat(4096);

function uiQueryRequestWith(cursor: unknown): Readonly<Record<string, unknown>> {
  return {
    pluginId: 'happier.example.plugin',
    collectionId: 'examples',
    uiQueryId: 'page',
    parameters: {},
    cursor,
  };
}

describe('the opaque Collection cursor grammar', () => {
  it('admits exactly one to 4096 base64url characters', () => {
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse('a').success).toBe(true);
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse(MAX_CURSOR)).toEqual({
      success: true,
      data: MAX_CURSOR,
    });
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse(`${MAX_CURSOR}a`).success).toBe(false);
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse('').success).toBe(false);
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse('next page').success).toBe(false);
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse('next+page=').success).toBe(false);
    expect(PluginCollectionOpaqueCursorV1Schema.safeParse(42).success).toBe(false);
  });

  it('projects the exact portable JSON Schema grammar', () => {
    expect(PluginCollectionOpaqueCursorV1Schema.jsonSchema).toEqual({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      pattern: '^[A-Za-z0-9_-]+$',
    });
  });

  it('stays one value across the direct wire and collections re-exports', () => {
    expect(collectionsWire.PluginCollectionOpaqueCursorV1Schema).toBe(
      PluginCollectionOpaqueCursorV1Schema,
    );
  });

  it('admits the same cursors through the Zod UI-query wire bridge', () => {
    expect(PluginCollectionUiQueryRequestV1Schema.safeParse(uiQueryRequestWith(MAX_CURSOR)).success)
      .toBe(true);
    expect(PluginCollectionUiQueryRequestV1Schema.safeParse(uiQueryRequestWith('bad cursor')).success)
      .toBe(false);
    expect(PluginCollectionUiQueryRequestV1Schema.safeParse(uiQueryRequestWith(`${MAX_CURSOR}a`)).success)
      .toBe(false);
    expect(PluginCollectionUiQueryRequestV1Schema.safeParse(uiQueryRequestWith(undefined)).success)
      .toBe(true);
    expect(PluginCollectionUiQueryResultV1Schema.safeParse({
      rows: [],
      nextCursor: MAX_CURSOR,
      changeCursor: 0,
    }).success).toBe(true);
    expect(PluginCollectionUiQueryResultV1Schema.safeParse({
      rows: [],
      nextCursor: 'not base64url',
      changeCursor: 0,
    }).success).toBe(false);
  });
});
