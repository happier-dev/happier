import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const tooling = new URL('../../', import.meta.url);
const ENTRY_LOAD_ADMISSION_CLASS = 'gate-entry-loads';
const ENTRY_LOAD_RESULT = 'HAPPIER_COMMIT_ENTRY_LOAD_RESULT ';
const ENTRY_LOAD_READY = 'HAPPIER_COMMIT_ENTRY_LOAD_READY';
const ENTRY_GRAPHS_PATH = 'apps/stack/scripts/perf/entry-graphs.mjs';
const ENTRY_LOAD_PATH = 'apps/stack/scripts/perf/entry-load.mjs';
const CLI_GRAPH = 'cli';
const DAEMON_GRAPH = 'daemon';
const DAEMON_ENTRY = 'apps/cli/src/daemon/startDaemon.ts';
const REQUIRED_RUNTIME_GRAPHS = new Set([CLI_GRAPH, DAEMON_GRAPH]);
const TEST_OR_DOC = /(?:^|\/)(?:__tests__|__snapshots__|docs)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.mdx?$/iu;
const GENERATED = 'apps/server/generated';
// Route composition of the tree's server (P03 ORCH 2026-11-18): the entry graphs stop at the server's import probe,
// so an Action a route names but the packet's Protocol lacks (1f986f64d8a: review.get) passed them. This graph
// composes the server's routes on a bare app (no database, no listener) through the server's own registration
// entry, and runs only for packets that touch Protocol Action specs or server sources.
const SERVER_ROUTES_GRAPH = 'server-routes';
const SERVER_ROUTES_ENTRY = 'apps/server/sources/app/api/api.ts';
const SERVER_ROUTES_INPUT = /^packages\/protocol\/src\/actions\/|^apps\/server\/sources\//;
const GENERATOR_INPUTS = ['apps/server/prisma/schema.prisma', 'apps/server/prisma/sqlite/schema.prisma',
  'apps/server/prisma/mysql/schema.prisma', 'apps/server/scripts/generateClients.ts'];
// Root-level paths a source graph can load (scripts, configs, manifests, the lockfile, patches).
const COMMIT_ROOT_RUNTIME_INPUT = /^(?:package\.json$|pnpm-(?:lock|workspace)\.yaml$|\.npmrc$|tsconfig[^/]*\.json$|\.github\/feature-policy\/|patches\/)/u;
const ROOT_RUNTIME_INPUT = /(\.[cm]?[jt]sx?|\.json|\.ya?ml)$|^patches\//;
// The entry-load harness and the process probe it runs every graph through.
const HARNESS = /^apps\/stack\/scripts\/(perf|utils\/proc)\//;
// Extracted trees and derived server clients share one filesystem so a derivation is renamed, never copied.
const defaultRoot = () => join(process.env.P03_COMMIT_TREE_HOST_TMP || tmpdir(), 'happier-commit-tree');

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

export function readCommitTreeWorkspacePackages(repo, tree) {
  return treeWorkspacePackages(gitAt(repo), tree);
}

/** The commit gate loads affected runtime entry points. Reports can include the full harness. */
export async function selectCommitTreeEntryGraphs({ repo, base, tree, phase = 'report' }) {
  const git = gitAt(repo);
  const hasPath = (revision, path) => git(['ls-tree', '--name-only', revision, '--', path]).length > 0;
  const hasRegistry = revision => hasPath(revision, ENTRY_GRAPHS_PATH);
  if (!hasRegistry(tree)) {
    if (hasRegistry(base)) throw new Error(`candidate removed the entry graph registry at ${ENTRY_GRAPHS_PATH}`);
    if (hasPath(tree, 'apps/cli/package.json')) throw new Error('candidate is missing the required CLI entry graph');
    return { graphs: [], selected: [], changed: [] };
  }
  const source = git(['show', `${tree}:${ENTRY_GRAPHS_PATH}`]);
  const { ENTRY_GRAPHS: graphs } = await import(`data:text/javascript;base64,${source.toString('base64')}`);
  if (!Array.isArray(graphs) || !graphs.length || graphs.some(graph => !graph?.id || !graph?.entry)
    || new Set(graphs.map(graph => graph.id)).size !== graphs.length) {
    throw new Error(`invalid entry graph registry at ${ENTRY_GRAPHS_PATH}`);
  }
  if (!graphs.some(graph => graph.id === CLI_GRAPH) && hasPath(tree, 'apps/cli/package.json')) {
    throw new Error('candidate is missing the required CLI entry graph');
  }
  if (!graphs.some(graph => graph.id === DAEMON_GRAPH) && hasPath(tree, DAEMON_ENTRY)) {
    throw new Error('candidate is missing the required daemon entry graph');
  }
  const pathsBetween = (from, to) => git(['diff', '--no-renames', '--name-only', '-z', from, to]).toString().split('\0').filter(Boolean);
  const changed = pathsBetween(base, tree);
  const { workspaceSourcePackageClosure } = await import(new URL('packages/cli-common/sourceRuntimeEntries.mjs', tooling).href);
  const reaches = (paths, packages, rootInput) => {
    const roots = [...packages].map(([name, { root }]) => [name, root]).sort((a, b) => b[1].length - a[1].length);
    const ownerOf = path => roots.find(([, root]) => path.startsWith(`${root}/`))?.[0] ?? null;
    const owners = new Set();
    for (const path of paths) {
      const owner = ownerOf(path);
      if (HARNESS.test(path) || (!owner && rootInput.test(path))) return () => true;
      if (owner) owners.add(owner);
    }
    return entry => {
      const owner = ownerOf(entry);
      if (!owner) return owners.size > 0;
      const closure = workspaceSourcePackageClosure(packages, [owner]);
      return [...owners].some(name => closure.has(name));
    };
  };

  let routes = false;
  try { git(['cat-file', '-e', `${tree}:${SERVER_ROUTES_ENTRY}`]); routes = true; } catch { /* no server in this tree */ }
  const entries = routes ? [...graphs, { id: SERVER_ROUTES_GRAPH, entry: SERVER_ROUTES_ENTRY }] : graphs;
  const inputs = phase === 'commit' ? changed.filter(path => !TEST_OR_DOC.test(path) || HARNESS.test(path)) : changed;
  const rootInput = phase === 'commit' ? COMMIT_ROOT_RUNTIME_INPUT : ROOT_RUNTIME_INPUT;
  const candidateReaches = reaches(inputs, treeWorkspacePackages(git, tree), rootInput);
  const baseReaches = phase === 'commit' ? reaches(inputs, treeWorkspacePackages(git, base), rootInput) : () => false;
  const selected = entries.filter(({ id, entry, args, testFiles }) => {
    const broad = args || testFiles || id === 'sdk-browser' || id === 'daemon-entry-preparation';
    if (phase === 'commit' && broad || phase === 'deferred' && !broad) return false;
    if (phase === 'report' && id === CLI_GRAPH) return changed.length > 0;
    if (id === SERVER_ROUTES_GRAPH) return inputs.some(path => SERVER_ROUTES_INPUT.test(path));
    return candidateReaches(entry) || baseReaches(entry);
  });
  return { graphs: entries.map(graph => graph.id), selected: selected.map(graph => graph.id), changed };
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
  await deriveTreeGeneratedInputs({ dir, installDir, env, signal });
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
  return key;
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
 * Returns `{ findings, preexisting, results, selected, timings }`. A CLI or daemon load failure always refuses the candidate.
 * Other graphs report failures they share with the base. Extraction, derivation or missing harness results make
 * the check unavailable.
 */
export async function commitTreeEntryLoads({ repo, base, tree, installDir = repo, root = defaultRoot(), env = process.env, signal, graphIds, phase = 'report', compareAdmittedEntryLoads }) {
  const git = gitAt(repo);
  [base, tree] = git(['rev-parse', `${base}^{tree}`, `${tree}^{tree}`]).toString().trim().split('\n');
  const selection = await selectCommitTreeEntryGraphs({ repo, base, tree, phase });
  const selected = graphIds ? selection.graphs.filter(id => graphIds.includes(id)) : selection.selected;
  const empty = { findings: [], preexisting: [], results: [], selected, graphs: selection.graphs.length, timings: {} };
  if (!selected.length) return empty;
  const request = { repo, base, tree, installDir, root, selected, graphs: selection.graphs.length, waitForDependencies: !compareAdmittedEntryLoads };
  return compareAdmittedEntryLoads
    ? await compareAdmittedEntryLoads(request)
    : await admitEntryLoads(request, { env, signal });
}

function entryLoadAdmissionCommand(repo, projects, payload, { base, tree } = {}) {
  if (process.platform === 'win32') return payload;
  const localLauncher = join(repo, 'apps/stack/bin/hstack-exec');
  const launcher = existsSync(localLauncher) ? localLauncher : fileURLToPath(new URL('apps/stack/bin/hstack-exec', tooling));
  return [launcher, '--heavyweight-admission', `--class=${ENTRY_LOAD_ADMISSION_CLASS}`, '--machine=local',
    `--projects=${projects.join('\n')}`, '--identity-arg=node', '--identity-arg=scripts/workspaces/commitTreeEntryLoads.mjs',
    ...(base && tree ? [`--judged-trees=${base},${tree}`] : []),
    '--', ...payload];
}

async function spawnEntryLoadCommand({ repo, projects, payload, signal, env, stdio, ...options }) {
  const [command, ...args] = entryLoadAdmissionCommand(repo, projects, payload, options);
  const { spawnForegroundCommand } = await import(new URL('apps/stack/scripts/utils/proc/proc.mjs', tooling).href);
  return spawnForegroundCommand(command, args, { cwd: repo, env, signal, stdio, ownedProcessGroup: true });
}

export class EntryLoadAdmissionUnavailable extends Error {
  constructor(status) {
    super(`entry-load admission did not grant the commit gate (exit ${status})`);
    this.status = status;
  }
}

/**
 * The native payload signals its grant, then waits for the exact scoped request
 * from the lock holder. Leave its input open through CAS to retain the slot.
 * Reserve the packet's reachable set because HEAD can move while admission waits.
 */
export async function withAdmittedCommitEntryPhase({ repo, base, tree, phase, env = process.env }, run) {
  const { selected: projects } = await selectCommitTreeEntryGraphs({ repo, base, tree, phase });
  const assertCovered = request => {
    if (request.selected.some(project => !projects.includes(project))) {
      throw new Error('HEAD changed the reachable entry points during admission; retry against current HEAD');
    }
  };
  if (!projects.length) return await run(assertCovered);
  const child = await spawnEntryLoadCommand({ repo, projects, env, stdio: ['pipe', 'pipe', 'inherit'],
    payload: [process.execPath, self, '--entry-load-commit-session'] });
  const terminal = waitForTreeChild(child);
  // The stream can close before the child reports its exit status.
  terminal.catch(() => {});
  child.stdin.on('error', () => {}); // An early child exit is handled by the response and terminal status.
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lines = output[Symbol.asyncIterator]();
  const readLine = async predicate => {
    for (;;) {
      const { done, value } = await lines.next();
      if (done) return undefined;
      if (predicate(value)) return value;
    }
  };
  try {
    if (!await readLine(line => line === ENTRY_LOAD_READY)) {
      const status = await terminal.catch(error => error.code ?? error.name);
      throw new EntryLoadAdmissionUnavailable(status);
    }
    return await run(async request => {
      assertCovered(request);
      child.stdin.write(JSON.stringify(request) + '\n');
      const line = await readLine(line => line.startsWith(ENTRY_LOAD_RESULT));
      if (!line) throw new Error(`admitted entry loads did not return a verdict (exit ${await terminal})`);
      return JSON.parse(line.slice(ENTRY_LOAD_RESULT.length));
    });
  } finally {
    child.stdin.end();
    output.close();
    await terminal.catch(() => {});
  }
}

async function admitEntryLoads(request, { env, signal }) {
  const child = await spawnEntryLoadCommand({ ...request, projects: request.selected, signal,
    payload: [process.execPath, self, '--entry-load-admitted'],
    env: { ...env, HAPPIER_COMMIT_ENTRY_LOAD_REQUEST: JSON.stringify(request) },
    stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  const status = await waitForTreeChild(child);
  const line = stdout.split('\n').find(line => line.startsWith(ENTRY_LOAD_RESULT));
  if (status !== 0 || !line) throw new Error(`entry-load admission did not return a verdict (exit ${status})`);
  return JSON.parse(line.slice(ENTRY_LOAD_RESULT.length));
}

async function compareSelectedEntryLoads({ repo, base, tree, installDir, root, selected, graphs, waitForDependencies }, env, signal) {
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  const childBefore = childCpuMs();
  const timings = {};
  const finish = result => {
    const cpu = process.cpuUsage(cpuBefore);
    const children = childCpuMs();
    return { ...result, selected, graphs, timings: { ...timings, totalMs: Math.round(performance.now() - started),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000) + (children !== null && childBefore !== null ? children - childBefore : 0) } };
  };
  const candidate = await loadTreeGraphs({ repo, tree, ids: selected, installDir, root, env, signal, timings, waitForDependencies });
  const requiredFailures = candidate.failures.filter(failure => REQUIRED_RUNTIME_GRAPHS.has(failure.graph));
  if (requiredFailures.length) return finish({
    findings: requiredFailures.map(failure => failure.finding), preexisting: [], results: candidate.results,
  });
  // Non-CLI graphs keep reporting the delta for checks such as manifest generation and route composition.
  const failing = candidate.failures.map(failure => failure.graph);
  const baseFailures = failing.length
    ? new Set((await loadTreeGraphs({ repo, tree: base, ids: failing, installDir, root, env, signal, timings: {}, waitForDependencies })).failures.map(failure => failure.key))
    : new Set();
  const findings = [];
  const preexisting = [];
  for (const { key, finding } of candidate.failures) {
    (baseFailures.has(key) ? preexisting : findings).push(finding);
  }
  return finish({ findings, preexisting, results: candidate.results });
}

/** One tree: extract, derive its generated inputs, mount the installation, load the graphs. */
async function loadTreeGraphs({ repo, tree, ids, installDir, root, env, signal, timings, waitForDependencies }) {
  const git = gitAt(repo);
  const trees = env.P03_COMMIT_TREE_WORK_DIR || join(root, 'trees');
  await mkdir(trees, { recursive: true });
  const dir = await mkdtemp(join(trees, 'tree-'));
  const mark = (name, from) => { timings[name] = Math.round(performance.now() - from); return performance.now(); };
  try {
    const { extractRevision } = await import(new URL('apps/stack/scripts/build/source_revision_install.mjs', tooling).href);
    const { mountCapturedWorkspaceDependencies } = await import(new URL('scripts/workspaces/buildInputConvergence.mjs', tooling).href);
    const { readWorkspacePackages } = await import(new URL('packages/cli-common/sourceRuntimeEntries.mjs', tooling).href);
    const { withDependencyConsumption } = await import(new URL('apps/stack/scripts/utils/proc/dependency_refresh.mjs', tooling).href);
    let at = performance.now();
    await extractRevision({ repoDir: repo, revision: tree, outputDir: dir });
    signal?.throwIfAborted();
    at = mark('extractMs', at);
    // The shared installation stays published while the tree consumes it.
    const results = await withDependencyConsumption({ installDir, env, signal, wait: waitForDependencies }, async () => {
      const workspaceDirs = [...(await readWorkspacePackages(dir)).values()].map(workspace => relative(dir, workspace.root)).filter(Boolean);
      const mount = () => mountCapturedWorkspaceDependencies({ sourceDir: installDir, captureDir: dir, workspaceDirs, capturedOnly: true });
      await mount();
      at = mark('mountMs', at);
      const generatedKey = await prepareGeneratedInputs({ git, tree, dir, installDir, root, env, signal });
      timings.generatedKey = generatedKey.slice(0, 12);
      // Prisma generation releases the borrowed tools in the root and server
      // modules. Rebind those tool links before running the entry graphs.
      await mount();
      at = mark('generatedMs', at);
      const harnessIds = ids.filter(id => id !== SERVER_ROUTES_GRAPH);
      const output = harnessIds.length ? await runTreeHarness({ dir, selected: harnessIds, env, signal }) : [];
      if (ids.includes(SERVER_ROUTES_GRAPH)) output.push(await runServerRoutes({ dir, env, signal }));
      mark('loadsMs', at);
      return output;
    });
    const reported = new Set(results.map(result => result?.graph));
    if (results.length !== ids.length || ids.some(id => !reported.has(id))
      || results.some(result => !['passed', 'failed'].includes(result?.status) || !Number.isFinite(result.elapsedMs))) {
      throw new Error(`entry-load harness did not return one valid result for each selected graph: ${ids.join(', ')}`);
    }
    const failures = results.filter(result => result.status === 'failed').map(result => {
      const module = result.firstFailingModule ? relative(dir, resolve(dir, result.firstFailingModule)) : result.entry;
      const message = String(result.loadError?.message ?? 'failed').split('\n')[0].replaceAll(`${dir}/`, '').slice(0, 300);
      const phase = /(?:^|\s)phase=([a-z][\w-]*)\b/u.exec(message)?.[1] ?? null;
      return { graph: result.graph, key: JSON.stringify([result.graph, module, phase]),
        finding: `${result.graph}: ${module}: ${message}` };
    });
    return { failures, results: results.map(({ graph, status, elapsedMs }) => ({ graph, status, elapsedMs: Math.round(elapsedMs) })) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// AbortSignal emits an error before the subprocess exits. The tree stays until its reader closes.
function waitForTreeChild(child) {
  return new Promise((resolvePromise, reject) => {
    let failure;
    child.once('error', error => { failure = error; });
    child.once('close', code => { if (failure) reject(failure); else resolvePromise(code); });
  });
}

const treeEnvironment = (dir, env) => ({ ...env, HAPPIER_STACK_REPO_DIR: dir, HAPPIER_STACK_TOOLING_PACKAGES: 'live' });

/** Load preparation through the judged tree's loader and workspace packages. */
async function deriveTreeGeneratedInputs({ dir, installDir, env, signal }) {
  const entry = pathToFileURL(join(dir, 'apps/stack/scripts/build/source_revision.mjs')).href;
  const generator = join(dir, 'packages/protocol/scripts/generate-embedded-feature-policies.mjs');
  // Some imports of the revision preparation module already load Protocol.
  // Materialize its exact policy input before loading that wider graph.
  const primePolicy = existsSync(generator) ? `
    const { writeEmbeddedFeaturePolicies } = await import(${JSON.stringify(pathToFileURL(generator).href)});
    if (writeEmbeddedFeaturePolicies) await writeEmbeddedFeaturePolicies({ repoRoot: process.cwd() });
  ` : '';
  const code = `${primePolicy}
const { deriveRevisionGeneratedInputs } = await import(${JSON.stringify(entry)});
await deriveRevisionGeneratedInputs({ captureDir: process.cwd(), sourceDir: process.argv[1] });`;
  const child = spawn(process.execPath, ['--import', join(dir, 'packages/cli-common/registerSourceRuntime.mjs'),
    '--input-type=module', '-e', code, installDir],
  { cwd: dir, env: treeEnvironment(dir, env), signal, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1600); });
  const status = await waitForTreeChild(child);
  if (status !== 0) throw new Error(`tree generated inputs exited ${status}: ${stderr.trim()}`);
}

async function runTreeHarness({ dir, selected, env, signal }) {
  const code = `const { ENTRY_GRAPHS, loadEntryGraph } = await import(${JSON.stringify(pathToFileURL(join(dir, ENTRY_LOAD_PATH)).href)});
const ids = ${JSON.stringify(selected)};
for (const graph of ENTRY_GRAPHS.filter(graph => ids.includes(graph.id))) console.log('ENTRY_RESULT ' + JSON.stringify(await loadEntryGraph(graph)));`;
  // The tree is the commit: its packages load as they are, never through the checkout's HEAD pin.
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: treeEnvironment(dir, env), signal, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code_ = await waitForTreeChild(child);
  const results = stdout.split('\n').filter(line => line.startsWith('ENTRY_RESULT ')).map(line => JSON.parse(line.slice('ENTRY_RESULT '.length)));
  if (code_ !== 0 || results.length !== selected.length) {
    throw new Error(`tree entry-load harness exited ${code_} with ${results.length}/${selected.length} results: ${stderr.slice(-400)}`);
  }
  return results;
}

const SERVER_ROUTES_PROBE = `const [dir] = process.argv.slice(2);
const { createRequire } = await import('node:module');
const { join } = await import('node:path');
const requireFromServer = createRequire(join(dir, 'apps/server/package.json'));
const started = performance.now();
const result = { graph: '${SERVER_ROUTES_GRAPH}', entry: '${SERVER_ROUTES_ENTRY}' };
try {
  await import(join(dir, 'apps/server/sources/configureZodLocale.ts'));
  const { runLightServerMain } = await import(join(dir, 'apps/server/sources/flavors/light/main.ts'));
  await runLightServerMain(['--probe-runtime-import']);
  const { default: fastify } = await import(requireFromServer.resolve('fastify'));
  const { default: rateLimit } = await import(requireFromServer.resolve('@fastify/rate-limit'));
  const { registerApiRoutes } = await import(join(dir, '${SERVER_ROUTES_ENTRY}'));
  const { enableSchemaValidation } = await import(join(dir, 'apps/server/sources/app/api/utils/enableSchemaValidation.ts'));
  const { resolveApiRateLimitPluginOptions } = await import(join(dir, 'apps/server/sources/app/api/utils/apiRateLimitPolicy.ts'));
  const app = fastify({ logger: false });
  try {
    await app.register(rateLimit, resolveApiRateLimitPluginOptions(process.env));
    app.decorate('authenticate', async () => {});
    enableSchemaValidation(app);
    registerApiRoutes(app);
    await app.ready();
    Object.assign(result, { status: 'passed' });
  } finally { await app.close(); }
} catch (error) {
  Object.assign(result, { status: 'failed', firstFailingModule: '${SERVER_ROUTES_ENTRY}',
    loadError: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } });
}
console.log('ENTRY_RESULT ' + JSON.stringify({ ...result, elapsedMs: performance.now() - started }));
process.exit(0);`;

/** Composes the tree server's routes with the tree's own source runtime; the probe file lives inside the tree. */
async function runServerRoutes({ dir, env, signal }) {
  const { mkdtemp: makeTemp, writeFile } = await import('node:fs/promises');
  const home = await makeTemp(join(tmpdir(), 'commit-tree-routes-'));
  const probe = join(dir, 'apps/server/.commit-tree-route-probe.mjs');
  try {
    await writeFile(probe, SERVER_ROUTES_PROBE);
    const child = spawn(process.execPath, ['--import', join(dir, 'packages/cli-common/registerSourceRuntime.mjs'), probe, dir], {
      cwd: join(dir, 'apps/server'), signal, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...treeEnvironment(dir, env), TSX_TSCONFIG_PATH: join(dir, 'apps/server/tsconfig.json'), TSX_DISABLE_CACHE: '1',
        HAPPIER_HOME_DIR: home, HAPPIER_SERVER_LIGHT_DATA_DIR: home, HAPPIER_STACK_CLI_HOME_DIR: home } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await waitForTreeChild(child);
    const line = stdout.split('\n').find(entry => entry.startsWith('ENTRY_RESULT '));
    // A probe that dies before reporting failed to load the server's startup graph; the stderr names the cause.
    if (!line) {
      return { graph: SERVER_ROUTES_GRAPH, entry: SERVER_ROUTES_ENTRY, status: 'failed', elapsedMs: 0, firstFailingModule: SERVER_ROUTES_ENTRY,
        loadError: { name: 'Error', message: `route composition probe exited ${code}: ${stderr.trim().split('\n').filter(entry => !/^\s+at /.test(entry)).slice(-3).join(' | ')}` } };
    }
    return JSON.parse(line.slice('ENTRY_RESULT '.length));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Where standalone reports write a verdict, one JSON line per candidate. */
export function defaultCommitTreeLedger(repo) {
  return join(repo, '.project/tmp/commit-tree-gate/ledger.jsonl');
}

/**
 * A standalone diagnostic can run detached and write its verdict to the ledger. Trees without the
 * entry-load harness have nothing to load.
 */
function startCommitTreeEntryLoadReport({ repo, base, tree, label, ledger = defaultCommitTreeLedger(repo), env = process.env }) {
  try { gitAt(repo)(['cat-file', '-e', `${tree}:${ENTRY_GRAPHS_PATH}`]); } catch { return null; }
  mkdirSync(dirname(ledger), { recursive: true });
  const log = openSync(`${ledger}.log`, 'a');
  // A detached report owns its tree and can outlive the packet that launched it.
  const { P03_COMMIT_TREE_WORK_DIR: packetWork, P03_COMMIT_TREE_HOST_TMP: hostTmp, ...reportEnv } = env;
  if (packetWork) reportEnv.TMPDIR = hostTmp || '/tmp';
  const child = spawn(process.execPath, [self, '--report', '--repo', repo, '--base', base, '--tree', tree, '--label', label, '--ledger', ledger],
    { cwd: repo, env: reportEnv, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  return child.pid;
}

// Under `node -e '<importer>' <args>` argv[1] is an argument, not a path: compare only an existing file (a throw here
// broke every importer's load, gate.sh's textual step included).
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(self)) {
  const args = process.argv.slice(2);
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  if (args.includes('--entry-load-commit-session')) {
    const requests = createInterface({ input: process.stdin, crlfDelay: Infinity });
    stop.signal.addEventListener('abort', () => requests.close(), { once: true });
    process.stdout.write(`${ENTRY_LOAD_READY}\n`);
    try {
      for await (const line of requests) {
        const result = await compareSelectedEntryLoads(JSON.parse(line), process.env, stop.signal);
        process.stdout.write(`${ENTRY_LOAD_RESULT}${JSON.stringify(result)}\n`);
      }
    } catch (error) {
      console.error(`commit tree entry loads unavailable: ${error.message}`);
      process.exitCode = 75;
    } finally {
      requests.close();
    }
  } else if (args.includes('--entry-load-admitted')) {
    try {
      const request = JSON.parse(process.env.HAPPIER_COMMIT_ENTRY_LOAD_REQUEST);
      const result = await compareSelectedEntryLoads(request, process.env, stop.signal);
      process.stdout.write(`${ENTRY_LOAD_RESULT}${JSON.stringify(result)}\n`);
    } catch (error) {
      console.error(`commit tree entry loads unavailable: ${error.message}`);
      process.exitCode = 75;
    }
  } else {
    const option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
    const repo = resolve(option('repo') ?? process.cwd());
    const git = gitAt(repo);
    const base = git(['rev-parse', option('base') ?? 'HEAD']).toString().trim();
    const tree = git(['rev-parse', option('tree')]).toString().trim();
    if (args.includes('--select')) {
      const { selected } = await selectCommitTreeEntryGraphs({ repo, base, tree });
      if (selected.length) console.log(selected.join('\n'));
      process.exit(0);
    }
    const ledger = option('ledger') ?? defaultCommitTreeLedger(repo);
    const label = option('label') ?? 'manual';
    if (args.includes('--detach')) {
      const pid = startCommitTreeEntryLoadReport({ repo, base, tree, label, ledger });
      console.log(pid ? `commit tree entry loads: report started (pid ${pid}; ledger ${ledger})` : 'commit tree entry loads: the tree has no entry-load harness; nothing to report');
      process.exit(0);
    }
    const record = entry => { if (ledger) appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), label, base, tree, ...entry })}\n`); };
    try {
      const result = await commitTreeEntryLoads({ repo, base, tree, phase: args.includes('--post-commit') ? 'deferred' : 'report', installDir: resolve(option('install-dir') ?? repo), signal: stop.signal });
      for (const finding of result.findings) console.error(`tree entry load: ${finding}`);
      if (args.includes('--post-commit') && result.findings.length) {
        const [, graph, path] = /^([^:]+): (.*?): /u.exec(result.findings[0]) ?? [];
        console.log(`HAPPIER_POST_COMMIT_FAILURE\tEntry load (${graph})\t${path ?? ''}`);
      }
      for (const finding of result.preexisting) console.error(`tree entry load (also fails at the base): ${finding}`);
      console.log(`commit tree entry loads: ${result.selected.length}/${result.graphs} graph(s), ${result.findings.length} failure(s), ${JSON.stringify(result.timings)}`);
      record({ verdict: result.findings.length ? 'would-refuse' : 'pass', selected: result.selected, findings: result.findings, preexisting: result.preexisting, results: result.results, timings: result.timings });
      process.exitCode = result.findings.length ? (args.includes('--post-commit') ? 10 : 1) : 0;
    } catch (error) {
      console.error(`commit tree entry loads unavailable: ${String(error?.stack ?? error).slice(0, 800)}`);
      record({ verdict: 'unavailable', error: String(error?.message ?? error).slice(0, 400) });
      process.exitCode = 75;
    }
  }
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
