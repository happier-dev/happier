// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { resolvePnpmCommandInvocation } from '../../../../scripts/workspaces/execPnpmCommand.mjs';
import { inspectDependencyRefresh, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import { readSourceRevisionDescriptor, resolveSourceRevision } from './source_revision.mjs';
import { captureSourceRuntimeSharedInputs } from './build_source_runtime.mjs';
import { prepareSourceRevisionBase, resolveSourceTreeRevision, setSourceRevisionTreeWritable } from './source_revision_tree.mjs';

// A pnpm workspace with a committed lockfile. Its only external dependency is a
// local directory, so real pnpm installs it with no registry.
async function createPnpmRevisionFixture(t, { prisma = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-install-', registerCleanup: false });
  t.after(async () => { await setSourceRevisionTreeWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  const pnpm = args => {
    const invocation = resolvePnpmCommandInvocation(args, { preferPath: true });
    const result = spawnSync(invocation.command, invocation.args, { cwd: repoDir, env, encoding: 'utf8',
      windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Object.assign(new Error(`pnpm ${args.join(' ')} failed`), { stderr: result.stderr });
  };
  const write = async (path, text) => {
    await mkdir(join(repoDir, path, '..'), { recursive: true });
    await writeFile(join(repoDir, path), text);
  };
  const rootPackage = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'));
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await write('package.json', JSON.stringify({ name: 'fixture-root', private: true, packageManager: rootPackage.packageManager }));
  await write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  await write('.gitignore', 'node_modules\ngenerated\n');
  for (const [dir, version, value] of [['vendor/dep-one', '1.0.0', 'committed'], ['vendor/dep-two', '2.0.0', 'uncommitted']]) {
    await write(`${dir}/package.json`, JSON.stringify({ name: 'fixture-dep', version, main: 'index.js' }));
    await write(`${dir}/index.js`, `module.exports = ${JSON.stringify(value)};`);
  }
  const serverManifest = (dep, prismaVersion = '6.0.0') => JSON.stringify({ name: '@happier-dev/server', version: '0.0.0', type: 'module',
    dependencies: { '@happier-dev/shared': 'workspace:*', 'fixture-dep': `file:../../vendor/${dep}`,
      ...(prisma ? { '@prisma/client': `file:../../vendor/prisma-${prismaVersion}` } : {}) },
    exports: { '.': { 'happier-source': './sources/main.light.ts' } } });
  if (prisma) {
    // Two Prisma releases; the server's generator records the one it ran with,
    // the process boundary a real `prisma generate` would cross.
    for (const version of ['6.0.0', '7.0.0']) {
      await write(`vendor/prisma-${version}/package.json`, JSON.stringify({ name: '@prisma/client', version, main: 'index.js' }));
      await write(`vendor/prisma-${version}/index.js`, 'module.exports = {};');
    }
    await write('apps/server/prisma/schema.prisma', 'datasource db { provider = "postgresql" }\n');
    await write('apps/server/scripts/generateClients.ts', [
      "import { createHash } from 'node:crypto'; import fs from 'node:fs'; import { createRequire } from 'node:module';",
      "const { version } = createRequire(`${process.cwd()}/package.json`)('@prisma/client/package.json');",
      "const stamp = createHash('sha256').update(fs.readFileSync('prisma/schema.prisma')).digest('hex');",
      "fs.mkdirSync('generated/default-client', { recursive: true });",
      "fs.writeFileSync('generated/default-client/.happier-source-schema.sha256', stamp);",
      "fs.writeFileSync('generated/default-client/prisma-version', version);",
    ].join('\n'));
  }
  await write('apps/server/package.json', serverManifest('dep-one'));
  await write('apps/server/sources/main.light.ts', 'export { marker } from "@happier-dev/shared";');
  // A workspace lifecycle script that loads an installed tool from its own real
  // location (as the CLI's unpack-tools postinstall does).
  await write('vendor/fixture-tool/package.json', JSON.stringify({ name: 'fixture-tool', version: '1.0.0', main: 'index.js' }));
  await write('vendor/fixture-tool/index.js', 'module.exports = "tool";');
  await write('apps/cli/package.json', JSON.stringify({ name: '@happier-dev/cli', version: '0.0.0', type: 'module',
    scripts: { postinstall: 'node scripts/unpack.cjs' }, dependencies: { 'fixture-tool': 'file:../../vendor/fixture-tool' } }));
  await write('apps/cli/scripts/unpack.cjs', "require('fixture-tool');");
  await write('packages/shared/package.json', JSON.stringify({ name: '@happier-dev/shared', version: '0.0.0', type: 'module',
    exports: { '.': { 'happier-source': './src/index.ts' } } }));
  await write('packages/shared/src/index.ts', 'export const marker = "committed";');
  // The UI's installed-output tool resolves its own real location (as the app's
  // postinstall does) and writes into the installed package it finds there.
  await write('vendor/rnem/package.json', JSON.stringify({ name: 'react-native-enriched-markdown', version: '0.5.0', main: 'index.js' }));
  await write('vendor/rnem/index.js', 'module.exports = {};');
  await write('apps/ui/package.json', JSON.stringify({ name: '@happier-dev/app', version: '0.0.0', private: true,
    scripts: { 'postinstall:real': 'node tools/postinstall.mjs' }, dependencies: { 'react-native-enriched-markdown': 'file:../../vendor/rnem' } }));
  await write('apps/ui/tools/postinstall.mjs', [
    "import fs from 'node:fs'; import path from 'node:path'; import url from 'node:url';",
    "const appDir = path.resolve(path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url))), '..');",
    "for (const dir of [path.join(appDir, 'node_modules'), path.join(appDir, '..', '..', 'node_modules')]) {",
    "  const pkg = path.join(dir, 'react-native-enriched-markdown');",
    "  if (fs.existsSync(pkg)) { fs.mkdirSync(path.join(pkg, 'lib/module/web'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'lib/module/web/streamingReveal.js'), 'export {};'); }",
    "}",
  ].join('\n'));
  pnpm(['install', '--offline', '--ignore-scripts']);
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'rev');
  return { fixture, repoDir, env, pnpm, write, serverManifest };
}

// The refresh owner's publication: the marker names the identity it installed.
async function publishCheckoutInstall({ repoDir, env }) {
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repoDir, env });
  await writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({ version: 7, identity: installIdentity }));
}

async function prepareHeadBase({ fixture, repoDir, env }, name) {
  const treesRoot = fixture.path('trees');
  const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [], outputDir: fixture.path(`descriptors-${name}`) });
  const descriptor = await readSourceRevisionDescriptor(revision.descriptorPath);
  return await prepareSourceRevisionBase({ repoDir, treesRoot, descriptor, env });
}

const loadFixtureDep = dir => createRequire(join(dir, 'apps/server/package.json'))('fixture-dep');

test('a base installs its revision\'s lockfile, never another lane\'s uncommitted dependency edit', async t => {
  const context = await createPnpmRevisionFixture(t);
  const { repoDir, env, pnpm, write, serverManifest } = context;
  // Another lane edits a dependency and installs it; nothing is committed.
  await write('apps/server/package.json', serverManifest('dep-two'));
  pnpm(['install', '--offline', '--ignore-scripts']);
  await publishCheckoutInstall({ repoDir, env });
  assert.equal(loadFixtureDep(repoDir), 'uncommitted');

  const { baseDir } = await prepareHeadBase(context, 'edited');
  assert.equal(loadFixtureDep(baseDir), 'committed');
  const rnem = await realpath(createRequire(join(baseDir, 'apps/ui/package.json')).resolve('react-native-enriched-markdown'));
  assert.equal(existsSync(join(dirname(rnem), 'lib/module/web/streamingReveal.js')), true,
    'the UI outputs are written into the installation the base mounts');
  // Workspace imports still resolve inside the base, not the moving checkout.
  assert.equal(await realpath(join(baseDir, 'apps/server/node_modules/@happier-dev/shared')), await realpath(join(baseDir, 'packages/shared')));
});

test('a base reuses the checkout installation when it is exactly the revision\'s dependency identity', async t => {
  const context = await createPnpmRevisionFixture(t);
  await publishCheckoutInstall(context);
  const { baseDir } = await prepareHeadBase(context, 'clean');
  assert.equal(loadFixtureDep(baseDir), 'committed');
  const checkoutDep = await realpath(join(context.repoDir, 'apps/server/node_modules/fixture-dep/index.js'));
  const baseDep = await realpath(join(baseDir, 'apps/server/node_modules/fixture-dep/index.js'));
  assert.equal((await lstat(baseDep)).ino, (await lstat(checkoutDep)).ino, 'the snapshot shares the checkout\'s installed bytes instead of installing again');
});

test('remote revision preparation never refreshes a dirty checkout manifest against its committed lockfile', async t => {
  const context = await createPnpmRevisionFixture(t);
  await publishCheckoutInstall(context);
  await context.write('apps/server/package.json', context.serverManifest('dep-two'));
  context.env.HAPPIER_DEV_TARGET_EXECUTION = '1';
  const { baseDir } = await prepareHeadBase(context, 'dirty-manifest');
  assert.equal(loadFixtureDep(baseDir), 'committed');
  assert.equal(loadFixtureDep(context.repoDir), 'committed', 'revision preparation leaves the live installation alone');
  assert.equal(JSON.parse(await readFile(join(baseDir, 'apps/server/package.json'), 'utf8')).dependencies['fixture-dep'],
    'file:../../vendor/dep-one');
});

test('a base generates its server clients with its own revision\'s Prisma, not the checkout\'s', async t => {
  const context = await createPnpmRevisionFixture(t, { prisma: true });
  const { repoDir, env, pnpm, write, serverManifest } = context;
  // The checkout moved to Prisma 7 (installed, uncommitted); the revision pins Prisma 6.
  await write('apps/server/package.json', serverManifest('dep-one', '7.0.0'));
  pnpm(['install', '--offline', '--ignore-scripts']);
  await publishCheckoutInstall({ repoDir, env });
  const { baseDir } = await prepareHeadBase(context, 'prisma');
  assert.equal(await readFile(join(baseDir, 'apps/server/generated/default-client/prisma-version'), 'utf8'), '6.0.0');
  assert.equal(createRequire(join(baseDir, 'apps/server/package.json'))('@prisma/client/package.json').version, '6.0.0');
});

test('a revision bundle capture generates with its revision\'s own installation and reuses the checkout\'s when identical', async t => {
  const context = await createPnpmRevisionFixture(t, { prisma: true });
  const { fixture, repoDir, env, pnpm, write, serverManifest } = context;
  const older = (await promisify(execFile)('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
  // HEAD moved to Prisma 7 and the checkout installed it; the older revision pins Prisma 6.
  await write('apps/server/package.json', serverManifest('dep-one', '7.0.0'));
  pnpm(['install', '--offline', '--ignore-scripts']);
  await promisify(execFile)('git', ['-C', repoDir, 'commit', '--quiet', '-am', 'prisma 7']);
  await publishCheckoutInstall({ repoDir, env });
  const treesRoot = fixture.path('trees');
  const capture = async (rev, name) => {
    const { descriptorPath } = await resolveSourceRevision({ repoDir, rev, outputDir: fixture.path(`descriptors-${name}`) });
    const outputDir = fixture.path(`capture-${name}`);
    await mkdir(outputDir);
    await captureSourceRuntimeSharedInputs({ repoDir, outputDir, env, treesRoot, revision: { descriptorPath } });
    return { outputDir, manifest: JSON.parse(await readFile(join(outputDir, '.source-runtime-shared-inputs.json'), 'utf8')) };
  };
  const old = await capture(older, 'older');
  assert.equal(await readFile(join(old.outputDir, 'apps/server/generated/default-client/prisma-version'), 'utf8'), '6.0.0');
  assert.equal(dirname(old.manifest.dependencyRootDir), join(treesRoot, 'installs'));
  assert.equal(createRequire(join(old.manifest.dependencyRootDir, 'apps/server/package.json'))('@prisma/client/package.json').version, '6.0.0');
  const head = await capture('HEAD', 'head');
  assert.equal(await readFile(join(head.outputDir, 'apps/server/generated/default-client/prisma-version'), 'utf8'), '7.0.0');
  assert.equal(head.manifest.dependencyRootDir, undefined, 'the checkout\'s installation serves a revision with its identity');
});
