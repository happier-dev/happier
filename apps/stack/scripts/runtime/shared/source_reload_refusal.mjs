import { join } from 'node:path';
import { ENTRY_GRAPHS, loadEntryGraph } from '../../perf/entry-load.mjs';
import { describeRuntimeImportFailure } from '../../utils/proc/runtimeImportProbe.mjs';
import { redactFailureDiagnostic } from '../../utils/proc/proc.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';

const refusalPrefix = 'HSTACK_SOURCE_RELOAD_REFUSAL=';
const componentGraphs = Object.freeze({ daemon: 'daemon', cli: 'cli', server: 'server', ui: 'ui-catalog', expo: 'ui-catalog', sdk: 'sdk-browser' });

/** @typedef {{component?: string, entryGraph?: string, firstFailingModule?: string,
 * code?: string|number, phase?: string, retryable?: boolean, sourceStack?: string,
 * reason?: string, nextAction?: string, missingMigrations?: string[], failedMigration?: string}} SourceReloadRefusal */

function publicIdentifier(value, env) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value)
    && redactFailureDiagnostic(value, env) === value ? value : undefined;
}

/** Only identifier facts cross the existing worker transport, never error payloads. */
export function readSourceReloadRefusal(error, env = process.env) {
  if (!error || typeof error !== 'object') return {};
  /** @type {SourceReloadRefusal} */
  const refusal = {};
  for (const field of ['component', 'entryGraph', 'firstFailingModule', 'phase', 'sourceStack', 'failedMigration', 'reason', 'nextAction']) {
    const value = publicIdentifier(error[field], env);
    if (value) refusal[field] = value;
  }
  if (typeof error.code === 'string' || Number.isInteger(error.code)) refusal.code = error.code;
  if (typeof error.retryable === 'boolean') refusal.retryable = error.retryable;
  if (Array.isArray(error.missingMigrations)) {
    refusal.missingMigrations = error.missingMigrations.map(value => publicIdentifier(value, env)).filter(Boolean);
  }
  return refusal;
}

export function parseSourceReloadRefusalLine(line, env = process.env) {
  if (!line.startsWith(refusalPrefix)) return null;
  try { return readSourceReloadRefusal(JSON.parse(line.slice(refusalPrefix.length)), env); }
  catch { return null; }
}

export function emitSourceReloadRefusal(error, env = process.env) {
  const refusal = readSourceReloadRefusal(error, env);
  if (refusal.entryGraph || refusal.sourceStack || refusal.failedMigration) {
    process.stderr.write(refusalPrefix + JSON.stringify(refusal) + '\n');
  }
}

/** Failure-only reuse of check:entry-loads; an existing compiler location wins. */
export async function diagnoseSourceReloadFailure(error, { component, repoDir, signal, diagnostic, env = process.env } = {}) {
  if (!error || typeof error !== 'object' || signal?.aborted || error.name === 'AbortError' || error.signal) return error;
  if (error.sourceStack || error.missingMigrations || error.failedMigration
    || String(error.code ?? '').startsWith('ERUNTIMESERVERMIGRATION')) return error;
  if (error.entryGraph) return error;
  const graph = ENTRY_GRAPHS.find(graph => graph.id === componentGraphs[component]);
  if (!graph) return error;
  const transported = String(diagnostic ?? error.message ?? '').split('\n')
    .map(line => parseSourceReloadRefusalLine(line, env)).find(value => value?.entryGraph);
  if (transported) { Object.assign(error, transported); return error; }
  const importFailure = describeRuntimeImportFailure(String(diagnostic ?? error.message ?? ''));
  if (typeof error.code !== 'string' && importFailure.loadError.code) error.code = importFailure.loadError.code;
  let firstFailingModule = error.firstFailingModule ?? error.errors?.find(item => item.location?.file)?.location.file
    ?? error.cause?.firstFailingModule
    ?? importFailure.firstFailingModule;
  if (!firstFailingModule && repoDir) {
    try {
      const loaded = await loadEntryGraph(graph, { repoDir, signal });
      if (loaded.status === 'failed') firstFailingModule = loaded.firstFailingModule;
    } catch (diagnostic) {
      if (signal?.aborted) throw signal.reason;
      console.error(`[reload] ${graph.id} entry diagnostic unavailable; original refusal retained (${redactFailureDiagnostic(String(diagnostic?.code ?? diagnostic?.name ?? 'Error'), env)})`);
    }
  }
  Object.assign(error, readSourceReloadRefusal({ component, entryGraph: graph.id, firstFailingModule }, env));
  return error;
}

export function formatSourceReloadRefusal(error, env = process.env) {
  const refusal = readSourceReloadRefusal(error, env);
  return Object.entries(refusal).map(([field, value]) => ` ${field}=${JSON.stringify(value)}`).join('');
}

/** The existing reload record is also visible while preparation waits for an edit. */
export async function recordSourceReloadRefusal({ stackBaseDir, error, env = process.env, logPath }) {
  if (!stackBaseDir) return;
  try {
    const path = join(stackBaseDir, 'source-runtime/reload.json');
    const previous = await readJsonIfExists(path);
    await writeJsonAtomic(path, { status: 'failed',
      message: redactFailureDiagnostic(error instanceof Error ? error.message : String(error), env),
      ...readSourceReloadRefusal(error, env), ...(logPath ?? previous?.logPath ? { logPath: logPath ?? previous.logPath } : {}) });
  } catch (diagnostic) {
    // Diagnostic storage cannot replace the compiler/database refusal it reports.
    console.error('[reload] failure diagnostic publication failed:', redactFailureDiagnostic(String(diagnostic?.message ?? diagnostic), env));
  }
}

/** Only a successful component launch resolves that component's last refusal. */
export async function recordSourceReloadRecovery({ stackBaseDir, component, env = process.env }) {
  if (!stackBaseDir) return;
  try {
    const path = join(stackBaseDir, 'source-runtime/reload.json');
    const previous = await readJsonIfExists(path);
    if (previous?.status !== 'failed' || previous.component !== component) return;
    await writeJsonAtomic(path, { status: 'ready', ...(previous.logPath ? { logPath: previous.logPath } : {}) });
  } catch (diagnostic) {
    // Diagnostic storage cannot turn a successful launch into a startup failure.
    console.error('[reload] recovery diagnostic publication failed:', redactFailureDiagnostic(String(diagnostic?.message ?? diagnostic), env));
  }
}
