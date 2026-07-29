import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createPluginManifestJsonSchemaV2,
  PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID,
} from '@happier-dev/protocol';

import { generatePluginManifestSchema } from './generate-plugin-manifest-schema.mjs';

const websiteRoot = fileURLToPath(new URL('..', import.meta.url));

test('generates the exact protocol-owned schema at its canonical public path', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'happier-plugin-manifest-schema-'));
  try {
    const outputPath = await generatePluginManifestSchema({ publicDir });
    const schema = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(
      outputPath,
      join(publicDir, 'schemas', 'plugin-manifest-v2.json'),
    );
    assert.equal(schema.$id, PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID);
    assert.deepEqual(schema, createPluginManifestJsonSchemaV2());
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test('keeps the committed public schema synchronized with its protocol owner', async () => {
  const schema = JSON.parse(await readFile(
    join(websiteRoot, 'public', 'schemas', 'plugin-manifest-v2.json'),
    'utf8',
  ));

  assert.deepEqual(schema, createPluginManifestJsonSchemaV2());
});
