import type { AgentPermissionIntent } from '@happier-dev/plugin-sdk/agent-runtime';

export function buildCopilotAcpArgv(params: Readonly<{
  baseArgs: readonly string[];
  permissionIntent: AgentPermissionIntent | null;
}>): readonly string[] {
  return params.permissionIntent === 'yolo'
    ? [...params.baseArgs, '--yolo']
    : [...params.baseArgs];
}
