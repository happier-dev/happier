import { buildLaunchdPlistXml, buildServicePath } from '@happier-dev/cli-common/service';

const MACOS_DEFAULT_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin';

export function buildLaunchdPath(params: Readonly<{ execPath?: string; basePath?: string; homeDir?: string }> = {}): string {
  return buildServicePath({ ...params, defaultPath: MACOS_DEFAULT_PATH, platform: 'darwin' });
}

export function buildLaunchAgentPlistXml(params: Readonly<{
  label: string;
  programArgs: string[];
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory?: string | null;
  abandonProcessGroup?: boolean;
}>): string {
  const workingDirectory = String(params.workingDirectory ?? '').trim();
  return buildLaunchdPlistXml({
    label: params.label,
    programArgs: params.programArgs,
    env: params.env,
    stdoutPath: params.stdoutPath,
    stderrPath: params.stderrPath,
    workingDirectory: workingDirectory || undefined,
    abandonProcessGroup: params.abandonProcessGroup,
  });
}
