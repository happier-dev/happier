import { join } from 'node:path';

import { printResult } from '../utils/cli/cli.mjs';
import { getComponentDir } from '../utils/paths/paths.mjs';
import { run } from '../utils/proc/proc.mjs';

import { withStackEnv } from './stack_environment.mjs';

export async function runStackResumeCommand({ rootDir, stackName, passthrough, json }) {
  const sessionIds = passthrough.filter((arg) => arg && arg !== '--' && !arg.startsWith('--'));
  if (sessionIds.length === 0) {
    printResult({
      json,
      data: { ok: false, error: 'missing_session_ids' },
      text: [
        '[stack] usage:',
        '  hstack stack resume <name> <sessionId...>',
      ].join('\n'),
    });
    process.exit(1);
  }

  const out = await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      const cliDir = getComponentDir(rootDir, 'happier-cli', env);
      const happierBin = join(cliDir, 'bin', 'happier.mjs');
      return await run(process.execPath, [happierBin, 'daemon', 'resume', ...sessionIds], { cwd: rootDir, env });
    },
  });

  if (json) {
    printResult({ json, data: { ok: true, resumed: sessionIds, out } });
  }
}
