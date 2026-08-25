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

/**
 * The loader stages a content-addressed snapshot of the graph's inputs. Any input that read as
 * absent used to be skipped silently, so a transient absence during install churn produced a
 * snapshot that was *wrong but complete-looking*: self-consistent, cached under its own hash, and
 * failing later as `Cannot find module .../.project/tmp/cli-common-workspaces-loader.<id>/<hash>/...`
 * — a temp path nobody traces back to the skip. Observed live by Q1 with `bundledPluginResources.mjs`.
 *
 * The honest failure is available at the point of the skip, so it must be raised there.
 */
test('fails at staging, naming the helper, when the graph entry imports one it could not read', async () => {
  const fixture = createCliCommonFixture('happier-cli-common-workspaces-loader-unreadable-');
  const entryPath = resolve(fixture.packageDir, 'dist', 'workspaces', 'index.js');
  writeFileSync(
    entryPath,
    [
      "export { generation } from '../../workspaceRuntimeDependencies.mjs';",
      "export { resources } from '../../bundledPluginResources.mjs';",
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    resolve(fixture.packageDir, 'workspaceRuntimeDependencies.mjs'),
    'export const generation = 3;\n',
    'utf8',
  );
  // `bundledPluginResources.mjs` is deliberately absent: this is the transient read Q1 hit.

  try {
    await assert.rejects(
      loadCliCommonWorkspacesModule(fixture.repoRoot, {}, async () => {}),
      (error) => {
        const message = String(error?.message ?? '');
        assert.match(message, /bundledPluginResources\.mjs/);
        // Discriminating: today's deferred failure ALSO contains that filename, because it is
        // part of the staged temp path. The contract is that the loader refuses before staging.
        assert.doesNotMatch(message, /cli-common-workspaces-loader\./);
        assert.notEqual(error?.code, 'ERR_MODULE_NOT_FOUND');
        assert.match(message, /cli-common workspaces loader/i);
        return true;
      },
    );
    // Nothing may be left staged behind a refusal.
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

/**
 * The loader used to name its root-level helpers in two hard-coded constants. Keeping that list in
 * sync by hand is the same maintenance hazard that produced this defect family twice in one day
 * (cli-common's own `exports`, and this loader's input list). Requiredness is derivable from the
 * bytes actually being staged, so a helper the loader was never told about must still be staged.
 */
test('stages every root-level helper the graph entry imports, including ones it was never told about', async () => {
  const fixture = createCliCommonFixture('happier-cli-common-workspaces-loader-derived-');
  const entryPath = resolve(fixture.packageDir, 'dist', 'workspaces', 'index.js');
  writeFileSync(
    entryPath,
    "export { generation } from '../../futureRootHelper.mjs';\n",
    'utf8',
  );
  writeFileSync(
    resolve(fixture.packageDir, 'futureRootHelper.mjs'),
    'export const generation = 11;\n',
    'utf8',
  );

  try {
    const graph = await loadCliCommonWorkspacesModule(fixture.repoRoot, {}, async () => {});
    assert.equal(graph.generation, 11);
  } finally {
    fixture.cleanup();
  }
});
