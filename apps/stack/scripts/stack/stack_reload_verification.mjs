import { projectStackReloadVerification } from './reload_verdict.mjs';

/**
 * Run one retained-runtime CLI command and return its JSON envelope of `kind`.
 * The wrapper selects the Stack's auth home and daemon host. The child process
 * is the boundary `run` stands for; null means the command printed no envelope.
 */
export async function runRetainedRuntimeCli({ rootDir, stackName, args, kind, run, input, runtimeMode, timeoutMs }) {
  const { join } = await import('node:path');
  const runCli = run ?? (await import('../utils/proc/proc.mjs')).runCaptureResult;
  // Bare `--runtime` selects the built runtime snapshot; a source stack runs its retained source bundle.
  const runtimeFlag = runtimeMode === 'source-snapshot' ? '--runtime=source' : '--runtime';
  // `input` is the child's stdin (e.g. `--secrets-json-stdin`), never argv.
  const result = await runCli(process.execPath, [join(rootDir, 'scripts/stack.mjs'),
    'happier', stackName, runtimeFlag, '--', ...args, '--json'], { cwd: rootDir, env: process.env, ...(input == null ? {} : { input }),
    ...(timeoutMs == null ? {} : { timeoutMs }) });
  let found = null;
  for (const line of result.out.split(/\r?\n/)) {
    try {
      const envelope = JSON.parse(line);
      if (envelope?.kind === kind) found = result.ok === true ? envelope : { ...envelope, ok: false };
    } catch { /* The CLI owner may print preparation diagnostics before its envelope. */ }
  }
  return found;
}

/** Sanitized: only owner codes leave the envelope, never messages or child logs. */
function readAgentProbeFailure(phase, envelope) {
  const code = envelope?.error?.code;
  const launchErrorCode = envelope?.error?.launchError?.code;
  return { status: 'failed', phase, code: typeof code === 'string' ? code : null,
    ...(typeof launchErrorCode === 'string' ? { launchErrorCode } : {}) };
}

/**
 * Start one real Agent child through the daemon's Session host, runner and
 * attach (the same `session create` path QA uses), then stop and archive it
 * through the canonical Session owners. No prompt is sent, so no model turn runs.
 */
export async function probeStackAgentStart({ rootDir, stackName, runtimeMode, machineId, run, remainingMs }) {
  const cli = (args, kind) => runRetainedRuntimeCli({ rootDir, stackName, args, kind, run, runtimeMode, timeoutMs: remainingMs?.() });
  // The inventory owner composes Machine and connected-account readiness.
  const inventory = await cli(['actions', 'invoke', 'agents.backends.list', '--input-json',
    JSON.stringify({ machineId })], 'actions_invoke');
  if (inventory?.ok !== true) return readAgentProbeFailure('inventory', inventory);
  const target = inventory.data?.items?.find(item => item.enabled === true && item.readiness === 'ready');
  if (!target) return readAgentProbeFailure('inventory', { error: { code: 'agent_cli_not_ready' } });
  const created = await cli(['session', 'create', '--backend', target.targetKey,
    '--machine-id', machineId, '--title', 'Stack readiness probe'], 'session_create');
  const sessionId = created?.ok === true ? created.data?.session?.id : null;
  if (typeof sessionId !== 'string' || !sessionId) return readAgentProbeFailure('create', created);
  const stopped = await cli(['session', 'stop', sessionId], 'session_stop');
  if (stopped?.ok !== true) return readAgentProbeFailure('stop', stopped);
  const archived = await cli(['session', 'archive', sessionId], 'session_archive');
  if (archived?.ok !== true) return readAgentProbeFailure('archive', archived);
  return { status: 'ready' };
}

/** The reload record this start wrote (source-runtime/reload.json): fresh only when written after `startedAt`.
 * Its per-component captures name the revision each prepared component came from. */
export async function readThisReloadRecord({ stackBaseDir, startedAt }) {
  if (!stackBaseDir) return null;
  const { readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = join(stackBaseDir, 'source-runtime', 'reload.json');
  try {
    const [record, info] = await Promise.all([readFile(path, 'utf8').then(JSON.parse), stat(path)]);
    return { status: record?.status ?? null, fresh: info.mtimeMs >= startedAt, sourceCaptures: record?.sourceCaptures ?? {} };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Start retains lifecycle/wait authority; verification observes its settled result. */
export async function runVerifiedStackStart({ rootDir, stackName, scriptPath, args }) {
  if (args.includes('--json')) throw new Error('[stack] --verify cannot be combined with the --json dry run');
  const startedAt = Date.now();
  let check = 'baseline';
  let beforeManagedCli = null;
  try {
    const { readStackInfoSnapshot } = await import('./stack_info_snapshot.mjs');
    // A broken incumbent cannot provide a baseline; start remains the repair owner.
    const before = await readStackInfoSnapshot({ rootDir, stackName }).catch(() => null);
    beforeManagedCli = before?.runtime?.managedCli ?? null;
    check = 'start';
    const { runStackScriptWithStackEnv } = await import('./run_script_with_stack_env.mjs');
    const start = await runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args, background: true });
    check = 'observation';
    const info = await readStackInfoSnapshot({ rootDir, stackName });
    if (start?.readiness === 'pending') {
      return { ...projectStackReloadVerification({ info, beforeManagedCli, start }), durationMs: Date.now() - startedAt };
    }
    return await verifyStartedStack({ rootDir, stackName, info, beforeManagedCli, startedAt });
  } catch (error) {
    // Never expose command output, auth envelopes or environment values in a verdict.
    return { ...projectStackReloadVerification({ beforeManagedCli, failure: { check, error } }), durationMs: Date.now() - startedAt };
  }
}

/** The started Stack's probes, in order, each settling the verdict at the first check that fails. They run inside the
 * start's own readiness budget: a probe that never answers (a UI that never sends its first API request, a CLI that
 * never prints its envelope) settles NOT_READY at its check instead of holding the verify, and a QA green check's lock,
 * forever (P03-QA-TRAIN-2). */
export async function verifyStartedStack({ rootDir, stackName, info, beforeManagedCli, startedAt, run, smokeWebBoot }) {
  let check = 'daemon_tree';
  const { resolveBackgroundReadyTimeoutMs } = await import('./run_script_with_stack_env.mjs');
  const budgetMs = resolveBackgroundReadyTimeoutMs(process.env);
  const budget = AbortSignal.timeout(budgetMs);
  const deadline = Date.now() + budgetMs;
  const remainingMs = () => Math.max(1, deadline - Date.now());
  try {
    const reload = await readThisReloadRecord({ stackBaseDir: info?.baseDir, startedAt });
    // QA train canary: the validity checks refuse READY only on Stacks that opted in (HAPPIER_STACK_QA_TRAIN=1).
    const { readEnvObjectFromFile } = await import('../utils/env/read.mjs');
    const enforceValidity = info?.envPath ? (await readEnvObjectFromFile(info.envPath))?.HAPPIER_STACK_QA_TRAIN === '1' : false;
    check = 'auth';
    // Keep the envelope private: only the owner's authenticated boolean is exposed.
    const runtimeMode = info?.runtime?.mode;
    const status = await runRetainedRuntimeCli({ rootDir, stackName, args: ['auth', 'status'], kind: 'auth_status', runtimeMode, run, timeoutMs: remainingMs() });
    const auth = { authenticated: status?.ok === true && status.data?.authenticated === true };
    check = 'sign_in';
    const { probeKeyLogin } = await import('./qa_bed.mjs');
    const serverUrl = String(info?.urls?.canonicalServerUrl ?? info?.urls?.internalServerUrl ?? '').replace(/\/+$/, '');
    const signIn = serverUrl ? await probeKeyLogin(serverUrl) : { status: null };
    // Spawn the probe Agent only on an otherwise ready, signed-in runtime.
    const verdict = projectStackReloadVerification({ info, beforeManagedCli, auth, reload, signIn, enforceValidity });
    if (verdict.status === 'NOT_READY' && verdict.check !== 'agent') {
      return { ...verdict, durationMs: Date.now() - startedAt };
    }
    check = 'agent';
    const agent = await probeStackAgentStart({ rootDir, stackName, runtimeMode, machineId: status.data?.machineId, run, remainingMs });
    // Resolve all non-render failures before acquiring a managed browser.
    const agentVerdict = projectStackReloadVerification({ info, beforeManagedCli, auth, agent, reload, signIn, enforceValidity });
    if (agentVerdict.status === 'NOT_READY' && agentVerdict.check !== 'render') {
      return { ...agentVerdict, durationMs: Date.now() - startedAt };
    }
    let render;
    if (info.urls?.uiUrl) {
      check = 'render';
      const smoke = smokeWebBoot ?? (await import('../runtime/launch/smokeSourceRuntimeReload.mjs')).smokeSourceWebBoot;
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort(new Error('[reload] verification interrupted'));
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        const api = await smoke({ repoDir: info.repo?.dir, stackName, url: info.urls.uiUrl, signal: AbortSignal.any([cancellation.signal, budget]), observeApiOrigin: enforceValidity });
        render = { status: 'ready', processStartedAt: info.runtime.borrowedExpo?.runtimeStartedAt ?? info.runtime.startedAt, ...api };
      } catch (error) {
        if (!budget.aborted || cancellation.signal.aborted) throw error;
        render = { status: 'timed_out' };
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    }
    return { ...projectStackReloadVerification({ info, beforeManagedCli, auth, agent, render, reload, signIn, enforceValidity }),
      durationMs: Date.now() - startedAt };
  } catch (error) {
    // Never expose command output, auth envelopes or environment values in a verdict.
    return { ...projectStackReloadVerification({ beforeManagedCli, failure: { check, error } }), durationMs: Date.now() - startedAt };
  }
}
