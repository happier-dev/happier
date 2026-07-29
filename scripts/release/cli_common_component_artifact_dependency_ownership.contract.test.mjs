import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const cliCommonRoot = join(repoRoot, 'packages', 'cli-common');

test('cli-common owns tar as a runtime dependency for its exported component-artifact builder', async () => {
  const [packageJson, componentArtifactExports, builderSource] = await Promise.all([
    readFile(join(cliCommonRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(cliCommonRoot, 'src', 'componentArtifacts', 'index.ts'), 'utf8'),
    readFile(
      join(cliCommonRoot, 'src', 'componentArtifacts', 'buildCliBinaryArtifactPayload.ts'),
      'utf8',
    ),
  ]);

  assert.match(
    componentArtifactExports,
    /export \* from '\.\/buildCliBinaryArtifactPayload\.js';/u,
    'the component-artifact builder must remain an exported production path',
  );
  assert.match(
    builderSource,
    /import \* as tar from 'tar';/u,
    'the component-artifact builder must continue to use its package-owned archive library',
  );
  assert.match(
    builderSource,
    /await tar\.c\(/u,
    'the deferred Voice archive must be created through the imported archive library',
  );
  assert.equal(
    packageJson.dependencies?.tar,
    '7.5.22',
    'an exported production artifact builder must own tar in dependencies',
  );
  assert.equal(
    packageJson.devDependencies?.tar,
    undefined,
    'tar must not be demoted to a development-only dependency while production source imports it',
  );
});
