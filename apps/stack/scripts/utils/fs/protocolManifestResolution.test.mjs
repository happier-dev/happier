import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { generateProtocolExports } from '../../../../../packages/protocol/scripts/generate-exports.mjs';

test('Protocol package manifest resolves under the happier-source condition', async t => {
  const fixture = await createTempFixture(t, { prefix: 'protocol-manifest-resolution-' });
  await mkdir(fixture.path('src'));
  await writeFile(fixture.path('src/index.ts'), 'export const value = 1;');
  await writeFile(fixture.path('package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: {} }));
  await writeFile(fixture.path('tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
  await writeFile(fixture.path('export-aliases.json'), '{}');
  await generateProtocolExports({ packageRoot: fixture.root });
  const { stdout } = await promisify(execFile)(process.execPath, ['--conditions=happier-source', '--input-type=module', '-e',
    "import { createRequire } from 'node:module'; console.log(createRequire(process.cwd() + '/probe.mjs').resolve('@happier-dev/protocol/package.json'));"],
  { cwd: fixture.root, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(stdout.trim(), join(fixture.root, 'package.json'));
});
