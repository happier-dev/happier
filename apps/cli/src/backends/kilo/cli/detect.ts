import type { CliDetectSpec } from '@/backends/types';

export const cliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  // Kilo may perform network-dependent initialization even for auth checks. Avoid best-effort login probing.
  loginStatusArgs: null,
} satisfies CliDetectSpec;

