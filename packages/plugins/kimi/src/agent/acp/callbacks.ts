import type {
  AgentLaunchEnvironment,
  AgentPermissionIntent,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { ensureKimiReadOnlyAgentFile } from '../bootstrap/readonlyAgentFile.js';
import { HAPPIER_KIMI_ACP_SELECTOR_ENV } from '../preferences/pythonSelector.js';
import { resolveKimiAcpPythonSelectorChildEnv } from './pythonSelectorEnv.js';

export function buildKimiAcpArgv(params: Readonly<{
  baseArgs: readonly string[];
  cwd: string;
  permissionIntent: AgentPermissionIntent | null;
}>): string[] {
  const intent = params.permissionIntent;
  const args: string[] = ['--work-dir', params.cwd];

  if (intent === 'yolo') {
    args.push('--yolo');
  }

  if (intent === 'read-only' || intent === 'plan') {
    args.push('--agent-file', ensureKimiReadOnlyAgentFile());
  }

  args.push(...params.baseArgs);
  return args;
}

export function buildKimiAcpEnv(params: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
}>): Record<string, string> {
  const env = params.launchEnvironment?.values ?? {};
  return resolveKimiAcpPythonSelectorChildEnv({
    selector: env[HAPPIER_KIMI_ACP_SELECTOR_ENV],
    env,
    inheritedEnv: env,
  });
}
