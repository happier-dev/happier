import type { AgentPermissionIntent } from '@happier-dev/plugin-sdk/agents/runtime';

export function buildCopilotAcpArgv(params: Readonly<{
  baseArgs: readonly string[];
  permissionIntent: AgentPermissionIntent | null;
  nativeSandbox?: 'on' | 'off';
}>): readonly string[] {
  return [...params.baseArgs,
    ...(params.permissionIntent === 'yolo' ? ['--yolo'] : []),
    ...(params.nativeSandbox === undefined ? [] : [params.nativeSandbox === 'on' ? '--sandbox' : '--no-sandbox'])];
}
