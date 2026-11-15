import { parseArgs } from '../utils/cli/args.mjs';
import { printResult } from '../utils/cli/cli.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { stopStackWithEnv } from '../utils/stack/stop.mjs';
import { redactFailureDiagnostic } from '../utils/proc/proc.mjs';

import { withStackEnv } from './stack_environment.mjs';

export function resolveStackStopOptions(passthrough) {
  const { flags } = parseArgs(passthrough);
  return {
    noDocker: flags.has('--no-docker'),
    aggressive: flags.has('--aggressive'),
    sweepOwned: flags.has('--sweep-owned'),
    preserveDaemon: flags.has('--preserve-daemon'),
  };
}

export async function runStackStopCommand({ rootDir, stackName, passthrough, json }) {
  const { noDocker, aggressive, sweepOwned, preserveDaemon } = resolveStackStopOptions(passthrough);
  const baseDir = resolveStackEnvPath(stackName).baseDir;

  const out = await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      const result = await stopStackWithEnv({
        rootDir,
        stackName,
        baseDir,
        env,
        json,
        noDocker,
        aggressive,
        sweepOwned,
        preserveDaemon,
      });
      for (const failure of result.errors ?? []) {
        failure.error = redactFailureDiagnostic(failure.error, env);
      }
      return result;
    },
  });

  // Release the source trees the Stack no longer selects (a restart's incumbent;
  // never the tree the restart just selected), so an unreferenced base is
  // deleted (no timer; owner 2026-11-14).
  if (out.finalization?.finalized !== false) {
    const { releaseStackSourceTrees } = await import('../build/source_revision_tree.mjs');
    await releaseStackSourceTrees({ stackBaseDir: baseDir, components: preserveDaemon ? ['server'] : ['server', 'daemon'] });
  }
  if (json) {
    printResult({ json, data: { ok: out.finalization?.finalized !== false, stopped: out } });
  }
  if (out.finalization?.finalized === false) {
    if (!json) {
      console.error(`[stack] ${stackName} stop incomplete: ${out.finalization.reason}`);
      for (const failure of out.errors ?? []) {
        console.error(`[stack] ${failure.step}${failure.target ? ` (${failure.target})` : ''}: ${redactFailureDiagnostic(failure.error, process.env)}`);
      }
    }
    process.exitCode = 1;
  }
}
