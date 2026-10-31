import { spawnBackgroundSync } from '@happier-dev/cli-common/process';

import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  loginStatusArgs: ['auth', 'status'],
} satisfies CliDetectSpec;

export type GeminiAcpFlag = '--acp' | '--experimental-acp';

function hasAcpFlag(output: string, flag: GeminiAcpFlag): boolean {
  return new RegExp(`(^|\\s)${flag.replaceAll('-', '\\-')}(?=\\s|,|$)`).test(output);
}

export function resolveGeminiAcpFlag(params: Readonly<{
  command: string;
  baseArgs?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}>): GeminiAcpFlag {
  const probe = spawnBackgroundSync(params.command, [...(params.baseArgs ?? []), '--help'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(params.env ?? {}),
      NODE_ENV: 'production',
      DEBUG: '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 2_000,
    maxBuffer: 256 * 1024,
  });

  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  if (hasAcpFlag(output, '--acp')) return '--acp';
  if (hasAcpFlag(output, '--experimental-acp')) return '--experimental-acp';
  return '--acp';
}
