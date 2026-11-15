import { projectStackReloadVerification } from './reload_verdict.mjs';

/**
 * Run one retained-runtime CLI command and return its JSON envelope of `kind`.
 * The wrapper selects the Stack's auth home and daemon host. The child process
 * is the boundary `run` stands for; null means the command printed no envelope.
 */
async function runRetainedRuntimeCli({ rootDir, stackName, args, kind, run }) {
  const { join } = await import('node:path');
  const runCli = run ?? (await import('../utils/proc/proc.mjs')).runCaptureResult;
  const result = await runCli(process.execPath, [join(rootDir, 'scripts/stack.mjs'),
    'happier', stackName, '--runtime', '--', ...args, '--json'], { cwd: rootDir, env: process.env });
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
export async function probeStackAgentStart({ rootDir, stackName, run }) {
  const cli = (args, kind) => runRetainedRuntimeCli({ rootDir, stackName, args, kind, run });
  const created = await cli(['session', 'create', '--title', 'Stack readiness probe'], 'session_create');
  const sessionId = created?.ok === true ? created.data?.session?.id : null;
  if (typeof sessionId !== 'string' || !sessionId) return readAgentProbeFailure('create', created);
  const stopped = await cli(['session', 'stop', sessionId], 'session_stop');
  if (stopped?.ok !== true) return readAgentProbeFailure('stop', stopped);
  const archived = await cli(['session', 'archive', sessionId], 'session_archive');
  if (archived?.ok !== true) return readAgentProbeFailure('archive', archived);
  return { status: 'ready' };
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
    await runStackScriptWithStackEnv({ rootDir, stackName, scriptPath, args, background: true });
    check = 'observation';
    const info = await readStackInfoSnapshot({ rootDir, stackName });
    check = 'auth';
    // Keep the envelope private: only the owner's authenticated boolean is exposed.
    const status = await runRetainedRuntimeCli({ rootDir, stackName, args: ['auth', 'status'], kind: 'auth_status' });
    const auth = { authenticated: status?.ok === true && status.data?.authenticated === true };
    // Spawn the probe Agent only on an otherwise ready, signed-in runtime.
    const verdict = projectStackReloadVerification({ info, beforeManagedCli, auth });
    if (verdict.status === 'NOT_READY' && verdict.check !== 'agent') {
      return { ...verdict, durationMs: Date.now() - startedAt };
    }
    check = 'agent';
    const agent = await probeStackAgentStart({ rootDir, stackName });
    // Resolve all non-render failures before acquiring a managed browser.
    const agentVerdict = projectStackReloadVerification({ info, beforeManagedCli, auth, agent });
    if (agentVerdict.status === 'NOT_READY' && agentVerdict.check !== 'render') {
      return { ...agentVerdict, durationMs: Date.now() - startedAt };
    }
    let render;
    if (info.urls?.uiUrl) {
      check = 'render';
      const { smokeSourceWebBoot } = await import('../runtime/launch/smokeSourceRuntimeReload.mjs');
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort(new Error('[reload] verification interrupted'));
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        await smokeSourceWebBoot({ repoDir: info.repo.dir, stackName, url: info.urls.uiUrl, signal: cancellation.signal });
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
      render = { status: 'ready', processStartedAt: info.runtime.borrowedExpo?.runtimeStartedAt ?? info.runtime.startedAt };
    }
    return { ...projectStackReloadVerification({ info, beforeManagedCli, auth, agent, render }),
      durationMs: Date.now() - startedAt };
  } catch (error) {
    // Never expose command output, auth envelopes or environment values in a verdict.
    return { ...projectStackReloadVerification({ beforeManagedCli, failure: { check, error } }), durationMs: Date.now() - startedAt };
  }
}
