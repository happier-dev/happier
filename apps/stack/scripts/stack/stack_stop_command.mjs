import { parseArgs } from '../utils/cli/args.mjs';
import { printResult } from '../utils/cli/cli.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { stopStackWithEnv } from '../utils/stack/stop.mjs';

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
      return await stopStackWithEnv({
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
    },
  });

  if (json) {
    printResult({ json, data: { ok: true, stopped: out } });
  }
}
