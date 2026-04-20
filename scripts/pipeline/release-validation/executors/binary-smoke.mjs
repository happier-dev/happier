// @ts-check

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const BINARY_SMOKE_TIMEOUT_ARGS = ['--signal=KILL', '--kill-after=30s'];

function assertLinuxPlatform(platform) {
  if (platform !== 'linux') {
    throw new Error('binary-smoke currently supports only --platform linux because it depends on GNU timeout');
  }
}

/**
 * @param {{ repoRoot: string }} params
 */
function buildBinarySmokeSteps({ repoRoot }) {
  return [
    {
      name: 'self-host-binary-smoke',
      command: 'timeout',
      args: [
        ...BINARY_SMOKE_TIMEOUT_ARGS,
        '25m',
        process.execPath,
        '--test',
        resolve(repoRoot, 'apps', 'stack', 'scripts', 'self_host_binary_smoke.integration.test.mjs'),
      ],
      cwd: repoRoot,
    },
    {
      name: 'release-binary-smoke',
      command: 'timeout',
      args: [
        ...BINARY_SMOKE_TIMEOUT_ARGS,
        '45m',
        process.execPath,
        '--test',
        resolve(repoRoot, 'apps', 'stack', 'scripts', 'release_binary_smoke.integration.test.mjs'),
      ],
      cwd: repoRoot,
    },
  ];
}

/**
 * @param {{ repoRoot: string; platform: 'linux' | 'darwin' | 'win32'; source: { kind: string; ref: string } | null }} params
 */
export function resolveBinarySmokeExecution({ repoRoot, platform, source }) {
  assertLinuxPlatform(platform);
  if (!source || source.kind !== 'local-build') {
    throw new Error('binary-smoke currently supports only --source local-build');
  }
  return {
    type: 'commands',
    steps: buildBinarySmokeSteps({ repoRoot }),
  };
}

/**
 * @param {{ repoRoot: string; platform: 'linux' | 'darwin' | 'win32'; source: { kind: string; ref: string } | null }} params
 */
export function runBinarySmokeValidation({ repoRoot, platform, source }) {
  const execution = resolveBinarySmokeExecution({ repoRoot, platform, source });
  for (const step of execution.steps) {
    execFileSync(step.command, step.args, {
      cwd: step.cwd,
      stdio: 'inherit',
    });
  }
}
