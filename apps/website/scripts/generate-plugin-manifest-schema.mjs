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
  await writeFile(
    outputPath,
    `${JSON.stringify(createPluginManifestJsonSchemaV2(), null, 2)}\n`,
    'utf8',
  );
  return outputPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await generatePluginManifestSchema();
}
