import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { createPluginManifestJsonSchemaV2 } from './jsonSchema.js';
import { PluginManifestV2Schema } from './v2.js';

const validManifest = {
  schemaVersion: 2,
  id: 'acme.schema',
  version: '0.1.0',
  displayName: 'Schema fixture',
  engines: { happier: '^0.2.0' },
  runtime: { apiVersion: 1 },
  entrypoints: {
    daemon: './dist/index.js',
    development: './src/index.ts',
  },
  contributes: {
    actions: [{
      id: 'hello',
      title: 'Hello',
      scopes: ['global'],
      surfaces: ['cli'],
      placement: 'commandPalette',
      dangerLevel: 'safe',
    }],
  },
} as const;

describe('createPluginManifestJsonSchemaV2', () => {
  it('deterministically derives the external schema from the canonical host schema', () => {
    const first = createPluginManifestJsonSchemaV2();
    const second = createPluginManifestJsonSchemaV2();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://happier.dev/schemas/plugin-manifest-v2.json',
      title: 'Happier Plugin Manifest v2',
      type: 'object',
      additionalProperties: false,
    });

    const externalSchema = z.fromJSONSchema(first);
    expect(PluginManifestV2Schema.safeParse(validManifest).success).toBe(true);
    expect(externalSchema.safeParse(validManifest).success).toBe(true);
  });

  it('rejects a host-rejected unknown behavior key at the generated schema boundary', () => {
    const invalid = { ...validManifest, uses: ['actions'] };
    const externalSchema = z.fromJSONSchema(createPluginManifestJsonSchemaV2());

    expect(PluginManifestV2Schema.safeParse(invalid).success).toBe(false);
    expect(externalSchema.safeParse(invalid).success).toBe(false);
  });

  it('keeps the published happier.dev schema synchronized with the canonical owner', async () => {
    const published = JSON.parse(await readFile(
      new URL('../../../../../apps/website/public/schemas/plugin-manifest-v2.json', import.meta.url),
      'utf8',
    )) as unknown;

    expect(published).toEqual(createPluginManifestJsonSchemaV2());
  });
});
