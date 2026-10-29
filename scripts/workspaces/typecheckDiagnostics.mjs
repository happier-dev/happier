import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { compilerDiagnosticFromLine } from '../testing/lib/compilerBaseline.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { typecheckCompilerOptions } from './resolveTypeScriptCliInvocation.mjs';

const execute = promisify(execFile);
const portable = value => value.replaceAll('\\', '/');
const location = row => `${row.line}:${row.column}:${row.code}`;
const inside = value => value !== '..' && !value.startsWith('../') && !isAbsolute(value);
const introspection = new Set(['--explainfiles', '--listfiles', '--listfilesonly', '--traceresolution', '--diagnostics', '--extendeddiagnostics']);

class DiagnosticSnapshotError extends Error {
  constructor(step, cause) {
    super('Typecheck diagnostic snapshot failed', { cause });
    this.step = step;
    this.code = cause?.code;
  }
}

export function typecheckDiagnosticFailureIdentifier(error, fallbackStep) {
  const step = error instanceof DiagnosticSnapshotError ? error.step : fallbackStep;
  const code = Number.isInteger(error?.code) ? `EXIT_${error.code}`
    : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : 'UNKNOWN';
  return `${step}:${code}`;
}

async function diagnosticStep(step, operation) {
  try { return await operation(); }
  catch (error) { throw new DiagnosticSnapshotError(step, error); }
}

async function gitPaths(args, cwd) {
  // Worker replicas can expose the entire UI tree as untracked. Stream NUL
  // records instead of imposing execFile's default 1 MiB output ceiling.
  const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const paths = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    const records = (pending + chunk).split('\0');
    pending = records.pop();
    for (const path of records) if (path) paths.push(portable(path));
  });
  await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.stdout.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === 0) resolveExit();
      else reject(Object.assign(new Error('Git path inventory failed'), { code: signal ?? status }));
    });
  });
  if (pending) paths.push(portable(pending));
  return paths;
}

async function packageRoot(config, root) {
  let directory = dirname(config);
  while (inside(portable(relative(root, directory)))) {
    try {
      await readFile(resolve(directory, 'package.json'));
      return directory;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
}

async function readSnapshot(path, projects) {
  let snapshot;
  try { snapshot = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return;
  }
  if (JSON.stringify(snapshot?.projects) === JSON.stringify(projects)
    && snapshot?.diagnosticsByPath && typeof snapshot.diagnosticsByPath === 'object'
    && Object.values(snapshot.diagnosticsByPath).every(rows => Array.isArray(rows) && rows.every(row =>
      row && [row.line, row.column, row.code].every(value => Number.isSafeInteger(value) && value > 0)))) return snapshot;
}

function collectDiagnostics(results, cwd, repoRoot) {
  const diagnosticsByPath = Object.create(null);
  const locations = new Set();
  const globalDiagnostics = new Set();
  for (const result of results) {
    if (result.error || result.signal || ![0, 1, 2].includes(result.status)) return;
    let recognized = 0;
    let continuation = false;
    // Admission owns stderr too. Read diagnostic headers from both streams,
    // but only the compiler's stdout has a diagnostic-only format.
    for (const [stream, text] of [['stdout', result.stdout ?? ''], ['stderr', result.stderr ?? '']]) {
      for (const line of text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').split(/\r?\n/u)) {
        if (!line.trim()) continue;
        const row = compilerDiagnosticFromLine(line, cwd, repoRoot);
        if (row) {
          const key = `${row.file}:${location(row)}`;
          if (!locations.has(key)) {
            locations.add(key);
            (diagnosticsByPath[row.file] ??= []).push({ line: row.line, column: row.column, code: row.code });
          }
          recognized += 1;
          continuation = true;
        } else if (/^error TS\d+:/u.test(line)) {
          globalDiagnostics.add(line);
          recognized += 1;
          continuation = true;
        } else if (stream === 'stdout' && (!/^\s/u.test(line) || !continuation)) {
          return;
        }
      }
    }
    if ((result.status === 0) !== (recognized === 0)) return;
  }
  return { diagnosticsByPath, globalDiagnostics };
}

export function isCompleteTypecheckDiagnosticResult(result, cwd = process.cwd()) {
  return Boolean(collectDiagnostics([result], cwd, parse(cwd).root));
}

// This is an observation of the previous completed invocation, never a compiler
// allowance or a package-green verdict. Interrupted/partial runs don't replace it.
export async function createTypecheckDiagnosticRun({ projects, producers = [], cwd = process.cwd(), repoRoot } = {}) {
  const groups = new Map();
  const projectGroups = new Map();
  const producerResults = new Map();
  for (const project of projects) {
    const args = project.authoredArgs;
    if (args.some(arg => introspection.has(arg.toLowerCase()))) continue;
    const options = typecheckCompilerOptions(args, cwd);
    if (options?.noEmit !== true || !options.configFilePath) continue;
    if (!repoRoot) {
      try { repoRoot = (await execute('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim(); }
      catch { break; } // External author projects without Git still compile normally.
    }
    const root = await packageRoot(options.configFilePath, repoRoot);
    if (!root) continue;
    let group = groups.get(root);
    if (!group) {
      const path = resolve(root, 'node_modules/.cache/typecheck/diagnostics.json');
      group = { root, path, projects: [], results: new Map() };
      groups.set(root, group);
    }
    group.projects.push(portable(relative(repoRoot, options.configFilePath)));
    projectGroups.set(project, group);
  }
  return {
    enabled: groups.size > 0,
    record(project, result) {
      if (producers.includes(project)) producerResults.set(project, result);
      else projectGroups.get(project)?.results.set(project, result);
    },
    async publish() {
      const reports = [];
      for (const group of groups.values()) {
        if (group.results.size !== group.projects.length || producerResults.size !== producers.length) continue;
        const collected = collectDiagnostics([...producerResults.values(), ...group.results.values()], cwd, repoRoot);
        if (!collected) continue;
        const { diagnosticsByPath, globalDiagnostics } = collected;
        const completion = [...producerResults.values()].some(result => result.status > 0)
          ? 'complete with producer diagnostics' : 'complete';
        const projects = [...group.projects].sort();
        const packagePath = portable(relative(repoRoot, group.root)) || '.';
        let previous = await diagnosticStep('snapshot-read', () => readSnapshot(group.path, projects));
        let baselineSource = previous ? 'local' : undefined;
        if (!previous) {
          const referencePath = `.project/plans/2026-10-17-coordination/qa/baselines/${packagePath === '.' ? 'root' : basename(group.root)}.json`;
          previous = await diagnosticStep('reference-read', () => readSnapshot(resolve(repoRoot, referencePath), projects));
          if (previous) baselineSource = `reference ${referencePath}`;
        }
        const baseline = Boolean(previous);
        // Git describes the checkout actually compiled. A replica may include
        // more untracked paths than the controller; attribution is conservative:
        // those extra paths cannot hide a newly introduced diagnostic.
        const touched = new Set([
          ...await diagnosticStep('git-diff', () => gitPaths(['diff', '--name-only', '-z', 'HEAD'], repoRoot)),
          ...await diagnosticStep('git-untracked', () => gitPaths(['ls-files', '--others', '--exclude-standard', '-z', '--', packagePath], repoRoot)),
        ]);
        let newInTouchedPaths = 0;
        let total = 0;
        for (const [file, rows] of Object.entries(diagnosticsByPath)) {
          total += rows.length;
          if (!baseline || !touched.has(file)) continue;
          const old = new Set((previous.diagnosticsByPath[file] ?? []).map(location));
          newInTouchedPaths += rows.filter(row => !old.has(location(row))).length;
        }
        await diagnosticStep('snapshot-write', () => writeJsonAtomic(group.path, { projects, diagnosticsByPath, globalDiagnostics: globalDiagnostics.size }));
        reports.push({ package: packagePath, path: group.path, baseline, baselineSource, completion,
          newInTouchedPaths: baseline ? newInTouchedPaths : null, total, globalDiagnostics: globalDiagnostics.size });
      }
      return reports;
    },
  };
}
