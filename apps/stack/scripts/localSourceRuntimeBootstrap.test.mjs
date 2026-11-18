// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork, spawnSync } from 'node:child_process';

const sourceBootstrapRepoDir = fileURLToPath(new URL('../../../', import.meta.url));
const sourceRuntimePreload = new URL('../bin/localSourceRuntimeBootstrap.mjs', import.meta.url).href;

function observeColdSourcePreload(entry) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks, isBuiltin } from 'node:module';
    import { resolve } from 'node:path';
    const externalRequests = [];
    // Module resolution is the external boundary: model a cold installation
    // without removing or changing this worker's installed dependencies.
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (!isBuiltin(specifier) && !specifier.startsWith('.')
          && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
        externalRequests.push(specifier);
        throw Object.assign(new Error('Fixture package is not installed'), { code: 'ERR_MODULE_NOT_FOUND' });
      }
      return nextResolve(specifier, context);
    } });
    process.argv[1] = resolve(${JSON.stringify(sourceBootstrapRepoDir)}, ${JSON.stringify(entry)});
    let failure = null;
    try { await import(${JSON.stringify(sourceRuntimePreload)}); }
    catch (error) { failure = error.code ?? String(error); }
    console.log(JSON.stringify({ failure, externalRequests }));
  `], {
    cwd: sourceBootstrapRepoDir,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('dependency preparation starts without loading packages it must install', () => {
  assert.deepEqual(observeColdSourcePreload('apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs'), {
    failure: null,
    externalRequests: [],
  });
});

test('ordinary source tools retain source runtime registration', () => {
  const result = observeColdSourcePreload('apps/stack/scripts/utils/dev_targets/qa_browser.mjs');
  assert.equal(result.failure, 'ERR_MODULE_NOT_FOUND');
  assert.deepEqual(result.externalRequests, ['tsx']);
});

test('OS custody runs without loading source tooling or installed dependencies', async t => {
  if (process.platform === 'win32') return t.skip('POSIX foreground group custody');
  const root = await mkdtemp(join(tmpdir(), 'happier-os-custody-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  // Copy the real OS-only closure. There is deliberately no installed tree:
  // listener and process observations must remain usable during dependency refresh.
  for (const relative of ['apps/stack/bin/localSourceRuntimeBootstrap.mjs',
    'apps/stack/scripts/utils',
    'packages/cli-common']) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await cp(join(repo, relative), join(root, relative), { recursive: true,
      filter: source => !source.includes('/node_modules') && !source.includes('/dist') });
  }
  const entry = join(root, 'apps/stack/scripts/utils/proc/proc.mjs');
  const preload = join(root, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs');
  const invocation = { command: process.execPath, args: ['-e', 'process.stdout.write("OS_PROBE_OK")'],
    spawnOptions: { env: { ...process.env, NODE_OPTIONS: '' } } };
  const child = fork(entry, ['--happier-foreground-custody', JSON.stringify(invocation)], {
    detached: true, execArgv: [], env: { ...process.env, NODE_OPTIONS: '--import=' + pathToFileURL(preload).href },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'OS_PROBE_OK');
});

// mac-host ran Node 22.22.1 on 2026-11-17: its synchronous load chain rejects a
// CommonJS step without source, so the pin must not use synchronous load hooks
// there (releases checked against the real Node binaries, P03-TOOLING-4).
test('the tooling pin uses synchronous load hooks only on Node releases whose loader carries CommonJS', async () => {
  const { synchronousLoadHooksSupported } = await import('../bin/localToolingPackagePin.mjs');
  for (const version of ['20.19.0', '22.22.1', '22.22.2', '23.11.0', '24.11.0', '25.0.0']) {
    assert.equal(synchronousLoadHooksSupported(version), false, version);
  }
  for (const version of ['22.22.3', '22.23.5', '24.11.1', '24.21.0', '25.1.0', '26.0.0']) {
    assert.equal(synchronousLoadHooksSupported(version), true, version);
  }
});

// P03-TOOLING-ISOLATION: tooling runs live from the shared checkout, but a
// half-landed product package edit (an import of a missing export, a deleted
// file still imported at HEAD) must not break every stack start and reload.
test('checkout tooling loads product packages at the committed revision, on the controller and on a Git-less mirror', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tooling-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const controller = join(root, 'controller');
  for (const relative of ['apps/stack/bin', 'apps/stack/scripts/utils']) {
    await cp(join(repo, relative), join(controller, relative), { recursive: true, filter: source => !source.includes('/node_modules') });
  }
  // The source runtime's own registration leaf (root modules only; package sources are not needed).
  await cp(join(repo, 'packages/cli-common'), join(controller, 'packages/cli-common'), { recursive: true,
    filter: source => source === join(repo, 'packages/cli-common') || /\.(?:mjs|cjs|json)$/u.test(source) && dirname(source) === join(repo, 'packages/cli-common') });
  const write = async (relative, contents) => {
    await mkdir(dirname(join(controller, relative)), { recursive: true });
    await writeFile(join(controller, relative), contents);
  };
  await write('packages/protocol/package.json', JSON.stringify({ name: '@happier-dev/protocol', type: 'module',
    exports: { './*': { 'happier-source': './src/*.ts' } } }));
  await write('packages/protocol/src/scm.ts', 'export const ScmRefusal: string = "committed";\n');
  await write('packages/protocol/src/helper.ts', 'export const helper = (value: string): string => `${value}+helper`;\n');
  await write('packages/protocol/src/actions.ts', 'import { ScmRefusal } from "./scm.js";\nimport { helper } from "./helper.js";\nexport const value = helper(ScmRefusal);\n');
  // A CommonJS import too: Node 22.22.1's synchronous load chain refused every one.
  await write('packages/protocol/legacy.cjs', 'module.exports = { suffix: "" };\n');
  await write('apps/stack/scripts/probe.mjs', 'const { value } = await import("@happier-dev/protocol/actions");\nconst { suffix } = (await import("../../../packages/protocol/legacy.cjs")).default;\nprocess.stdout.write(value + suffix);\n');
  const git = args => {
    const result = spawnSync('git', ['-C', controller, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  await symlink(join(repo, 'node_modules'), join(controller, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Another lane's half-landed edit: the import lands before its export, and a helper moved away.
  await write('packages/protocol/src/actions.ts', 'import { ScmMissingRefusal } from "./scm.js";\nexport const value = ScmMissingRefusal;\n');
  await rm(join(controller, 'packages/protocol/src/helper.ts'));
  const probe = (checkout, env = {}, preload = 'apps/stack/bin/localSourceRuntimeBootstrap.mjs') => spawnSync(process.execPath, ['--conditions=happier-source',
    `--import=${pathToFileURL(join(checkout, preload)).href}`,
    join(checkout, 'apps/stack/scripts/probe.mjs')], { cwd: checkout, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_TOOLING_PACKAGES: '', ...env } });
  const pinned = probe(controller);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, 'committed+helper');
  // The opt-out (and the old behavior) loads the half-landed checkout bytes.
  const live = probe(controller, { HAPPIER_STACK_TOOLING_PACKAGES: 'live' });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /ScmMissingRefusal/u);
  // A mid-edit syntax error must be replaced before the TypeScript transformer
  // sees it, including children that already preload the source runtime.
  await write('packages/cli-common/fileChangeObserver.mjs', 'export const incomplete = ;\n');
  await write('packages/protocol/src/scm.ts', 'export const ScmRefusal: string = ;\n');
  const syntax = probe(controller);
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(syntax.stdout, 'committed+helper');
  const inherited = probe(controller, { NODE_OPTIONS: `--import=${pathToFileURL(join(controller, 'packages/cli-common/registerSourceRuntime.mjs')).href}` });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.equal(inherited.stdout, 'committed+helper');
  const direct = probe(controller, {}, 'packages/cli-common/registerSourceRuntime.mjs');
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout, 'committed+helper');
  await write('apps/cli/probe.mjs', 'const { value } = await import("@happier-dev/protocol/actions"); process.stdout.write(value);');
  const product = spawnSync(process.execPath, ['--conditions=happier-source',
    `--import=${pathToFileURL(join(controller, 'packages/cli-common/registerSourceRuntime.mjs')).href}`,
    join(controller, 'apps/cli/probe.mjs')], { cwd: controller, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_TOOLING_PACKAGES: '' } });
  assert.notEqual(product.status, 0, 'product children retain live source instead of the tooling pin');
  // An execution host's mirror has no Git: it reads the synchronized pin the controller wrote.
  const mirror = join(root, 'mirror');
  await cp(controller, mirror, { recursive: true, verbatimSymlinks: true, filter: source => source !== join(controller, '.git') });
  const fromMirror = probe(mirror);
  assert.equal(fromMirror.status, 0, fromMirror.stderr);
  assert.equal(fromMirror.stdout, 'committed+helper');
  const directMirror = probe(mirror, { HAPPIER_STACK_SOURCE_MIRROR: '1' }, 'packages/cli-common/registerSourceRuntime.mjs');
  assert.equal(directMirror.status, 0, directMirror.stderr);
  assert.equal(directMirror.stdout, 'committed+helper');
  // An edit after the controller's last load: the sync flush barrier refreshes
  // the pin before every remote dispatch, so the mirror still gets HEAD's bytes.
  await write('packages/protocol/src/scm.ts', 'export const ScmRefusal: string = (() => { throw new Error("half-landed"); })();\n');
  const refresh = spawnSync(process.execPath, [join(controller, 'apps/stack/bin/localToolingPackagePin.mjs'), '--refresh', controller],
    { cwd: controller, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(refresh.status, 0, refresh.stderr);
  const flushed = join(root, 'mirror-after-flush');
  await cp(controller, flushed, { recursive: true, verbatimSymlinks: true, filter: source => source !== join(controller, '.git') });
  const afterFlush = probe(flushed);
  assert.equal(afterFlush.status, 0, afterFlush.stderr);
  assert.equal(afterFlush.stdout, 'committed+helper');
  // Mirror churn (P03-INFRA-SWEEP 2026-11-17): a 1.9 MB manifest.json rewritten
  // at every HEAD move was the most frequent Mutagen transition problem behind
  // worker dispatch refusals. A revision's manifest is written once; only a
  // small pointer moves with HEAD, and an unchanged HEAD rewrites nothing.
  const pinDir = join(controller, '.happier-tooling-pin');
  const pinFiles = async () => Object.fromEntries((await Promise.all((await readdir(pinDir, { recursive: true }))
    .map(async path => [path, await stat(join(pinDir, path))]))).filter(([, info]) => info.isFile()).map(([path, info]) => [path, info.mtimeMs]));
  const refreshPin = () => {
    const result = spawnSync(process.execPath, [join(controller, 'apps/stack/bin/localToolingPackagePin.mjs'), '--refresh', controller],
      { cwd: controller, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(result.status, 0, result.stderr);
  };
  const beforeMove = await pinFiles();
  await write('packages/protocol/src/extra.ts', 'export const extra = 1;\n');
  git(['add', 'packages/protocol/src/extra.ts']);
  git(['commit', '-q', '-m', 'next']);
  refreshPin();
  refreshPin();
  const afterMove = await pinFiles();
  const rewritten = Object.keys(beforeMove).filter(path => path in afterMove && afterMove[path] !== beforeMove[path]);
  assert.deepEqual(rewritten, ['manifest.json'], 'only the pointer moves with HEAD');
  assert.ok((await stat(join(pinDir, 'manifest.json'))).size < 200, 'the moving pointer stays small');
  refreshPin();
  assert.deepEqual(await pinFiles(), afterMove, 'an unchanged HEAD rewrites nothing');
  // Most HEAD moves change no pinned module (Stack tooling, docs, plans). The
  // synchronized pin names HEAD's blob map, not its revision, so those moves
  // write nothing that the mirror has to stage.
  await write('apps/stack/scripts/unpinned.mjs', 'export {};\n');
  git(['add', 'apps/stack/scripts/unpinned.mjs']);
  git(['commit', '-q', '-m', 'tooling only']);
  refreshPin();
  assert.deepEqual(await pinFiles(), afterMove, 'a HEAD move without a pinned module change writes nothing');
  const moved = join(root, 'mirror-after-move');
  await cp(controller, moved, { recursive: true, verbatimSymlinks: true, filter: source => source !== join(controller, '.git') });
  const afterMoveProbe = probe(moved);
  assert.equal(afterMoveProbe.status, 0, afterMoveProbe.stderr);
  assert.equal(afterMoveProbe.stdout, 'committed+helper');
});

// P03-ENTRY-PARSE 2026-11-18: the workspace build loads the bundled-plugin
// generator through a namespaced tsx loader, and the generator re-imports the
// source runtime. tsx's namespace query made that a second module instance,
// whose pin registered another load hook above tsx: it swapped tsx's output for
// raw HEAD TypeScript and every entry-load died on an inline `type` import.
test('a source runtime re-imported through a namespaced TypeScript loader keeps one tooling pin below tsx', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-tooling-pin-namespace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const checkout = join(root, 'checkout');
  await cp(join(repo, 'apps/stack/bin'), join(checkout, 'apps/stack/bin'), { recursive: true, filter: source => !source.includes('/node_modules') });
  await cp(join(repo, 'apps/stack/scripts/utils'), join(checkout, 'apps/stack/scripts/utils'), { recursive: true, filter: source => !source.includes('/node_modules') });
  await cp(join(repo, 'packages/cli-common'), join(checkout, 'packages/cli-common'), { recursive: true,
    filter: source => source === join(repo, 'packages/cli-common') || /\.(?:mjs|cjs|json)$/u.test(source) && dirname(source) === join(repo, 'packages/cli-common') });
  const write = async (relative, contents) => {
    await mkdir(dirname(join(checkout, relative)), { recursive: true });
    await writeFile(join(checkout, relative), contents);
  };
  await write('apps/cli/package.json', JSON.stringify({ name: 'fixture-cli', type: 'module' }));
  await write('apps/cli/tsconfig.runtime.json', JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2022' } }));
  await write('apps/cli/src/field.ts', 'export interface Field { name: string }\nexport const field = (name: string): Field => ({ name });\n');
  await write('apps/cli/src/help.ts', 'import { field, type Field } from "./field.js";\nexport const help: Field = field("committed");\n');
  // The generator's shape: it imports the source runtime, then loads CLI source.
  await write('apps/cli/scripts/generator.ts', 'import "../../../packages/cli-common/registerSourceRuntime.mjs";\nexport const { help } = await import("../src/help.js");\n');
  await write('apps/stack/scripts/probe.mjs', [
    'import { createCliSourceLoader } from "../../../packages/cli-common/cliSourceLoader.mjs";',
    'const loader = await createCliSourceLoader("probe");',
    'const { help } = await loader.import(new URL("../../cli/scripts/generator.ts", import.meta.url).href, import.meta.url);',
    'process.stdout.write(help.name);',
  ].join('\n'));
  const git = args => {
    const result = spawnSync('git', ['-C', checkout, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  await symlink(join(repo, 'node_modules'), join(checkout, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, ['--conditions=happier-source',
    `--import=${pathToFileURL(join(checkout, 'apps/stack/bin/localSourceRuntimeBootstrap.mjs')).href}`,
    join(checkout, 'apps/stack/scripts/probe.mjs')], { cwd: checkout, encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_TOOLING_PACKAGES: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'committed');
});
