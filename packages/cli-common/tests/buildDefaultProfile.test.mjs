import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { transform } from 'esbuild';

import { bakeBuildDefaultProfile } from '../scripts/bakeBuildDefaultProfile.mjs';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('a baked profile survives a fresh process without build environment', async () => {
  const stageDistDir = await mkdtemp(join(packageDir, '.tmp.profile-bake-'));
  try {
    await writeFile(join(stageDistDir, 'package.json'), '{"type":"module"}');
    for (const name of ['happierCloud', 'bakedBuildDefaultProfile']) {
      const source = await readFile(join(packageDir, 'src', `${name}.ts`), 'utf8');
      const result = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' });
      await writeFile(join(stageDistDir, `${name}.js`), result.code);
    }
    const profile = {
      accountService: { url: 'https://accounts.example.test' },
      home: { url: 'https://home.example.test', webappUrl: 'https://app.example.test' },
      personalHome: { value: 'offer' },
    };
    await bakeBuildDefaultProfile({ stageDistDir, env: { HAPPIER_BUILD_DEFAULT_PROFILE_JSON: JSON.stringify(profile) } });
    const env = { ...process.env };
    delete env.HAPPIER_BUILD_DEFAULT_PROFILE_JSON;
    delete env.EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const p = await import(${JSON.stringify(pathToFileURL(join(stageDistDir, 'happierCloud.js')).href)}); process.stdout.write(JSON.stringify(p.resolveBuildDefaultProfile()));`,
    ], { env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), profile);
    await assert.rejects(bakeBuildDefaultProfile({ stageDistDir, env: { HAPPIER_BUILD_DEFAULT_PROFILE_JSON: '{"personalHome":{"value":"secret"}}' } }),
      { name: 'BuildDefaultProfileError', path: 'personalHome.value' });
  } finally {
    await rm(stageDistDir, { recursive: true, force: true });
  }
});
