import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { loadCliCommonWorkspacesModule } from './loadCliCommonWorkspacesModule.mjs';

function createCliCommonFixture(prefix) {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  const packageDir = resolve(repoRoot, 'packages', 'cli-common');
  mkdirSync(resolve(packageDir, 'dist', 'workspaces'), { recursive: true });
  writeFileSync(
    resolve(packageDir, 'package.json'),
    `${JSON.stringify({ name: '@happier-dev/cli-common', type: 'module' })}\n`,
    'utf8',
  );
  return {
    repoRoot,
    packageDir,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

test('reloads the admitted cli-common workspaces graph when only a transitive helper changes', async () => {
  const fixture = createCliCommonFixture('happier-cli-common-workspaces-loader-reload-');
  const entryPath = resolve(fixture.packageDir, 'dist', 'workspaces', 'index.js');
  const helperPath = resolve(fixture.packageDir, 'workspaceRuntimeDependencies.mjs');
  const entrySource = "export { generation } from '../../workspaceRuntimeDependencies.mjs';\n";
  writeFileSync(entryPath, entrySource, 'utf8');
  writeFileSync(helperPath, 'export const generation = 0;\n', 'utf8');

  let admittedGeneration = 0;
  const ensureWorkspacePackagesBuiltByName = async (_repoRoot, _packageNames, options) => {
    assert.equal(options.force, true);
    admittedGeneration += 1;
    writeFileSync(
      helperPath,
      `export const generation = ${admittedGeneration};\n`,
      'utf8',
    );
  };

  try {
    const generationOne = await loadCliCommonWorkspacesModule(
      fixture.repoRoot,
      {},
      ensureWorkspacePackagesBuiltByName,
      { force: true },
    );
    const generationTwo = await loadCliCommonWorkspacesModule(
      fixture.repoRoot,
      {},
      ensureWorkspacePackagesBuiltByName,
      { force: true },
    );

    assert.equal(generationOne.generation, 1);
    assert.equal(generationTwo.generation, 2);
    assert.equal(readFileSync(entryPath, 'utf8'), entrySource);

    const sameGeneration = await loadCliCommonWorkspacesModule(
      fixture.repoRoot,
      {},
      async () => {},
      { force: true },
    );
    assert.strictEqual(sameGeneration, generationTwo);
    const snapshotParent = resolve(fixture.repoRoot, '.project', 'tmp');
    assert.equal(
      existsSync(snapshotParent)
        && readdirSync(snapshotParent)
          .some((name) => name.startsWith('cli-common-workspaces-loader.')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('keeps concurrent same-content loads alive until their shared graph import completes', async () => {
  const fixture = createCliCommonFixture('happier-cli-common-workspaces-loader-concurrent-');
  const entryPath = resolve(fixture.packageDir, 'dist', 'workspaces', 'index.js');
  const helperPath = resolve(fixture.packageDir, 'workspaceRuntimeDependencies.mjs');
  writeFileSync(
    entryPath,
    "export { generation } from '../../workspaceRuntimeDependencies.mjs';\n",
    'utf8',
  );
  writeFileSync(helperPath, 'export const generation = 7;\n', 'utf8');

  let admissionCount = 0;
  let releaseAdmissions;
  const admissionsReady = new Promise((resolvePromise) => {
    releaseAdmissions = resolvePromise;
  });
  const ensureWorkspacePackagesBuiltByName = async () => {
    admissionCount += 1;
    if (admissionCount === 2) releaseAdmissions();
    await admissionsReady;
  };

  try {
    const [first, second] = await Promise.all([
      loadCliCommonWorkspacesModule(
        fixture.repoRoot,
        {},
        ensureWorkspacePackagesBuiltByName,
        { force: true },
      ),
      loadCliCommonWorkspacesModule(
        fixture.repoRoot,
        {},
        ensureWorkspacePackagesBuiltByName,
        { force: true },
      ),
    ]);

    assert.equal(first.generation, 7);
    assert.strictEqual(first, second);
  } finally {
    fixture.cleanup();
  }
});

test('retains the missing cli-common workspaces helper failure after admission', async () => {
  const fixture = createCliCommonFixture('happier-cli-common-workspaces-loader-missing-');
  let admitted = false;

  try {
    await assert.rejects(
      loadCliCommonWorkspacesModule(
        fixture.repoRoot,
        {},
        async () => {
          admitted = true;
        },
      ),
      /Missing cli-common workspaces build helpers/,
    );
    assert.equal(admitted, true);
  } finally {
    fixture.cleanup();
  }
});

test('retains the malformed cli-common package failure before admission', async () => {
  const fixture = createCliCommonFixture('happier-cli-common-workspaces-loader-malformed-');
  writeFileSync(
    resolve(fixture.packageDir, 'package.json'),
    '{"name":"@happier-dev/cli-common"',
    'utf8',
  );
  let admitted = false;

  try {
    await assert.rejects(
      loadCliCommonWorkspacesModule(
        fixture.repoRoot,
        {},
        async () => {
          admitted = true;
        },
      ),
      SyntaxError,
    );
    assert.equal(admitted, false);
  } finally {
    fixture.cleanup();
  }
});
