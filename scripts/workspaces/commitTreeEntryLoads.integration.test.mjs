import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commitTreeEntryLoads, selectCommitTreeEntryGraphs } from './commitTreeEntryLoads.mjs';

// A miniature shared checkout: this repository's HEAD objects (alternates, no copy), a full working
// tree of HEAD with the installation mounted the way captured trees mount it, and uncommitted edits
// on top. Entry loads of that working tree are what the gate used to judge.
// The repository that owns the installation (through apps/, so a scratch copy of this file resolves it too).
const real = path.dirname(fs.realpathSync(fileURLToPath(new URL('../../apps', import.meta.url))));
const ENTRY = 'packages/protocol/src/actions/specs/projectServicePlacement.ts';
const PRODUCER = 'packages/protocol/src/actions/specs/projectWorkersActionIdsV1.ts';
const BROKEN = 'packages/protocol/src/machines/managed/credentialDeliveryV1.ts';

async function sharedCheckout(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-tree-checkout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  const git = (args, input) => execFileSync('git', args, { cwd: dir, env, input, encoding: 'utf8', maxBuffer: 2 ** 30 });
  git(['init', '-q']);
  const objects = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: real, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, '.git/objects/info/alternates'), `${path.join(objects, 'objects')}\n`);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: real, encoding: 'utf8' }).trim();
  git(['update-ref', 'HEAD', head]);
  git(['read-tree', head]);
  const { extractRevision } = await import('../../apps/stack/scripts/build/source_revision_install.mjs');
  const { mountCapturedWorkspaceDependencies } = await import('./buildInputConvergence.mjs');
  const { readWorkspacePackages } = await import('../../packages/cli-common/sourceRuntimeEntries.mjs');
  await extractRevision({ repoDir: dir, revision: head, outputDir: dir });
  const workspaceDirs = [...(await readWorkspacePackages(dir)).values()].map(w => path.relative(dir, w.root)).filter(Boolean);
  await mountCapturedWorkspaceDependencies({ sourceDir: real, captureDir: dir, workspaceDirs });
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), value);
  // A lane's packet: its own working-tree edits, committed from HEAD in a private index (no worktree).
  const packet = (files, from = head) => {
    for (const [name, value] of Object.entries(files)) write(name, value);
    const index = path.join(dir, '.git', `packet-${process.hrtime.bigint()}`);
    const penv = { ...env, GIT_INDEX_FILE: index };
    execFileSync('git', ['read-tree', from], { cwd: dir, env: penv });
    for (const [name, value] of Object.entries(files)) {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: value, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--cacheinfo', `100644,${blob},${name}`], { cwd: dir, env: penv });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: dir, env: penv, encoding: 'utf8' }).trim();
    fs.rmSync(index, { force: true });
    return tree;
  };
  return { dir, head, git, read, write, packet };
}

test('refuses a packet that needs a producer existing only as an uncommitted edit in the shared checkout', { timeout: 900_000 }, async (t) => {
  const c = await sharedCheckout(t);
  // The uncommitted producer edit (the 1f986f64d8a shape: a consumer reads a registration only the
  // checkout has). A namespace read is invisible to the textual producer-closure check.
  c.write(PRODUCER, `${c.read(PRODUCER)}\nexport const GATE_TREE_PRODUCER = 'uncommitted';\n`);
  const tree = c.packet({ [ENTRY]: `${c.read(ENTRY)}
import * as gateTreeProducer from './projectWorkersActionIdsV1.js';
if (!('GATE_TREE_PRODUCER' in gateTreeProducer)) throw new Error('GATE_TREE_PRODUCER is not committed');
` });
  const result = await commitTreeEntryLoads({ repo: c.dir, base: c.head, tree, installDir: c.dir, graphIds: ['protocol-service-placement-actions'] });
  assert.deepEqual(result.selected, ['protocol-service-placement-actions']);
  assert.equal(result.findings.length, 1, JSON.stringify(result));
  assert.match(result.findings[0], /^protocol-service-placement-actions: .*GATE_TREE_PRODUCER is not committed/);
});

test('accepts a packet unrelated to a broken uncommitted edit elsewhere in the shared checkout', { timeout: 900_000 }, async (t) => {
  const c = await sharedCheckout(t);
  c.write(BROKEN, `${c.read(BROKEN)}\nexport const = ;\n`);
  const tree = c.packet({ [ENTRY]: `${c.read(ENTRY)}\n// An unrelated packet.\n` });
  const result = await commitTreeEntryLoads({ repo: c.dir, base: c.head, tree, installDir: c.dir,
    graphIds: ['protocol-managed-credential-delivery', 'protocol-service-placement-actions'] });
  assert.deepEqual(result.findings, [], JSON.stringify(result));
  assert.deepEqual(result.results.map(r => r.status), ['passed', 'passed']);
});

test('does not blame a packet for an entry graph its base already fails', { timeout: 900_000 }, async (t) => {
  const c = await sharedCheckout(t);
  const brokenBase = c.git(['commit-tree', c.packet({ [BROKEN]: `${c.read(BROKEN)}\nexport const = ;\n` }), '-p', c.head, '-m', 'broken base']).trim();
  const tree = c.packet({ [ENTRY]: `${c.read(ENTRY)}\n// An unrelated packet on a broken HEAD.\n` }, brokenBase);
  const result = await commitTreeEntryLoads({ repo: c.dir, base: brokenBase, tree, installDir: c.dir, graphIds: ['protocol-managed-credential-delivery'] });
  assert.deepEqual(result.findings, [], JSON.stringify(result));
  assert.equal(result.preexisting.length, 1, JSON.stringify(result));
  assert.match(result.preexisting[0], /^protocol-managed-credential-delivery: /);
});

test('refuses the 1f986f64d8a tree: a server route names an Action spec its Protocol lacks', { timeout: 900_000 }, async () => {
  // The real incident: the route consumed the uncommitted review.get spec; every HEAD server died at boot.
  const result = await commitTreeEntryLoads({ repo: real, base: '1f986f64d8a~1', tree: '1f986f64d8a', graphIds: ['server-routes'] });
  assert.equal(result.findings.length, 1, JSON.stringify(result));
  assert.match(result.findings[0], /^server-routes: .*Unknown action spec: review\.get/);
  const selection = await selectCommitTreeEntryGraphs({ repo: real, base: '1f986f64d8a~1', tree: '1f986f64d8a' });
  assert.ok(selection.selected.includes('server-routes'), JSON.stringify(selection));
});

test('selects only the entry graphs whose workspace closure owns a changed path', async () => {
  const git = (...args) => execFileSync('git', args, { cwd: real, encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  const docs = await selectCommitTreeEntryGraphs({ repo: real, base: `${head}~1`, tree: `${head}~1` });
  assert.deepEqual(docs.selected, []);
  // A changed UI file reaches the UI graphs, never the server or the Protocol entries.
  const ui = await selectCommitTreeEntryGraphs({ repo: real, base: head, tree: (() => {
    const index = path.join(os.tmpdir(), `select-index-${process.pid}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync('git', ['read-tree', head], { cwd: real, env });
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: real, input: '// ui\n', encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},apps/ui/sources/gateTreeSelection.ts`], { cwd: real, env });
    const tree = execFileSync('git', ['write-tree'], { cwd: real, env, encoding: 'utf8' }).trim();
    fs.rmSync(index, { force: true });
    return tree;
  })() });
  assert.ok(ui.selected.includes('ui-catalog'), JSON.stringify(ui));
  assert.ok(!ui.selected.includes('server'), JSON.stringify(ui));
  assert.ok(!ui.selected.includes('server-routes'), JSON.stringify(ui));
  assert.ok(!ui.selected.includes('protocol-service-placement-actions'), JSON.stringify(ui));
});


function miniatureRevision(t, files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-revision-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']) delete env[name];
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const write = (name, bytes) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), bytes);
  };
  git('init', '-q');
  git('config', 'user.name', 'fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  write('package.json', '{"private":true,"type":"module"}');
  write('.gitignore', 'node_modules/\ndist/\n');
  write('pnpm-workspace.yaml', 'packages: ["packages/*", "packages/plugins/*"]\n');
  for (const [name, bytes] of Object.entries(files)) write(name, bytes);
  git('add', '.');
  git('commit', '-qm', 'selected revision');
  return { repo, tree: git('rev-parse', 'HEAD'), write };
}

test('revision bundles resolve candidate-only entry points and never load primary workspace dist', async t => {
  const entry = 'packages/plugins/machine-ssh/src/index.ts';
  const stale = 'packages/plugins/machine-ssh/dist/stale.js';
  const { repo, tree, write } = miniatureRevision(t, {
    [entry]: "import { value } from '@happier-dev/protocol'; export default value;",
    'packages/protocol/package.json': '{"name":"@happier-dev/protocol","exports":{".":{"happier-source":"./src/index.ts","default":"./dist/index.js"}}}',
    'packages/protocol/src/index.ts': 'export const value = "judged revision";',
    'packages/plugins/machine-ssh/src/stale.ts': "export { value } from '../dist/stale.js';",
    'packages/cli-common/package.json': '{"name":"@happier-dev/cli-common"}',
  });
  fs.rmSync(path.join(repo, entry));
  write('packages/protocol/src/index.ts', 'export const value = "primary checkout";');
  write(stale, 'export const value = "primary dist only";');
  const require = createRequire(import.meta.url);
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('esbuild/package.json')), path.join(repo, 'node_modules/esbuild'), 'junction');
  // The resolver used to be imported from the primary checkout. The implementation
  // is the same production module, supplied through its real path in this fixture.
  fs.symlinkSync(path.join(real, 'packages/cli-common/sourceRuntimeEntries.mjs'),
    path.join(repo, 'packages/cli-common/sourceRuntimeEntries.mjs'), 'file');
  const { revisionSourceBundler } = await import('./revisionSourceBundle.mjs');
  const bundle = await revisionSourceBundler({ repo, rev: tree, preloadRoots: ['packages'] });
  const build = name => bundle.esbuild.build({ absWorkingDir: repo, entryPoints: [path.join(repo, name)],
    bundle: true, write: false, format: 'esm', logLevel: 'silent', plugins: [bundle.plugin] });
  const selected = await build(entry);
  assert.match(selected.outputFiles[0].text, /judged revision/);
  assert.doesNotMatch(selected.outputFiles[0].text, /primary checkout/);
  await build('packages/plugins/machine-ssh/src/stale.ts').catch(() => {});
  assert.ok(bundle.missing.some(line => line.includes(stale)), 'a primary dist file cannot satisfy an import');
});

test('entry graph generation and workspace resolution stay inside the judged tree', async t => {
  const { repo, tree, write } = miniatureRevision(t, {
    'apps/stack/scripts/perf/entry-graphs.mjs': "export const ENTRY_GRAPHS = [{ id: 'isolated', entry: 'packages/protocol/src/index.mjs' }];",
    'apps/stack/scripts/perf/entry-load.mjs': `
      import { readFile } from 'node:fs/promises';
      export { ENTRY_GRAPHS } from './entry-graphs.mjs';
      export async function loadEntryGraph() {
        const { selected } = await import('@happier-dev/protocol');
        const generated = await readFile('generated-by-tree', 'utf8').catch(() => 'missing');
        const absent = await import('@happier-dev/primary-only').then(() => false, () => true);
        const status = selected === 'judged' && generated === 'judged' && absent ? 'passed' : 'failed';
        return { graph: 'isolated', status, entry: 'packages/protocol/src/index.mjs', elapsedMs: 1,
          loadError: { message: JSON.stringify({ selected, generated, absent }) } };
      }
    `,
    'apps/stack/scripts/build/source_revision.mjs': `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { selected } from '@happier-dev/protocol';
      export async function deriveRevisionGeneratedInputs({ captureDir }) {
        await writeFile(join(captureDir, 'generated-by-tree'), selected);
      }
    `,
    'packages/cli-common/registerSourceRuntime.mjs': '',
    'packages/protocol/package.json': '{"name":"@happier-dev/protocol","type":"module","exports":"./src/index.mjs"}',
    'packages/protocol/src/index.mjs': "export const selected = 'judged';",
  });
  write('node_modules/@happier-dev/primary-only/package.json', '{"type":"module","exports":"./index.mjs"}');
  write('node_modules/@happier-dev/primary-only/index.mjs', "export const selected = 'primary';");
  write('packages/protocol/src/index.mjs', "export const selected = 'primary';");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p03-isolated-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await commitTreeEntryLoads({ repo, base: tree, tree, graphIds: ['isolated'], root });
  assert.deepEqual(result.results.map(row => row.status), ['passed'], JSON.stringify(result));
});

test('the synchronous scope ignores a UI-only packet for CLI and daemon and keeps both for a CLI input', async t => {
  const registry = [
    { id: 'cli', entry: 'apps/cli/src/index.ts' },
    { id: 'daemon', entry: 'apps/cli/src/daemon/startDaemon.ts' },
    { id: 'ui-catalog', entry: 'apps/ui/sources/catalog.test.ts', testFiles: ['sources/catalog.test.ts'] },
  ];
  const { repo, tree, write } = miniatureRevision(t, {
    'apps/stack/scripts/perf/entry-graphs.mjs': `export const ENTRY_GRAPHS = ${JSON.stringify(registry)};`,
    'apps/cli/package.json': '{"name":"@fixture/cli"}',
    'apps/ui/package.json': '{"name":"@fixture/ui"}',
    'apps/cli/src/index.ts': 'export {};\n',
    'apps/cli/src/daemon/startDaemon.ts': 'export {};\n',
    'apps/ui/sources/catalog.test.ts': 'export {};\n',
  });
  const commit = (path, value) => {
    write(path, value);
    execFileSync('git', ['add', '--', path], { cwd: repo });
    execFileSync('git', ['commit', '-qm', path], { cwd: repo });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  };
  const ui = commit('apps/ui/sources/ui.ts', 'export {};\n');
  assert.deepEqual((await selectCommitTreeEntryGraphs({ repo, base: tree, tree: ui, phase: 'commit' })).selected, []);
  const cli = commit('apps/cli/src/index.ts', 'export const cli = 1;\n');
  assert.deepEqual((await selectCommitTreeEntryGraphs({ repo, base: ui, tree: cli, phase: 'commit' })).selected, ['cli', 'daemon']);
});
