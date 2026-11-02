import { projectStackReloadVerification } from './reload_verdict.mjs';

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
    const { join } = await import('node:path');
    const { runCaptureResult } = await import('../utils/proc/proc.mjs');
    // The retained-runtime wrapper selects the correct auth home and daemon host.
    // Keep the envelope private: only the owner's authenticated boolean is exposed.
    const result = await runCaptureResult(process.execPath, [join(rootDir, 'scripts/stack_commands.mjs'),
      'happier', stackName, '--runtime', '--', 'auth', 'status', '--json'], { cwd: rootDir, env: process.env });
    let auth = { authenticated: false };
    for (const line of result.out.split(/\r?\n/)) {
      try {
        const envelope = JSON.parse(line);
        if (envelope.kind === 'auth_status') auth = { authenticated: result.ok === true
          && envelope.ok === true && envelope.data?.authenticated === true };
      } catch { /* The CLI owner may print preparation diagnostics before its envelope. */ }
    }
    // Resolve all non-render failures before acquiring a managed browser.
    const verdict = projectStackReloadVerification({ info, beforeManagedCli, auth });
    if (verdict.status === 'NOT_READY' && verdict.check !== 'render') {
      return { ...verdict, durationMs: Date.now() - startedAt };
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
    return { ...projectStackReloadVerification({ info, beforeManagedCli, auth, render }),
      durationMs: Date.now() - startedAt };
  } catch (error) {
    // Never expose command output, auth envelopes or environment values in a verdict.
    return { ...projectStackReloadVerification({ beforeManagedCli, failure: { check, error } }), durationMs: Date.now() - startedAt };
  }
}
