import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { readWorkspaceBuildInputs } from './workspaceBuildInputs.mjs';
import { captureBuildInputFiles } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { generateProtocolExports } from '../../../../../packages/protocol/scripts/generate-exports.mjs';

test('workspace capture preserves private source inputs used to verify Protocol exports', async t => {
  const fixture = await createTempFixture(t, { prefix: 'protocol-export-inputs-' });
  const sourceDir = fixture.path('source');
  const packageRoot = join(sourceDir, 'packages/protocol');
  await mkdir(join(packageRoot, 'scripts'), { recursive: true });
  await writeFile(join(packageRoot, 'scripts/generate-exports.mjs'), '// export generator input marker\n');
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', exports: {} }));
  await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
  await writeFile(join(packageRoot, 'export-aliases.json'), '{}');
  for (const path of ['index.ts', 'deployments/newUntrackedSource.ts', 'crypto/fixtures/legacy.ts',
    'test/setup.ts', 'ambient.d.ts', 'index.ts.scratch']) {
    const file = join(packageRoot, 'src', path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'export const value = 1;\n');
  }
  await generateProtocolExports({ packageRoot });
  const captureDir = fixture.path('capture');
  await captureBuildInputFiles({ sourceDir, captureDir, readPaths: () =>
    readWorkspaceBuildInputs(packageRoot, { includeShippedFiles: true }).map(path => `packages/protocol/${path}`),
  });
  const capturedPackage = join(captureDir, 'packages/protocol');
  await generateProtocolExports({ packageRoot: capturedPackage, check: true });
  assert.equal(await readFile(join(capturedPackage, 'src/deployments/newUntrackedSource.ts'), 'utf8'),
    'export const value = 1;\n');
});
