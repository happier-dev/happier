// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { resolvePnpmCommandInvocation } from '../../../../scripts/workspaces/execPnpmCommand.mjs';
import { inspectDependencyRefresh, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import { readSourceRevisionDescriptor, resolveSourceRevision } from './source_revision.mjs';
import { captureSourceRuntimeSharedInputs, captureSourceWebBuildInputs } from './build_source_runtime.mjs';
import { prepareSourceRuntimeReload } from '../runtime/launch/prepareSourceRuntimeReload.mjs';
import { prepareSourceRevisionBase, resolveSourceTreeRevision, setSourceRevisionTreeWritable, writeSourceRevisionArchive } from './source_revision_tree.mjs';

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
  // A pre-612af8e5162 revision installs hoisted, with Prisma's client at the root.
  await write('pnpm-workspace.yaml', `packages:\n  - apps/*\n  - packages/*\n${prisma === 'legacy' ? 'nodeLinker: hoisted\n' : ''}`);
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
    const preamble = [
      "import { createHash } from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';",
      "const packageJson = createRequire(`${process.cwd()}/package.json`).resolve('@prisma/client/package.json');",
      "const { version } = JSON.parse(fs.readFileSync(packageJson, 'utf8'));",
      "const stamp = createHash('sha256').update(fs.readFileSync('prisma/schema.prisma')).digest('hex');",
    ];
    await write('apps/server/scripts/generateClients.ts', [...preamble, ...(prisma === 'legacy' ? [
      // Before the layout owner: Prisma writes beside the real @prisma/client, and the
      // script stamps the root client it assumes (2c8b5a872a's generateClients.ts).
      "const client = path.join(path.dirname(fs.realpathSync(packageJson)), '..', '..', '.prisma', 'client');",
      "fs.mkdirSync(client, { recursive: true }); fs.writeFileSync(path.join(client, 'prisma-version'), version);",
      "fs.writeFileSync('../../node_modules/.prisma/client/.happier-source-schema.sha256', stamp);",
    ] : [
      "fs.mkdirSync('generated/default-client', { recursive: true });",
      "fs.writeFileSync('generated/default-client/.happier-source-schema.sha256', stamp);",
      "fs.writeFileSync('generated/default-client/prisma-version', version);",
    ])].join('\n'));
    // The current layout owner places the default client itself (612af8e5162 and later).
    if (prisma !== 'legacy') await write('apps/server/scripts/prismaInstallLayout.mjs', 'export {};');
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
  // The base is exactly its pinned installation: the refresh owner admits it, so no
  // dependency refresh runs a package manager inside the base or its clones.
  const readiness = await inspectDependencyRefresh({ installDir: baseDir, env });
  assert.equal(readiness.required, false, 'a revision base never needs a dependency refresh');
  assert.equal(readiness.installedIdentity, readiness.installIdentity);
  const rnem = await realpath(createRequire(join(baseDir, 'apps/ui/package.json')).resolve('react-native-enriched-markdown'));
  assert.equal(existsSync(join(dirname(rnem), 'lib/module/web/streamingReveal.js')), true,
    'the UI outputs are written into the installation the base mounts');
  // Workspace imports still resolve inside the base, not the moving checkout.
  assert.equal(await realpath(join(baseDir, 'apps/server/node_modules/@happier-dev/shared')), await realpath(join(baseDir, 'packages/shared')));
});

test('a base reuses the checkout installation when it is exactly the revision\'s dependency identity', async t => {
  const context = await createPnpmRevisionFixture(t);
  await publishCheckoutInstall(context);
  const lockfile = 'pnpm-lock.yaml';
  await context.write(lockfile, (await readFile(join(context.repoDir, lockfile), 'utf8')) + '\n# another lane\n');
  const { baseDir } = await prepareHeadBase(context, 'dirty-lockfile');
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
    const serverCapture = await captureSourceWebBuildInputs({ repoDir, component: 'server',
      outputDir: fixture.path(`server-${name}`), sharedSourceInputs: { repoDir: outputDir } });
    return { outputDir, serverCapture,
      manifest: JSON.parse(await readFile(join(outputDir, '.source-runtime-shared-inputs.json'), 'utf8')) };
  };
  const old = await capture(older, 'older');
  assert.equal(await readFile(join(old.outputDir, 'apps/server/generated/default-client/prisma-version'), 'utf8'), '6.0.0');
  assert.equal(dirname(old.manifest.dependencyRootDir), join(treesRoot, 'installs'));
  assert.equal(createRequire(join(old.manifest.dependencyRootDir, 'apps/server/package.json'))('@prisma/client/package.json').version, '6.0.0');
  const client = 'apps/server/generated/default-client/prisma-version';
  assert.equal(await readFile(join(old.serverCapture.repoDir, client), 'utf8'), '6.0.0',
    'the server component carries the generated default client even when it had no checkout copy');
  assert.ok(old.serverCapture.files.includes(client), 'the bundle emitter receives the default client');
  const head = await capture('HEAD', 'head');
  assert.equal(await readFile(join(head.outputDir, 'apps/server/generated/default-client/prisma-version'), 'utf8'), '7.0.0');
  assert.equal(head.manifest.dependencyRootDir, undefined, 'the checkout\'s installation serves a revision with its identity');
});

test('a mirror captures runtime and web inputs with the revision installation obtained from the controller', async t => {
  const context = await createPnpmRevisionFixture(t);
  const { fixture, repoDir, env, pnpm, write, serverManifest } = context;
  const { descriptorPath } = await resolveSourceRevision({ repoDir, rev: 'HEAD', outputDir: fixture.path('descriptor') });
  const descriptor = await readSourceRevisionDescriptor(descriptorPath);
  const archivePath = fixture.path('revision.tar.gz');
  await writeSourceRevisionArchive({ repoDir, revision: descriptor.revision, outputPath: archivePath });
  await write('apps/server/package.json', serverManifest('dep-two'));
  pnpm(['install', '--offline', '--ignore-scripts']);
  await publishCheckoutInstall(context);
  await rm(join(repoDir, '.git'), { recursive: true });
  let requests = 0;
  const requestBaseArchive = async ({ revision, path }) => {
    assert.equal(revision, descriptor.revision);
    requests++;
    await cp(archivePath, path);
  };
  const treesRoot = fixture.path('mirror-trees');
  const outputDir = fixture.path('shared');
  await mkdir(outputDir);
  await captureSourceRuntimeSharedInputs({ repoDir, outputDir, env, treesRoot,
    revision: { descriptorPath }, requestBaseArchive });
  const shared = JSON.parse(await readFile(join(outputDir, '.source-runtime-shared-inputs.json'), 'utf8'));
  assert.equal(loadFixtureDep(shared.dependencyRootDir), 'committed');
  const web = await captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('web'), env,
    treesRoot, revision: { descriptorPath }, requestBaseArchive });
  assert.equal(loadFixtureDep(web.dependencyRootDir), 'committed');
  assert.equal(createRequire(join(web.uiProjectDir, 'package.json'))('react-native-enriched-markdown/package.json').version, '0.5.0');
  assert.equal(requests, 1, 'the web capture reuses the installation obtained by runtime capture');
  assert.equal(loadFixtureDep(repoDir), 'uncommitted');
});

for (const ui of ['--no-ui', '--ui=export']) {
  test(`a mirror reload ${ui} resolves one installation before admission and shares it with runtime and web capture`, async t => {
    const context = await createPnpmRevisionFixture(t);
    const { fixture, repoDir, write, serverManifest, pnpm } = context;
    const env = { ...context.env, HAPPIER_STACK_SOURCE_MIRROR: '1', HAPPIER_STACK_STACK: 'qa',
      HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer',
      HAPPIER_STACK_SOURCE_TREES: '0', HAPPIER_STACK_DAEMON: '0' };
    await write('apps/stack/scripts/stack.mjs', 'export {};');
    const { descriptorPath } = await resolveSourceRevision({ repoDir, rev: 'HEAD', outputDir: fixture.path('descriptor') });
    // Reload owns its transferred descriptor's cleanup. The stopped worker
    // below uses the same bytes after that cleanup, across its simulated queue.
    const captureRevision = { descriptorPath: fixture.path('worker-descriptor.json.gz') };
    await cp(descriptorPath, captureRevision.descriptorPath);
    const descriptor = await readSourceRevisionDescriptor(descriptorPath);
    const archivePath = fixture.path('revision.tar.gz');
    await writeSourceRevisionArchive({ repoDir, revision: descriptor.revision, outputPath: archivePath });
    await publishCheckoutInstall({ repoDir, env });
    await rm(join(repoDir, '.git'), { recursive: true });
    let requests = 0;
    let admitted;
    // Replace only the OS admission launch. Keep revision selection, controller
    // acquisition, installation and both captures real, across the queued interval.
    for (const method of ['spawn', 'fork']) {
      const original = childProcess[method];
      t.mock.method(childProcess, method, (command, args, ...rest) => {
        if (args?.some(arg => String(arg).includes('workspace_build_admission.mjs'))) {
          const values = args.map(arg => { try { return JSON.parse(arg); } catch { return null; } });
          admitted = [...values, ...values.flatMap(value => (value?.args ?? []).map(arg => {
            try { return JSON.parse(arg); } catch { return null; }
          }))].find(value => value?.producerComponents);
          throw Object.assign(new Error('admission boundary reached'), { code: 'EADMISSIONPROBE' });
        }
        return original(command, args, ...rest);
      });
    }
    syncBuiltinESMExports();
    try {
      await assert.rejects(prepareSourceRuntimeReload({ repoDir, stackBaseDir: fixture.path('stacks/qa'),
        stackName: 'qa', onHost: true, args: [ui, '--no-daemon', `--source-revision=${descriptorPath}`], env,
        requestBaseArchive: async ({ revision, path }) => {
          assert.equal(revision, descriptor.revision);
          requests++;
          await cp(archivePath, path);
        } }), /admission boundary reached/);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.ok(admitted, 'the producer reached its finite worker');
    // The shared checkout changes while that worker is queued on host admission.
    await write('apps/server/package.json', serverManifest('dep-two'));
    pnpm(['install', '--offline', '--ignore-scripts']);
    await publishCheckoutInstall({ repoDir, env });
    const outputDir = fixture.path('queued-shared');
    await mkdir(outputDir);
    await captureSourceRuntimeSharedInputs({ repoDir, outputDir, env, revision: captureRevision,
      treesRoot: join(fixture.path('stacks'), 'source-revision-trees'),
      revisionArchivePath: admitted.revisionArchivePath, dependencyRootDir: admitted.dependencyRootDir });
    const shared = JSON.parse(await readFile(join(outputDir, '.source-runtime-shared-inputs.json'), 'utf8'));
    assert.equal(loadFixtureDep(shared.dependencyRootDir), 'committed');
    const web = await captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('queued-web'), env,
      revision: captureRevision, treesRoot: join(fixture.path('stacks'), 'source-revision-trees') });
    assert.equal(web.dependencyRootDir, shared.dependencyRootDir);
    assert.equal(loadFixtureDep(web.dependencyRootDir), 'committed');
    assert.equal(requests, 1, 'one controller archive serves both phases despite checkout installation drift');
  });
}

test('an older revision bundle generates its root-layout Prisma client inside the capture, never in its installation', async t => {
  // Before 612af8e5162 the server had no layout owner: Prisma placed the default client
  // beside the hoisted @prisma/client, and the generator stamped that root client.
  const context = await createPnpmRevisionFixture(t, { prisma: 'legacy' });
  const { fixture, repoDir, env, pnpm, write, serverManifest } = context;
  const older = (await promisify(execFile)('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
  await write('apps/server/package.json', serverManifest('dep-one', '7.0.0'));
  pnpm(['install', '--offline', '--ignore-scripts']);
  await promisify(execFile)('git', ['-C', repoDir, 'commit', '--quiet', '-am', 'prisma 7']);
  await publishCheckoutInstall({ repoDir, env });
  const treesRoot = fixture.path('trees');
  const { descriptorPath } = await resolveSourceRevision({ repoDir, rev: older, outputDir: fixture.path('descriptors') });
  const outputDir = fixture.path('capture');
  await mkdir(outputDir);
  await captureSourceRuntimeSharedInputs({ repoDir, outputDir, env, treesRoot, revision: { descriptorPath } });
  const manifest = JSON.parse(await readFile(join(outputDir, '.source-runtime-shared-inputs.json'), 'utf8'));
  assert.equal(await readFile(join(outputDir, 'node_modules/.prisma/client/prisma-version'), 'utf8'), '6.0.0');
  assert.equal(existsSync(join(manifest.dependencyRootDir, 'node_modules/.prisma')), false, 'generation never writes the shared installation');
  for (const path of ['node_modules/.prisma/client/prisma-version', 'node_modules/.prisma/client/.happier-source-schema.sha256',
    'node_modules/@prisma/client/package.json']) {
    assert.ok(manifest.filesByComponent.server.includes(path), `the server capture carries ${path}`);
  }
});
