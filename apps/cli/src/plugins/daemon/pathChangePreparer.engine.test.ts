import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

import { createDaemonPathPluginChangePreparer } from './pathChangePreparer';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

it('refuses a code-defined development candidate with an incompatible host range before review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-development-engine-'));
  try {
    const sourcePath = join(root, 'plugin.mjs');
    const manifest = createPluginManifestV2Fixture({ id: 'acme.future-development',
      engines: { happier: '>=999.0.0' }, entrypoints: { daemon: './plugin.mjs' } });
    await writeFile(sourcePath, `export const manifest = ${JSON.stringify(manifest)};\nexport function activate() {}\n`);
    const prepare = createDaemonPathPluginChangePreparer({ happyHomeDir: join(root, 'home'),
      runtimeLifecycle: { async prepare() { throw new Error('Incompatible candidate must not be adopted'); } } });
    await expect(prepare({ kind: 'development', sourceRootPath: sourcePath }))
      .rejects.toMatchObject({ code: 'plugin_manifest_engine_incompatible' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
