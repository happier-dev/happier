import { homedir, tmpdir } from 'node:os';

import {
  isAbsolutePathForPathShape,
  isWin32ShapedAbsolutePath,
  joinPathForPathShape,
  resolvePathForPathShape,
} from '../path/pathShape.js';

function resolveConfiguredHomeOverride(rawOverride: string, processEnv: NodeJS.ProcessEnv): string {
  const override = rawOverride.trim();
  if (!override) return '';

  const envHome =
    process.platform === 'win32'
      ? (processEnv.USERPROFILE || processEnv.HOME)
      : processEnv.HOME;
  const normalizedHome = typeof envHome === 'string' ? envHome.trim() : '';
  const expandedOverride =
    override === '~'
      ? (normalizedHome || homedir())
      : override.startsWith('~/') || override.startsWith('~\\')
        ? joinPathForPathShape(normalizedHome || homedir(), override.slice(2))
        : override;
  if (process.platform !== 'win32' && isWin32ShapedAbsolutePath(expandedOverride)) {
    throw new Error(`Windows-shaped home overrides are not supported on ${process.platform}`);
  }
  return isAbsolutePathForPathShape(expandedOverride) ? expandedOverride : resolvePathForPathShape(expandedOverride);
}

export function resolveHappyHomeDirFromEnvironment(processEnv: NodeJS.ProcessEnv = process.env): string {
  const override = typeof processEnv.HAPPIER_HOME_DIR === 'string' ? processEnv.HAPPIER_HOME_DIR.trim() : '';
  if (override) {
    return resolveConfiguredHomeOverride(override, processEnv);
  }

  const stackOverride = typeof processEnv.HAPPIER_STACK_CLI_HOME_DIR === 'string'
    ? processEnv.HAPPIER_STACK_CLI_HOME_DIR.trim()
    : '';
  if (stackOverride) {
    return resolveConfiguredHomeOverride(stackOverride, processEnv);
  }

  const envHome =
    process.platform === 'win32'
      ? ((processEnv.USERPROFILE ?? processEnv.HOME ?? '').trim())
      : ((processEnv.HOME ?? processEnv.USERPROFILE ?? '').trim());
  let baseHome = envHome;
  if (!baseHome) {
    try {
      baseHome = homedir();
    } catch {
      baseHome = '';
    }
  }

  if (!baseHome) {
    baseHome = tmpdir();
  }

  return joinPathForPathShape(baseHome, '.happier');
}
