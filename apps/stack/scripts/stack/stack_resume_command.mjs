import { join } from 'node:path';

import { printResult } from '../utils/cli/cli.mjs';
import { getComponentDir } from '../utils/paths/paths.mjs';
import { run, runCapture } from '../utils/proc/proc.mjs';

import { withStackEnv } from './stack_environment.mjs';

function supportsDaemonResume(helpText) {
  const normalized = String(helpText ?? '').toLowerCase();
  return /\bdaemon\s+resume\b/.test(normalized);
}

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

  const result = await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      const cliDir = getComponentDir(rootDir, 'happier-cli', env);
      const happierBin = join(cliDir, 'bin', 'happier.mjs');

      let daemonHelpText = '';
      try {
        daemonHelpText = await runCapture(process.execPath, [happierBin, 'daemon', '--help'], { cwd: rootDir, env });
      } catch {
        daemonHelpText = '';
      }

      if (!supportsDaemonResume(daemonHelpText)) {
        return { ok: false, error: 'resume_not_supported' };
      }

      const out = await run(process.execPath, [happierBin, 'daemon', 'resume', ...sessionIds], { cwd: rootDir, env });
      return { ok: true, out };
    },
  });

  if (!result?.ok) {
    printResult({
      json,
      data: { ok: false, error: 'resume_not_supported', resumed: [] },
      text: [
        '[stack] resume_not_supported',
        'Current happier-cli does not support `happier daemon resume`.',
        'Use the app UI to resume inactive sessions, or update to a compatible CLI/hstack pair.',
      ].join('\n'),
    });
    process.exit(1);
  }

  if (json) {
    printResult({ json, data: { ok: true, resumed: sessionIds, out: result.out } });
  } else {
    const outText = String(result.out ?? '').trim();
    printResult({
      json,
      data: { ok: true, resumed: sessionIds, out: result.out },
      text: [
        `[stack] resumed ${sessionIds.length} session(s): ${sessionIds.join(', ')}`,
        outText ? outText : '',
      ].filter(Boolean).join('\n'),
    });
  }
}
