import { parseArgs } from '../utils/cli/args.mjs';
import { printResult } from '../utils/cli/cli.mjs';
import { resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { stopStackWithEnv } from '../utils/stack/stop.mjs';

import { withStackEnv } from './stack_environment.mjs';

export async function runStackStopCommand({ rootDir, stackName, passthrough, json }) {
  const { flags: stopFlags } = parseArgs(passthrough);
  const noDocker = stopFlags.has('--no-docker');
  const aggressive = stopFlags.has('--aggressive');
  const sweepOwned = stopFlags.has('--sweep-owned');
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
      });
    },
  });

  if (json) {
    printResult({ json, data: { ok: true, stopped: out } });
  }
}
