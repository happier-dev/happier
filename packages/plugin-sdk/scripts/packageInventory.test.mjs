import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { resolveNpmCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { bundleWorkspacePackageWithRuntimeDependencies } from '../../../packages/cli-common/dist/workspaces/index.js';

const packageRoot = resolve(import.meta.dirname, '..');

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

const PACKAGE_SELECTED_GENERATED_RECORDS = Object.freeze([
  Object.freeze({
    packageRelativePath: 'packages/plugin-sdk',
    packageName: '@happier-dev/plugin-sdk',
    prepackMaterializers: Object.freeze([
      'node ./scripts/apiSurfaceCli.mjs --materialize-source --write',
      'node ../../scripts/api-governance/cli.mjs --profile plugin-sdk --write',
    ]),
    records: Object.freeze([
      'API.md',
      'api-declarations.md',
      'api-surface.json',
      'capability-matrix.json',
    ]),
  }),
  Object.freeze({
    packageRelativePath: 'packages/plugin-ui',
    packageName: '@happier-dev/plugin-ui',
    prepackMaterializers: Object.freeze([
      'node ../../scripts/api-governance/cli.mjs --profile plugin-ui --write',
    ]),
    records: Object.freeze([
      'API.md',
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
    ...command.matchAll(/(?:^|&&)\s*yarn\s+-s\s+([a-z][a-z0-9:-]*)\b/gu),
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

async function collectPublicExampleFiles(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectPublicExampleFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(`examples/${relativePath}`);
    }
  }
  return files;
}

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

test('SDK package selection declares and packs the public authoring inventory as exact positive paths', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const declaredFiles = packageJson.files;
  assert.ok(Array.isArray(declaredFiles));
  assert.ok(
    declaredFiles.every(isExactPositivePackageFileEntry),
    `SDK package files must remain exact positive paths: ${JSON.stringify(declaredFiles)}`,
  );

  const expectedExampleFiles = (await collectPublicExampleFiles(join(packageRoot, 'examples')))
    .sort((left, right) => left.localeCompare(right));
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

  const packedFiles = packInventory(packageRoot);
  const packedExampleFiles = packedFiles
    .filter((entry) => entry.startsWith('examples/'))
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(packedExampleFiles, expectedExampleFiles);
  for (const relativePath of PUBLIC_AUTHORING_COMPANION_FILES) {
    assert.ok(
      packedFiles.includes(relativePath),
      `SDK tarball must include the public authoring companion ${relativePath}`,
    );
  }
});

test('the public contract records stay reviewable in version control', () => {
  const repoRoot = resolve(packageRoot, '../..');
  const insideWorkTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (insideWorkTree.status !== 0) return;

  // A record that Git ignores produces no diff when a symbol or a signature
  // enters or leaves the published API, which is exactly the review gap these
  // records exist to close. `check-ignore` exits 0 only for an ignored path.
  const recordPaths = PUBLIC_AUTHORING_COMPANION_FILES
    .map((relativePath) => `packages/plugin-sdk/${relativePath}`)
    .concat(
      PACKAGE_SELECTED_GENERATED_RECORDS
        .filter((packageRecord) => packageRecord.packageRelativePath === 'packages/plugin-ui')
        .flatMap((packageRecord) => packageRecord.records)
        .map((relativePath) => `packages/plugin-ui/${relativePath}`),
    );
  const ignored = spawnSync('git', ['check-ignore', ...recordPaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    ignored.stdout.trim(),
    '',
    `public contract records must not be excluded from version control: ${ignored.stdout.trim()}`,
  );
});

test('package-selected generated records stay reviewable and use canonical prepack materializers', async () => {
  const repoRoot = resolve(packageRoot, '../..');
  const insideWorkTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (insideWorkTree.status !== 0) return;

  const untrackedReviewBaselineRecords = [];
  for (const packageRecord of PACKAGE_SELECTED_GENERATED_RECORDS) {
    const packageJson = JSON.parse(await readFile(
      join(repoRoot, packageRecord.packageRelativePath, 'package.json'),
      'utf8',
    ));
    assert.equal(packageJson.name, packageRecord.packageName);
    assert.deepEqual(
      packageRecord.records.filter((record) => packageJson.files.includes(record)),
      packageRecord.records,
      `${packageRecord.packageName} must package every generated public record`,
    );

    const untracked = packageRecord.records.filter((record) => !isGitTracked(
      repoRoot,
      `${packageRecord.packageRelativePath}/${record}`,
    ));
    untrackedReviewBaselineRecords.push(
      ...untracked.map((record) => `${packageRecord.packageRelativePath}/${record}`),
    );

    // `prepack` is the package's clean-checkout materialization contract. It
    // may enter the shared lock-owning wrapper before it delegates to a
    // prepared script, so inspect that canonical script graph rather than
    // duplicating writers on the root command. Do not execute it here: the
    // SDK's real prepack owns the shared artifact bundler. The writer
    // implementations have their own owner-level tests; this test makes every
    // package-selected record depend on that one path.
    const prepackGraph = reachablePackageScriptCommands(packageJson.scripts, 'prepack');
    for (const materializer of packageRecord.prepackMaterializers) {
      assert.ok(
        prepackGraph.some(({ command }) => runsExactShellStep(command, materializer)),
        `${packageRecord.packageName} must run ${materializer} for selected generated records (${untracked.length === 0 ? 'tracked' : `untracked: ${untracked.join(', ')}`})`,
      );
    }
  }

  assert.deepEqual(
    untrackedReviewBaselineRecords,
    [],
    `package-selected generated records must be Git-tracked review baselines: ${untrackedReviewBaselineRecords.join(', ')}`,
  );
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

    const expectedExampleFiles = (await collectPublicExampleFiles(join(packageRoot, 'examples')))
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
