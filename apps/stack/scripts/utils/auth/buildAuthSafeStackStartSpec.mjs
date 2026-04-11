import { join } from 'node:path';

export function buildAuthSafeStackStartSpec({
  rootDir,
  stackName,
  shouldUseRuntimeStart = false,
  effectiveWebappMode = 'auto',
  shouldStartDevForAutoAuth = false,
  baseEnv = process.env,
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const useDevCommand = !shouldUseRuntimeStart && (effectiveWebappMode === 'expo' || shouldStartDevForAutoAuth);
  const command = shouldUseRuntimeStart ? 'start' : useDevCommand ? 'dev' : 'start';

  return {
    command,
    startedStackForExpoAuth: useDevCommand,
    args: [
      process.execPath,
      [
        join(rootDir, 'scripts', 'stack.mjs'),
        command,
        name,
        '--background',
        ...(shouldUseRuntimeStart ? ['--runtime'] : []),
        '--no-daemon',
        '--no-browser',
      ],
    ],
    env: {
      ...baseEnv,
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
      ...(useDevCommand ? { HAPPIER_STACK_AUTH_FLOW: '1' } : {}),
    },
  };
}
