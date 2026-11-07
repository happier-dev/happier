// CLI startup measurement, using only temporary homes and a synthetic Home.
// Run through hstack-exec; no Stack, database, or real credential is opened.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadavg, cpus, freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const phase = process.argv[2] ?? 'baseline';
const evidenceRoot = process.env.CLISTART_OUTPUT_ROOT ?? join('/tmp', 'perf-e2e/CLISTART');
await mkdir(evidenceRoot, { recursive: true });
const root = await mkdtemp(join(evidenceRoot, `${phase}-`));
const repeats = Number(process.env.CLISTART_REPEATS ?? 5);
const plain = process.env.CLISTART_PLAIN === '1';
const interactive = process.env.CLISTART_CREDENTIAL === 'interactive';
const token = interactive ? 'interactive' : `hap_v1_11111111-1111-4111-8111-111111111111_${'a'.repeat(43)}`;
const fixture = { v: 1, encryptionMode: 'plain', nativeEmail: null,
  password: { status: 'not_enrolled', revision: null } };
let activeRequests = [];
const server = createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${token}`;
  activeRequests.push({ time: performance.now(), method: req.method, path: req.url, authorized });
  res.setHeader('content-type', 'application/json');
  const security = authorized && req.method === 'GET' && req.url === '/v1/account/security';
  const features = interactive && authorized && req.method === 'GET' && req.url === '/v1/features/authenticated';
  res.statusCode = security || features ? 200 : interactive ? 404 : 403;
  res.end(JSON.stringify(security ? fixture : features ? {
    features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
  } : { error: 'not_found' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const probe = join(repo, 'apps/stack/scripts/perf/cli-startup-probe.cjs');
const results = [];
const envBase = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !/^(?:HAPPIER|HAPPY|HSTACK|NODE_OPTIONS|TSX_)/u.test(key)
)));

async function run(runtime, command, args, index, profile = false) {
  const home = await mkdtemp(join(root, 'home-'));
  // A synthetic signed-in home exposes unwanted credential/security reads on
  // local commands. The bearer is accepted only by this loopback fixture.
  await mkdir(join(home, 'servers/cloud'), { recursive: true });
  await writeFile(join(home, 'servers/cloud/access.key'), JSON.stringify({ token }));
  if (interactive) {
    // Use the canonical writer outside the measured process; the resulting
    // stored-session provenance must reach the shared Action admission path.
    const seed = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      'const { writeCredentialsTokenOnly } = await import("./src/persistence.ts"); await writeCredentialsTokenOnly({ token: "interactive" });'], {
      cwd: join(repo, 'apps/cli'), env: { ...envBase, HAPPIER_HOME_DIR: home,
        HAPPIER_SERVER_URL: baseUrl, HAPPIER_API_SERVER_URL: baseUrl }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let failure = '';
    seed.stderr.on('data', chunk => { failure += chunk; });
    const status = await new Promise((resolve, reject) => {
      seed.once('error', reject);
      seed.once('close', resolve);
    });
    if (status !== 0) throw new Error(`Interactive fixture admission failed (${status}): ${failure.slice(-1500)}`);
  }
  const trace = join(root, `${runtime}-${command}-${index}${profile ? '-profile' : ''}.json`);
  let agentHelpEnv = {};
  if (command === 'agent-help') {
    const shim = join(home, 'native-help.mjs');
    await writeFile(shim, '#!/usr/bin/env node\nconsole.log("Native help fixture " + JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    agentHelpEnv = { HAPPIER_CODEX_PATH: shim, HAPPIER_JS_RUNTIME_PATH: process.execPath };
  }
  activeRequests = [];
  const start = performance.now();
  const nodeArgs = [...(plain ? [] : ['--require', probe]),
    ...(profile ? ['--cpu-prof', `--cpu-prof-dir=${root}`, `--cpu-prof-name=${runtime}-${command}.cpuprofile`] : []),
    ...(runtime === 'source' ? ['--import', 'tsx', 'src/index.ts'] : [process.env.CLISTART_BUNDLE]), ...args];
  const child = spawn(process.execPath, nodeArgs, { cwd: join(repo, 'apps/cli'), env: { ...envBase,
    HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: baseUrl, HAPPIER_API_SERVER_URL: baseUrl,
    ...(interactive ? {} : { HAPPIER_TOKEN: token }),
    ...agentHelpEnv,
    CLISTART_TRACE: trace, CLISTART_IMPORT_TRACE: profile || phase === 'contract' ? '1' : '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let elapsedMs;
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => { elapsedMs = performance.now() - start; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stdoutPath = join(root, `${runtime}-${command}-${index}${profile ? '-profile' : ''}.stdout`);
  await writeFile(stdoutPath, stdout);
  const data = plain ? { events: [], modules: [] } : JSON.parse(await readFile(trace, 'utf8'));
  const firstRequest = data.events.find(event => event.kind === 'http:request');
  const securityRead = command === 'security' ? JSON.parse(stdout.trim()) : null;
  const row = { runtime, command, index, profile, plain, ...exit, elapsedMs,
    firstRequestMs: firstRequest?.ms ?? null,
    serverFirstRequestMs: activeRequests[0] ? activeRequests[0].time - start : null,
    requests: activeRequests.map(req => ({ ...req, ms: req.time - start, time: undefined })),
    preloadMs: data.events[0]?.ms ?? null,
    modules: plain ? null : data.modules.length,
    pluginModules: data.modules.filter(path => /packages\/plugins\/|@happier-dev\/plugins-/u.test(path)),
    scripts: data.events.filter(event => event.kind === 'script:parsed').map(event => event.url),
    trace: plain ? null : trace, stdoutPath, valid: exit.code === 0 && (command !== 'security' || securityRead?.ok === true),
    ...(exit.code === 0 ? {} : { stderr: stderr.slice(-2500), stdout: stdout.slice(-500) }) };
  results.push(row);
  const { scripts, pluginModules, ...projection } = row;
  console.log(JSON.stringify({ ...projection, scriptCount: plain ? null : scripts.length, pluginModuleCount: plain ? null : pluginModules.length }));
}

try {
  const runtimes = process.env.CLISTART_BUNDLE_ONLY === '1' ? ['bundle']
    : ['source', ...(process.env.CLISTART_BUNDLE ? ['bundle'] : [])];
  for (const runtime of runtimes) {
    const commands = [['noop', ['--version']], ['help', ['--help']], ['security', ['auth', 'security', 'get', '--json']]];
    if (process.env.CLISTART_COMMAND === 'provider-help') commands.push(['provider-help', ['provider', '--help']]);
    if (process.env.CLISTART_COMMAND === 'agent-help') commands.push(['agent-help', ['codex', '--help']]);
    for (const [name, args] of commands) {
      if (process.env.CLISTART_COMMAND && process.env.CLISTART_COMMAND !== name) continue;
      for (let i = 0; i < repeats; i++) await run(runtime, name, args, i);
      if (phase !== 'contract' && !plain) await run(runtime, name, args, 'cpu', true);
    }
  }
  const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const groups = [...new Set(results.map(row => `${row.runtime}/${row.command}`))].map(key => {
    const rows = results.filter(row => `${row.runtime}/${row.command}` === key && !row.profile);
    return { key, n: rows.length, valid: rows.every(row => row.valid),
      elapsedP50: quantile(rows.map(row => row.elapsedMs), .5), elapsedP95: quantile(rows.map(row => row.elapsedMs), .95),
      firstRequestP50: quantile(rows.map(row => row.firstRequestMs).filter(ms => ms !== null), .5) ?? null,
      firstRequestP95: quantile(rows.map(row => row.firstRequestMs).filter(ms => ms !== null), .95) ?? null,
      serverFirstRequestP50: quantile(rows.map(row => row.serverFirstRequestMs).filter(ms => ms !== null), .5) ?? null,
      serverFirstRequestP95: quantile(rows.map(row => row.serverFirstRequestMs).filter(ms => ms !== null), .95) ?? null,
      requests: rows.map(row => row.requests.length), modules: rows.map(row => row.modules) };
  });
  await writeFile(join(root, 'results.json'), JSON.stringify({ phase, host: { loadavg: loadavg(), cpus: cpus().length, free: freemem() }, results, groups }, null, 2));
  console.log(JSON.stringify({ root, groups }));
  if (results.some(row => !row.valid)) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
}
