import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { resolveNpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';
import { bundleWorkspacePackageWithRuntimeDependencies } from '../../../packages/cli-common/dist/workspaces/index.js';
import { publicSdkExampleDependencyVersions } from '../../../scripts/pipeline/npm/public-sdk-example-dependency-publication.mjs';

const packageRoot = resolve(import.meta.dirname, '..');

test('plugin-ui runtime build keeps public toolchain validation in check lanes', async () => {
  const pluginUi = JSON.parse(await readFile(resolve(packageRoot, '../plugin-ui/package.json'), 'utf8'));
  assert.equal(pluginUi.scripts.prebuild, undefined);
  assert.match(pluginUi.scripts['typecheck:local'], /check:public-toolchain/u);
  assert.match(pluginUi.scripts['api:finite'], /check:public-toolchain/u);
});

// Workspace source manifests pin internal workspace dependencies at this
// placeholder. Publication owns rewriting those bytes, so an example that
// keeps a placeholder no publication run can rewrite must never reach the
// published package selection.
const INTERNAL_PACKAGE_PREFIX = '@happier-dev/';
const WORKSPACE_SOURCE_DEPENDENCY_VERSION = '0.0.0';

// The probe version only reveals which dependency names the release owner can
// rewrite; the exact published version is a per-run value.
const PUBLICATION_REWRITABLE_EXAMPLE_DEPENDENCIES = new Set(
  Object.keys(publicSdkExampleDependencyVersions('0.0.0-package-inventory-probe')),
);

// Declarations belong to the package's `dist` output. Source-side declarations
// can silently mask a current source contract on resolvers that do not prefer
// `.ts`, so each exception must be explicitly justified here.
const SOURCE_DECLARATION_SIDECAR_ALLOWLIST = Object.freeze([]);

const PUBLIC_AUTHORING_COMPANION_FILES = [
  'README.md',
  'API.md',
  'api-declarations.md',
  'api-surface.json',
  'capability-matrix.json',
];

// The compact exported-name census (`API.md`) and the capability matrix are
// committed. The inventory and declaration report are generated on demand: Git ignores them and `prepack` materializes them into
// every published package.
const COMMITTED_AUTHORING_COMPANION_FILES = ['README.md', 'API.md', 'capability-matrix.json'];

const PACKAGE_SELECTED_GENERATED_RECORDS = Object.freeze([
  Object.freeze({
    packageRelativePath: 'packages/plugin-sdk',
    packageName: '@happier-dev/plugin-sdk',
    prepackMaterializers: Object.freeze([
      'node ./scripts/apiSurfaceCli.mjs --materialize-source --write',
      'node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --write',
    ]),
    committedRecords: Object.freeze(['API.md', 'capability-matrix.json']),
    records: Object.freeze([
      'api-declarations.md',
      'api-surface.json',
    ]),
  }),
  Object.freeze({
    packageRelativePath: 'packages/plugin-ui',
    packageName: '@happier-dev/plugin-ui',
    prepackMaterializers: Object.freeze([
      'node ../../scripts/api-governance/cli.mjs --profile plugin-ui --write',
    ]),
    committedRecords: Object.freeze(['API.md']),
    records: Object.freeze([
      'api-declarations.md',
      'api-surface.json',
    ]),
  }),
  Object.freeze({
    packageRelativePath: 'packages/sdk',
    packageName: '@happier-dev/sdk',
    prepackMaterializers: Object.freeze([
      'node ../../scripts/api-governance/cli.mjs --profile sdk --write',
    ]),
    committedRecords: Object.freeze(['API.md']),
    records: Object.freeze([
      'api-declarations.md',
      'api-surface.json',
    ]),
  }),
]);

function isExactPositivePackageFileEntry(entry) {
  return (
    typeof entry === 'string'
    && entry.length > 0
    && !entry.includes('\\')
    && !entry.startsWith('/')
    && !entry.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    && !/[*?{}[\]]/u.test(entry)
  );
}

function runsExactShellStep(command, expectedStep) {
  return typeof command === 'string'
    && command.split('&&').some((step) => step.trim() === expectedStep);
}

function referencedPackageScripts(command) {
  if (typeof command !== 'string') return [];
  return [
    ...command.matchAll(/--run-script=([a-z][a-z0-9:-]*)\b/gu),
    ...command.matchAll(/(?:^|&&)\s*pnpm\s+-s\s+([a-z][a-z0-9:-]*)\b/gu),
  ].map((match) => match[1]);
}

function reachablePackageScriptCommands(scripts, entrypoint) {
  const visited = new Set();
  const commands = [];

  const visit = (scriptName) => {
    if (visited.has(scriptName)) return;
    visited.add(scriptName);
    const command = scripts[scriptName];
    if (typeof command !== 'string') return;
    commands.push(Object.freeze({ scriptName, command }));
    for (const referencedScript of referencedPackageScripts(command)) {
      visit(referencedScript);
    }
  };

  visit(entrypoint);
  return commands;
}

function isGitTracked(repoRoot, relativePath) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

// `--no-index` evaluates the exclude rules even for a path still in the index.
function gitIgnoredPaths(repoRoot, relativePaths) {
  const result = spawnSync('git', ['check-ignore', '--no-index', ...relativePaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

async function collectPublicExampleFiles(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      entry.name === 'dist'
      || entry.name === 'node_modules'
      || entry.name === '.happier-daemon-outputs.json'
    ) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      entry.isFile()
      && entry.name === 'plugin.json'
      && (prefix === 'public-authoring/.happier-plugin' || prefix === 'session-agent/.happier-plugin')
    ) continue;
    if (entry.isDirectory()) {
      files.push(...await collectPublicExampleFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(`examples/${relativePath}`);
    }
  }
  return files;
}

async function readExampleUnrewritablePlaceholderDependencies(exampleDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(exampleDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const names = new Set();
  for (const field of ['dependencies', 'devDependencies']) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    assert.ok(
      entries && typeof entries === 'object' && !Array.isArray(entries),
      `example manifest ${field} must be an object when present: ${exampleDir}`,
    );
    for (const [dependencyName, dependencyVersion] of Object.entries(entries)) {
      if (!dependencyName.startsWith(INTERNAL_PACKAGE_PREFIX)) continue;
      if (dependencyVersion !== WORKSPACE_SOURCE_DEPENDENCY_VERSION) continue;
      if (PUBLICATION_REWRITABLE_EXAMPLE_DEPENDENCIES.has(dependencyName)) continue;
      names.add(dependencyName);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Joins every on-disk example manifest to the release owner's published
 * dependency rewrite map. An example whose internal placeholder dependency no
 * publication run can rewrite stays a repository example: publishing it would
 * hand the reader a manifest pinned at `0.0.0` that cannot resolve, which the
 * pack publication rewrite already refuses to produce.
 */
async function resolveExamplePublicationEligibility() {
  const exampleRoot = join(packageRoot, 'examples');
  const publishable = [];
  const unpublishable = [];
  for (const entry of await readdir(exampleRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const unrewritable = await readExampleUnrewritablePlaceholderDependencies(
      join(exampleRoot, entry.name),
    );
    if (unrewritable.length === 0) publishable.push(entry.name);
    else unpublishable.push({ name: entry.name, unrewritable });
  }
  return {
    publishable: publishable.sort((left, right) => left.localeCompare(right)),
    unpublishable: unpublishable.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function selectedExampleDirectoryNames(declaredFiles) {
  return [...new Set(
    declaredFiles
      .filter((entry) => entry.startsWith('examples/'))
      .map((entry) => entry.split('/'))
      .filter((segments) => segments.length > 2)
      .map((segments) => segments[1]),
  )].sort((left, right) => left.localeCompare(right));
}

test('public example inventory excludes daemon-owned build manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-public-example-inventory-'));
  try {
    await writeFixtureFile(root, 'public-authoring/index.ts', 'export {};\n');
    await writeFixtureFile(
      root,
      'public-authoring/.happier-plugin/.happier-daemon-outputs.json',
      '{}\n',
    );

    assert.deepEqual(await collectPublicExampleFiles(root), [
      'examples/public-authoring/index.ts',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function collectSourceDeclarationSidecars(root, prefix = 'src') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectSourceDeclarationSidecars(root, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
      files.push(relativePath);
    }
  }
  return files;
}

async function writeFixtureFile(root, relativePath, contents) {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

function packInventory(root) {
  const invocation = resolveNpmCommandInvocation([
    'pack',
    '--dry-run',
    '--ignore-scripts',
    '--json',
  ], {
    platform: process.platform,
    npmExecPath: process.env.npm_execpath,
    processExecPath: process.execPath,
    comspec: process.env.ComSpec ?? process.env.COMSPEC,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  return report[0].files.map((file) => file.path);
}

test('hosted-static examples pack their authored manifest and static inputs', async () => {
  const expectedByExample = new Map([
    ['automation-event-source', [
      '.happier-plugin/ui/hosted-web/repository-picker/entry.ts',
      '.happier-plugin/ui/hosted-web/repository-picker/index.html',
    ]],
    ['production-hosted-reference', [
      '.happier-plugin/plugin.json',
      '.happier-plugin/ui/hosted-web/review-hosted/entry.ts',
      '.happier-plugin/ui/hosted-web/review-hosted/index.html',
    ]],
    ['public-authoring', [
      '.happier-plugin/ui/hosted-web/review-openable-web/entry.ts',
      '.happier-plugin/ui/hosted-web/review-openable-web/index.html',
      '.happier-plugin/ui/hosted-web/review-web/entry.ts',
      '.happier-plugin/ui/hosted-web/review-web/index.html',
    ]],
  ]);

  for (const [exampleName, expectedFiles] of expectedByExample) {
    const examplePackageJson = JSON.parse(await readFile(
      join(packageRoot, 'examples', exampleName, 'package.json'),
      'utf8',
    ));
    for (const expectedFile of expectedFiles) {
      assert.ok(
        examplePackageJson.files.includes(expectedFile),
        `${exampleName} package inventory must declare ${expectedFile}`,
      );
    }
    const packedFiles = packInventory(join(packageRoot, 'examples', exampleName));
    for (const expectedFile of expectedFiles) {
      assert.ok(
        packedFiles.includes(expectedFile),
        `${exampleName} package must contain ${expectedFile}: ${packedFiles.join(', ')}`,
      );
    }
    assert.equal(
      packedFiles.includes('.happier-plugin/.happier-daemon-outputs.json'),
      false,
      `${exampleName} package must exclude daemon-owned output metadata`,
    );
  }
});

async function expectedPublishedExampleFiles(declaredFiles) {
  // The published package selection, every on-disk example manifest, and the
  // release owner's published dependency rewrite map must agree. A selected
  // example whose internal placeholder dependency this publication path cannot
  // rewrite would ship a manifest pinned at the workspace source placeholder,
  // which the pack publication rewrite already refuses to produce.
  const { publishable, unpublishable } = await resolveExamplePublicationEligibility();
  const unpublishableByName = new Map(
    unpublishable.map((example) => [example.name, example.unrewritable]),
  );
  assert.deepEqual(
    selectedExampleDirectoryNames(declaredFiles)
      .filter((name) => unpublishableByName.has(name))
      .map((name) => `${name}: ${unpublishableByName.get(name).join(', ')}`),
    [],
    'SDK package selection must not publish an example whose internal dependency has no published rewrite in scripts/pipeline/npm/public-sdk-example-dependency-publication.mjs',
  );

  const publishableExamples = new Set(publishable);
  return (await collectPublicExampleFiles(join(packageRoot, 'examples')))
    .filter((entry) => {
      const segments = entry.split('/');
      return segments.length <= 2 || publishableExamples.has(segments[1]);
    })
    .sort((left, right) => left.localeCompare(right));
}

test('SDK package selection declares the public authoring inventory as exact positive paths', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const declaredFiles = packageJson.files;
  assert.ok(Array.isArray(declaredFiles));
  assert.ok(
    declaredFiles.every(isExactPositivePackageFileEntry),
    `SDK package files must remain exact positive paths: ${JSON.stringify(declaredFiles)}`,
  );
  const expectedExampleFiles = await expectedPublishedExampleFiles(declaredFiles);
  assert.deepEqual(
    declaredFiles.filter((entry) => entry.startsWith('examples/')).sort((left, right) => left.localeCompare(right)),
    expectedExampleFiles,
  );
  for (const relativePath of PUBLIC_AUTHORING_COMPANION_FILES) {
    assert.ok(
      declaredFiles.includes(relativePath),
      `SDK package selection must declare the public authoring companion ${relativePath}`,
    );
  }

});

test('SDK package packs the public authoring inventory selected by its publication owner', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const expectedExampleFiles = await expectedPublishedExampleFiles(packageJson.files);
  const packedFiles = packInventory(packageRoot);
  const packedExampleFiles = packedFiles
    .filter((entry) => entry.startsWith('examples/'))
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(packedExampleFiles, expectedExampleFiles);
  // Generated API records are ignored and exist only after prepack writes
  // them, so this ignore-scripts pack of the checkout proves the committed
  // companions; the records' prepack materialization is asserted separately.
  for (const relativePath of COMMITTED_AUTHORING_COMPANION_FILES) {
    assert.ok(
      packedFiles.includes(relativePath),
      `SDK tarball must include the public authoring companion ${relativePath}`,
    );
  }
});

test('only the exported-name census is committed; generated API records are ignored and packed by prepack', async () => {
  const repoRoot = resolve(packageRoot, '../..');
  const insideWorkTree = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (insideWorkTree.status !== 0 || resolve(insideWorkTree.stdout.trim()) !== repoRoot) return;
  if (!isGitTracked(repoRoot, 'packages/plugin-sdk/package.json')) return;

  const committedPaths = PACKAGE_SELECTED_GENERATED_RECORDS.flatMap((packageRecord) => (
    packageRecord.committedRecords.map((record) => `${packageRecord.packageRelativePath}/${record}`)
  )).concat('packages/plugin-sdk/README.md');
  const generatedPaths = PACKAGE_SELECTED_GENERATED_RECORDS.flatMap((packageRecord) => (
    packageRecord.records.map((record) => `${packageRecord.packageRelativePath}/${record}`)
  )).sort();
  assert.deepEqual(
    gitIgnoredPaths(repoRoot, committedPaths),
    [],
    'the committed exported-name census must stay reviewable in version control',
  );
  assert.deepEqual(
    gitIgnoredPaths(repoRoot, generatedPaths),
    generatedPaths,
    'generated API records are produced on demand and must not be committed',
  );

  for (const packageRecord of PACKAGE_SELECTED_GENERATED_RECORDS) {
    const packageJson = JSON.parse(await readFile(
      join(repoRoot, packageRecord.packageRelativePath, 'package.json'),
      'utf8',
    ));
    assert.equal(packageJson.name, packageRecord.packageName);
    const published = [...packageRecord.committedRecords, ...packageRecord.records];
    assert.deepEqual(
      published.filter((record) => packageJson.files.includes(record)),
      published,
      `${packageRecord.packageName} must package every public API record`,
    );

    // `prepack` is the package's clean-checkout materialization contract: an
    // ignored record reaches the tarball only because prepack writes it. It
    // may enter the shared lock-owning wrapper before it delegates to a
    // prepared script, so inspect that canonical script graph rather than
    // duplicating writers on the root command. Do not execute it here.
    const prepackGraph = reachablePackageScriptCommands(packageJson.scripts, 'prepack');
    for (const materializer of packageRecord.prepackMaterializers) {
      assert.ok(
        prepackGraph.some(({ command }) => runsExactShellStep(command, materializer)),
        `${packageRecord.packageName} prepack must run ${materializer} to materialize its generated records`,
      );
    }
  }
});

test('SDK package boundary permits only explicitly allowlisted source declaration sidecars', async () => {
  const tsconfig = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'));
  assert.equal(tsconfig.compilerOptions?.outDir, 'dist');

  const unexpectedSidecars = (await collectSourceDeclarationSidecars(packageRoot))
    .filter((relativePath) => !SOURCE_DECLARATION_SIDECAR_ALLOWLIST.includes(relativePath))
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(
    unexpectedSidecars,
    [],
    `source declaration sidecars must remain absent unless explicitly allowlisted: ${unexpectedSidecars.join(', ')}`,
  );
});

test('canonical workspace bundler copies exactly the declared public SDK examples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-workspace-bundle-'));
  try {
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const bundledPackageRoot = join(root, 'plugin-sdk');
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName: packageJson.name,
      srcDir: packageRoot,
      destDir: bundledPackageRoot,
      resolveFromPackageJsonPath: join(packageRoot, 'package.json'),
      dereferenceRootDir: resolve(packageRoot, '../..'),
      pruneStale: true,
    });

    const expectedExampleFiles = packageJson.files
      .filter((entry) => entry.startsWith('examples/'))
      .sort((left, right) => left.localeCompare(right));
    const bundledExampleFiles = (await collectPublicExampleFiles(join(bundledPackageRoot, 'examples')))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(bundledExampleFiles, expectedExampleFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selected SDK tarball inventory excludes an ordinary nested example dist sentinel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-package-inventory-'));
  try {
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    await writeFixtureFile(root, 'package.json', `${JSON.stringify({
      name: 'plugin-sdk-package-inventory-fixture',
      version: '0.0.0',
      files: packageJson.files,
    }, null, 2)}\n`);

    await writeFixtureFile(
      root,
      'examples/package-inventory-sentinel/dist/stale-ui-bundle.js',
      'export const stale = true;\n',
    );

    const files = packInventory(root);
    assert.equal(
      files.includes('examples/package-inventory-sentinel/dist/stale-ui-bundle.js'),
      false,
      `ordinary example build output leaked into the selected tarball: ${files.join(', ')}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
