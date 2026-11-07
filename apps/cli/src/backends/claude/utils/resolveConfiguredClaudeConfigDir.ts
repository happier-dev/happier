import { join } from 'node:path';

import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

import { resolveClaudeConfigDirOverride } from './resolveClaudeConfigDirOverride';

export function resolveConfiguredClaudeConfigDir(params: Readonly<{
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>): string {
  const configuredOverride = resolveClaudeConfigDirOverride(params.env);
  return configuredOverride || join(resolveHomeDirFromEnvironment(params.env, params.platform), '.claude');
}
