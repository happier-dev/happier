import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const tooling = new URL('../../', import.meta.url);
const ENTRY_GRAPHS_PATH = 'apps/stack/scripts/perf/entry-graphs.mjs';
const ENTRY_LOAD_PATH = 'apps/stack/scripts/perf/entry-load.mjs';
const GENERATED = 'apps/server/generated';
const GENERATOR_INPUTS = ['apps/server/prisma/schema.prisma', 'apps/server/prisma/sqlite/schema.prisma',
  'apps/server/prisma/mysql/schema.prisma', 'apps/server/scripts/generateClients.ts'];
// Root-level paths a source graph can load (scripts, configs, manifests, the lockfile, patches).
const ROOT_RUNTIME_INPUT = /(\.[cm]?[jt]sx?|\.json|\.ya?ml)$|^patches\//;
// The entry-load harness and the process probe it runs every graph through.
const HARNESS = /^apps\/stack\/scripts\/(perf|utils\/proc)\//;
// Extracted trees and derived server clients share one filesystem so a derivation is renamed, never copied.
const defaultRoot = () => join(tmpdir(), 'happier-commit-tree');

/** The gate mode both HEAD writers share: `report` (default), `block` or `off`. */
export function commitTreeGateMode(env = process.env) {
  const mode = String(env.HAPPIER_COMMIT_TREE_GATE ?? '').trim() || 'report';
  if (!['report', 'block', 'off'].includes(mode)) throw new Error(`HAPPIER_COMMIT_TREE_GATE must be report, block or off (got ${mode})`);
  return mode;
}

function gitAt(repo) {
  return (args, input) => execFileSync('git', args, { cwd: repo, input, maxBuffer: 2 ** 31, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Workspace packages of a tree, from its Git objects: `{ name -> { root, manifest } }`. */
function treeWorkspacePackages(git, tree) {
  const manifests = git(['ls-tree', '-r', '--name-only', '-z', tree, '--', 'apps', 'packages']).toString()
    .split('\0').filter(path => path.endsWith('/package.json') && !path.includes('/node_modules/'));
  const packages = new Map();
  if (!manifests.length) return packages;
  const out = git(['cat-file', '--batch'], `${manifests.map(path => `${tree}:${path}`).join('\n')}\n`);
  let pos = 0;
  for (const path of manifests) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString().split(' ')[2]);
    const bytes = out.subarray(nl + 1, nl + 1 + size);
    pos = nl + 1 + size + 1;
    try {
      const manifest = JSON.parse(bytes.toString());
      if (typeof manifest.name === 'string') packages.set(manifest.name, { root: dirname(path), manifest });
    } catch { /* An unparsable manifest owns no graph; the manifest gate judges it. */ }
  }
  return packages;
}

/**
 * The entry graphs a packet can reach: a graph runs when the workspace that owns a changed path is
 * in the workspace dependency closure of the package that owns the graph's entry (the same closure
 * source runtimes resolve). A root-level script, config, manifest, lockfile or patch reaches every
 * graph; other root files (docs, images) reach none.
 */
export async function selectCommitTreeEntryGraphs({ repo, base, tree }) {
  const git = gitAt(repo);
  let graphs;
  try {
    const source = git(['show', `${tree}:${ENTRY_GRAPHS_PATH}`]).toString();
    ({ ENTRY_GRAPHS: graphs } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  } catch { return { graphs: [], selected: [], changed: [] }; }
  const changed = git(['diff', '--no-renames', '--name-only', '-z', base, tree]).toString().split('\0').filter(Boolean);
  const packages = treeWorkspacePackages(git, tree);
  const { workspaceSourcePackageClosure } = await import(new URL('packages/cli-common/sourceRuntimeEntries.mjs', tooling).href);
  const roots = [...packages].map(([name, { root }]) => [name, root]).sort((a, b) => b[1].length - a[1].length);
  const ownerOf = path => roots.find(([, root]) => path.startsWith(`${root}/`))?.[0] ?? null;
  const owners = new Set();
  let all = false;
  for (const path of changed) {
    const owner = ownerOf(path);
    if (HARNESS.test(path)) all = true;
    else if (owner) owners.add(owner);
    else if (ROOT_RUNTIME_INPUT.test(path)) all = true;
  }
  const selected = graphs.filter(graph => {
    if (all) return true;
    const owner = ownerOf(graph.entry);
    if (!owner) return owners.size > 0;
    const closure = workspaceSourcePackageClosure(packages, [owner]);
    return [...owners].some(name => closure.has(name));
  }).map(graph => graph.id);
  return { graphs: graphs.map(graph => graph.id), selected, changed };
}

async function pruneGenerated(dir, keep) {
  const entries = await readdir(dir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const dated = await Promise.all(entries.filter(name => /^[a-f0-9]{64}$/.test(name))
    .map(async name => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
  for (const { name } of dated.sort((a, b) => b.at - a.at).slice(keep)) await rm(join(dir, name), { recursive: true, force: true });
}

/**
 * Server clients derived for a tree, reused across trees with the same generator inputs. The shared
 * checkout's clients follow its (possibly uncommitted) schema, so a tree never borrows them.
 */
async function prepareGeneratedInputs({ git, tree, dir, installDir, root, env, signal }) {
  const { deriveRevisionGeneratedInputs } = await import(new URL('apps/stack/scripts/build/source_revision.mjs', tooling).href);
  const blobs = GENERATOR_INPUTS.map(path => { try { return git(['rev-parse', `${tree}:${path}`]).toString().trim(); } catch { return null; } });
  let prisma = null;
  try { prisma = realpathSync(dirname(createRequire(join(installDir, 'apps/server/package.json')).resolve('@prisma/client/package.json'))); } catch { /* no server */ }
  const key = createHash('sha256').update(JSON.stringify([blobs, prisma])).digest('hex');
  const cacheDir = join(root, 'generated');
  const cached = join(cacheDir, key);
  const tracked = git(['ls-tree', '--name-only', tree, '--', GENERATED]).toString().trim() !== '';
  // A hardlink clone, never a symlink: the clients resolve their runtime packages from their real path,
  // which must stay inside the tree. Entry loads only read them; a matching stamp makes derivation a no-op.
  const { cloneTree } = await import(new URL('apps/stack/scripts/build/source_revision_install.mjs', tooling).href);
  if (!tracked && existsSync(cached)) await cloneTree(cached, join(dir, GENERATED));
  const derived = await deriveRevisionGeneratedInputs({ captureDir: dir, sourceDir: installDir, env, signal });
  const own = join(dir, GENERATED);
  if (!tracked && !existsSync(cached) && (await lstat(own).catch(() => null))?.isDirectory()) {
    await mkdir(cacheDir, { recursive: true });
    const staging = `${cached}.tmp-${process.pid}`;
    await rename(own, staging);
    await rename(staging, cached).catch(async error => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await rm(staging, { recursive: true, force: true });
    });
    await cloneTree(cached, own);
    await pruneGenerated(cacheDir, 3);
  }
  return { derived, generatedKey: key };
}

function childCpuMs() {
  // Linux: cutime + cstime of waited-for children, in clock ticks (100 Hz).
  try {
    const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
    return (Number(fields[13]) + Number(fields[14])) * 10;
  } catch { return null; }
}

/**
 * Entry loads of the exact commit tree. The tree's tracked bytes come from Git objects (`git archive`,
 * no worktree), its server clients and Protocol feature-policy module are derived from its own inputs,
 * and the shared installation is mounted read-only with every workspace resolving inside the tree. The
 * tree's own entry-load harness runs the selected graphs, so no shared-checkout source, finished or
 * not, takes part: a packet that needs another lane's uncommitted producer fails, and another lane's
 * unfinished edit never fails an unrelated packet (owner ruling 2026-11-18).
 *
 * Returns `{ findings, results, selected, timings }`; throws when the check cannot judge (extraction,
 * derivation or harness failure), which callers report as unavailable, never as a refusal.
 */
export async function commitTreeEntryLoads({ repo, base, tree, installDir = repo, root = defaultRoot(), env = process.env, signal, graphIds }) {
  const git = gitAt(repo);
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  const childBefore = childCpuMs();
  const selection = await selectCommitTreeEntryGraphs({ repo, base, tree });
  const selected = graphIds ? selection.graphs.filter(id => graphIds.includes(id)) : selection.selected;
  const timings = {};
  const finish = (result) => {
    const cpu = process.cpuUsage(cpuBefore);
    const children = childCpuMs();
    return { ...result, selected, graphs: selection.graphs.length, timings: { ...timings, totalMs: Math.round(performance.now() - started),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000) + (children !== null && childBefore !== null ? children - childBefore : 0) } };
  };
  if (!selected.length) return finish({ findings: [], results: [] });
  await mkdir(join(root, 'trees'), { recursive: true });
  const dir = await mkdtemp(join(root, 'trees', 'tree-'));
  const mark = (name, from) => { timings[name] = Math.round(performance.now() - from); return performance.now(); };
  try {
    const { extractRevision } = await import(new URL('apps/stack/scripts/build/source_revision_install.mjs', tooling).href);
    const { mountCapturedWorkspaceDependencies } = await import(new URL('scripts/workspaces/buildInputConvergence.mjs', tooling).href);
    const { readWorkspacePackages } = await import(new URL('packages/cli-common/sourceRuntimeEntries.mjs', tooling).href);
    const { withDependencyConsumption } = await import(new URL('apps/stack/scripts/utils/proc/dependency_refresh.mjs', tooling).href);
    let at = performance.now();
    await extractRevision({ repoDir: repo, revision: tree, outputDir: dir });
    at = mark('extractMs', at);
    // The shared installation stays published while the tree consumes it.
    const results = await withDependencyConsumption({ installDir, env, signal }, async () => {
      const { generatedKey } = await prepareGeneratedInputs({ git, tree, dir, installDir, root, env, signal });
      timings.generatedKey = generatedKey.slice(0, 12);
      at = mark('generatedMs', at);
      const workspaceDirs = [...(await readWorkspacePackages(dir)).values()].map(workspace => relative(dir, workspace.root)).filter(Boolean);
      await mountCapturedWorkspaceDependencies({ sourceDir: installDir, captureDir: dir, workspaceDirs });
      at = mark('mountMs', at);
      const output = await runTreeHarness({ dir, selected, env, signal });
      mark('loadsMs', at);
      return output;
    });
    const findings = results.filter(result => result.status !== 'passed').map(result => {
      const module = result.firstFailingModule ? relative(dir, resolve(dir, result.firstFailingModule)) : result.entry;
      const message = String(result.loadError?.message ?? 'failed').split('\n')[0].replaceAll(`${dir}/`, '').slice(0, 300);
      return `${result.graph}: ${module}: ${message}`;
    });
    return finish({ findings, results: results.map(({ graph, status, elapsedMs }) => ({ graph, status, elapsedMs: Math.round(elapsedMs) })) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTreeHarness({ dir, selected, env, signal }) {
  const code = `const { ENTRY_GRAPHS, loadEntryGraph } = await import(${JSON.stringify(pathToFileURL(join(dir, ENTRY_LOAD_PATH)).href)});
const ids = ${JSON.stringify(selected)};
for (const graph of ENTRY_GRAPHS.filter(graph => ids.includes(graph.id))) console.log('ENTRY_RESULT ' + JSON.stringify(await loadEntryGraph(graph)));`;
  // The tree is the commit: its packages load as they are, never through the checkout's HEAD pin.
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: { ...env, HAPPIER_STACK_TOOLING_PACKAGES: 'live' }, signal, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code_] = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('close', (...args) => resolvePromise(args)); });
  const results = stdout.split('\n').filter(line => line.startsWith('ENTRY_RESULT ')).map(line => JSON.parse(line.slice('ENTRY_RESULT '.length)));
  if (code_ !== 0 || results.length !== selected.length) {
    throw new Error(`tree entry-load harness exited ${code_} with ${results.length}/${selected.length} results: ${stderr.slice(-400)}`);
  }
  return results;
}

/** Where report-mode verdicts land, one JSON line per candidate (P03 ORCH reads the cost from it). */
export function defaultCommitTreeLedger(repo) {
  return join(repo, '.project/tmp/commit-tree-gate/ledger.jsonl');
}

/**
 * Detached report-mode run for a writer that must not wait (the ledger records the verdict). A tree
 * without the entry-load harness (scratch repositories) has nothing to load and starts nothing.
 */
export function startCommitTreeEntryLoadReport({ repo, base, tree, label, ledger = defaultCommitTreeLedger(repo), env = process.env }) {
  try { gitAt(repo)(['cat-file', '-e', `${tree}:${ENTRY_GRAPHS_PATH}`]); } catch { return null; }
  mkdirSync(dirname(ledger), { recursive: true });
  const log = openSync(`${ledger}.log`, 'a');
  const child = spawn(process.execPath, [self, '--report', '--repo', repo, '--base', base, '--tree', tree, '--label', label, '--ledger', ledger],
    { cwd: repo, env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return child.pid;
}

/** One report run at a time per host: a measurement mode must not multiply its own cost. */
function takeReportLock(root) {
  mkdirSync(root, { recursive: true });
  const lock = join(root, 'report.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return () => rmSync(lock, { force: true }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(lock, 'utf8').trim());
      try { process.kill(owner, 0); return null; } catch { rmSync(lock, { force: true }); }
    }
  }
  return null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
  const repo = resolve(option('repo') ?? process.cwd());
  const git = gitAt(repo);
  const base = git(['rev-parse', option('base') ?? 'HEAD']).toString().trim();
  const tree = git(['rev-parse', option('tree')]).toString().trim();
  const ledger = option('ledger') ?? defaultCommitTreeLedger(repo);
  const label = option('label') ?? 'manual';
  if (args.includes('--detach')) {
    const pid = startCommitTreeEntryLoadReport({ repo, base, tree, label, ledger });
    console.log(pid ? `commit tree entry loads: report started (pid ${pid}; ledger ${ledger})` : 'commit tree entry loads: the tree has no entry-load harness; nothing to report');
    process.exit(0);
  }
  const record = entry => { if (ledger) appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), label, base, tree, ...entry })}\n`); };
  const release = args.includes('--report') ? takeReportLock(defaultRoot()) : () => {};
  if (!release) { record({ verdict: 'skipped', reason: 'another report run is active on this host' }); process.exit(0); }
  try {
    const result = await commitTreeEntryLoads({ repo, base, tree, installDir: resolve(option('install-dir') ?? repo) });
    for (const finding of result.findings) console.error(`tree entry load: ${finding}`);
    console.log(`commit tree entry loads: ${result.selected.length}/${result.graphs} graph(s), ${result.findings.length} failure(s), ${JSON.stringify(result.timings)}`);
    record({ verdict: result.findings.length ? 'would-refuse' : 'pass', selected: result.selected, findings: result.findings, results: result.results, timings: result.timings });
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    console.error(`commit tree entry loads unavailable: ${String(error?.stack ?? error).slice(0, 800)}`);
    record({ verdict: 'unavailable', error: String(error?.message ?? error).slice(0, 400) });
    process.exitCode = 75;
  } finally { release(); }
}
