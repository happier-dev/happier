import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { compilerDiagnosticFromLine } from '../testing/lib/compilerBaseline.mjs';
import { appendBoundedTail, redactFailureDiagnostic, spawnForegroundCommand } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { resolvePnpmCommandInvocation } from './execPnpmCommand.mjs';
import { shouldRouteTypeScriptCliThroughHstack } from './resolveTypeScriptCliInvocation.mjs';
import { compareTouchedTypecheckLocations } from './typecheckDiagnostics.mjs';

const portable = value => value.replaceAll('\\', '/');
const location = /^(.+):(\d+):TS(\d+)$/u;
const marker = '[typecheck-locations] ';
// Compiler prose can quote source fixtures. Retain only executor, package-manager
// and runner reason lines, using the process owner's redaction and tail budget.
const executorReason = /^(?:\[typecheck-(?:failure|delta|inputs)\]|(?:ERR_PNPM_[A-Z_]+|\[?ELIFECYCLE\]?)(?:[:\s]|$)|\[(?:preferred-execution|execution-host)\]|HSTACK_[A-Z_]+(?:[:\s]|$)|(?:ssh(?:_[a-z_]+)?|client_loop|kex_exchange_identification|packet_write_wait|mux_client_[a-z_]+|hstack-dev-target-control):|(?:Shared connection|Connection) to |Connection (?:reset |closed )|Read from remote host |Received disconnect from |Disconnected from |Timeout, server )/u;

export async function readSharedTypecheckBaseline(repoRoot, packagePath, baselinePath) {
  if (!baselinePath) throw new Error('an explicit --baseline path is required');
  const path = resolve(repoRoot, baselinePath);
  const contents = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') throw new Error('shared typecheck baseline unavailable');
    throw error;
  });
  const locations = new Set();
  for (const line of contents.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const compact = location.exec(line);
    let diagnostic;
    try {
      const header = compact
        ? `${compact[1]}(${compact[2]},1): error TS${compact[3]}: location`
        : `${line}: location`;
      // Current inventories use repository-relative paths. Retain the older
      // package-relative CLI/server inventories only when their source exists.
      for (const cwd of [repoRoot, resolve(repoRoot, packagePath)]) {
        let candidate;
        try { candidate = compilerDiagnosticFromLine(header, cwd, repoRoot); }
        catch { continue; } // A legacy ../ path can be outside the repo at its root.
        if (!candidate) continue;
        const source = await stat(resolve(repoRoot, candidate.file)).catch(error => {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
          throw error;
        });
        if (source?.isFile()) {
          diagnostic = candidate;
          break;
        }
      }
    } catch { throw new Error('invalid shared typecheck baseline'); }
    if (!diagnostic) throw new Error('invalid shared typecheck baseline');
    locations.add(`${diagnostic.file}:${diagnostic.line}:TS${diagnostic.code}`);
  }
  return { path, locations: [...locations].sort() };
}

export async function runTouchedTypecheck({ repoRoot, packagePath, paths, baselinePath }) {
  const normalizedPackage = portable(relative(repoRoot, resolve(repoRoot, portable(packagePath))));
  const selected = paths.map(path => portable(relative(repoRoot, resolve(repoRoot, portable(path)))));
  if (!normalizedPackage || [normalizedPackage, ...selected].some(path => !path || path === '..' || path.startsWith('../') || isAbsolute(path))) {
    throw new Error('package and touched paths must be inside the repository');
  }
  const manifest = JSON.parse(await readFile(resolve(repoRoot, normalizedPackage, 'package.json'), 'utf8'));
  if (!manifest.scripts?.typecheck || !selected.length) throw new Error('a package typecheck and explicit touched paths are required');
  const baseline = await readSharedTypecheckBaseline(repoRoot, normalizedPackage, baselinePath);
  process.stdout.write(`baseline: ${portable(relative(repoRoot, baseline.path))}\n`);
  const started = performance.now();
  // Resolve the prepared host tool, never a controller's absolute npm_execpath.
  const pnpm = resolvePnpmCommandInvocation(['--dir', normalizedPackage, 'run', 'typecheck'], { preferPath: true });
  const routed = process.platform !== 'win32' && shouldRouteTypeScriptCliThroughHstack({ args: [], env: process.env });
  const command = routed ? resolve(repoRoot, 'apps/stack/bin/hstack-exec') : pnpm.command;
  const args = routed ? ['--', 'env', 'HAPPIER_TYPECHECK_LOCATIONS_ONLY=1', pnpm.command, ...pnpm.args] : pnpm.args;
  const child = spawnForegroundCommand(command, args, { cwd: repoRoot, ownedProcessGroup: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HAPPIER_TYPECHECK_LOCATIONS_ONLY: '1' },
    ...(pnpm.windowsVerbatimArguments && !routed ? { windowsVerbatimArguments: pnpm.windowsVerbatimArguments } : {}) });
  const reports = [];
  let malformed = false;
  let executionTarget;
  let stderrTail = '';
  const readers = [child.stdout, child.stderr].map(stream => {
    const reader = createInterface({ input: stream });
    reader.on('line', line => {
      const placement = /^\[preferred-execution\] selected ([A-Za-z0-9_-]+) \(/u.exec(line);
      if (placement) executionTarget = placement[1];
      const reasonLine = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').trimStart();
      if (executorReason.test(reasonLine)) {
        // Redact before bounding so clipping cannot remove a secret's label.
        stderrTail = appendBoundedTail(stderrTail, `${redactFailureDiagnostic(reasonLine, process.env)}\n`);
      }
      if (!line.startsWith(marker)) return;
      try {
        const report = JSON.parse(line.slice(marker.length));
        if (report.package === normalizedPackage) reports.push(report);
      } catch { malformed = true; }
    });
    return new Promise(resolveReader => reader.once('close', resolveReader));
  });
  const result = await new Promise(resolveResult => {
    child.once('error', error => resolveResult({ status: null, signal: null, error }));
    child.once('close', (status, signal) => resolveResult({ status, signal }));
  });
  await Promise.all(readers);
  const elapsedMs = Math.round(performance.now() - started);
  process.stdout.write(`package typecheck: exit=${result.status ?? 'unavailable'} signal=${result.signal ?? 'none'} wallMs=${elapsedMs} target=${executionTarget ?? 'current'}\n`);
  if (result.error || result.signal || ![0, 1, 2].includes(result.status) || malformed || !reports.length) {
    process.stderr.write('touched delta unavailable: no complete package diagnostic result\n');
    if (result.error) process.stderr.write(`package launch: ${redactFailureDiagnostic(result.error.code ?? result.error.name, process.env)}\n`);
    if (stderrTail) process.stderr.write(`package typecheck failure (redacted tail):\n${stderrTail}`);
    return 2;
  }
  const globalDiagnostics = reports.reduce((total, report) => total + report.globalDiagnostics, 0);
  if (globalDiagnostics) {
    process.stderr.write(`touched delta unavailable: ${globalDiagnostics} global compiler diagnostics\n`);
    return 2;
  }
  const delta = compareTouchedTypecheckLocations({ baseline: baseline.locations,
    current: reports.flatMap(report => report.locations), paths: selected });
  for (const [label, rows] of Object.entries(delta)) {
    process.stdout.write(`${label}: ${rows.length}\n`);
    for (const row of rows) process.stdout.write(`  ${row}\n`);
  }
  return delta.added.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const baselinePath = args[0] === '--baseline' ? args.splice(0, 2)[1] : undefined;
  try {
    process.exitCode = await runTouchedTypecheck({ repoRoot: fileURLToPath(new URL('../../', import.meta.url)),
      packagePath: args[0] ?? '', paths: args.slice(1), baselinePath });
  } catch (error) {
    // Compiler/source prose can contain fixture data. Publish locations only.
    const known = ['an explicit --baseline path is required', 'shared typecheck baseline unavailable', 'invalid shared typecheck baseline',
      'package and touched paths must be inside the repository', 'a package typecheck and explicit touched paths are required'];
    const reason = known.includes(error.message) ? error.message : 'check the package, paths and shared baseline';
    process.stderr.write(`touched delta unavailable: ${reason}\n`);
    process.exitCode = 2;
  }
}
