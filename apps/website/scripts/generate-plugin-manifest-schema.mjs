import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPluginManifestJsonSchemaV2 } from '@happier-dev/protocol';

const defaultPublicDir = fileURLToPath(new URL('../public', import.meta.url));

export async function generatePluginManifestSchema({
  publicDir = defaultPublicDir,
} = {}) {
  const outputPath = join(publicDir, 'schemas', 'plugin-manifest-v2.json');
  await mkdir(join(publicDir, 'schemas'), { recursive: true });
  /*
   * Minified, not pretty-printed.
   *
   * This file is a published artifact, not a document anyone reads in a
   * browser: its URL is the schema's own `$id`
   * (PLUGIN_MANIFEST_JSON_SCHEMA_V2_ID), which is what editors fetch to give
   * plugin authors autocomplete, and what apps/docs/content/docs/plugins/manifest
   * links to. Nothing renders it as text.
   *
   * `null, 2` made it 1.98 MB, of which 1.51 MB was indentation — 76% of the
   * largest single file in the deploy, and enough on its own to put dist/ at
   * exactly the 26 MB budget. The guard in
   * packages/protocol/src/plugins/manifest/jsonSchema.test.ts JSON.parses the
   * file before comparing, so whitespace was never part of the contract.
   */
  await writeFile(
    outputPath,
    `${JSON.stringify(createPluginManifestJsonSchemaV2())}\n`,
    'utf8',
  );
  return outputPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await generatePluginManifestSchema();
}
