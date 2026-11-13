import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import semver from 'semver';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

export const HERDR_ACTION_TIMEOUT_MS = 5_000;
export const HERDR_STARTUP_TIMEOUT_MS = 60_000;

export function isSupportedHerdrVersion(value: string): boolean {
  const version = value.trim().replace(/^herdr\s+/, '');
  const parsed = semver.parse(version);
  if (!parsed) return false;
  return parsed.prerelease.length === 0 && semver.gte(parsed, '0.9.2');
}

export async function resolveHerdrRuntimeBinary(params: Readonly<{
  actionTimeoutMs: number;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  const processEnv = params.processEnv ?? sessionProcessEnvironment();
  const binary = processEnv.HERDR_BIN_PATH?.trim() || 'herdr';
  try {
    const { stdout } = await execFileWithDeadline(binary, ['--version'], {
      timeout: params.actionTimeoutMs,
      windowsHide: true,
      env: processEnv,
    });
    return isSupportedHerdrVersion(stdout.toString()) ? binary : null;
  } catch {
    return null;
  }
}
