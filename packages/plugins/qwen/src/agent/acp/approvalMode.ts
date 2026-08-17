import type { AgentPermissionIntent } from '@happier-dev/plugin-sdk/agents/runtime';

const QWEN_APPROVAL_MODE_BY_PERMISSION_INTENT = Object.freeze({
  default: null,
  'read-only': 'plan',
  'safe-yolo': 'auto-edit',
  yolo: 'yolo',
  plan: 'plan',
} satisfies Readonly<Record<AgentPermissionIntent, string | null>>);

export function buildQwenAcpArgv(params: Readonly<{
  baseArgs: readonly string[];
  permissionIntent: AgentPermissionIntent | null;
}>): readonly string[] {
  const approvalMode = params.permissionIntent
    ? QWEN_APPROVAL_MODE_BY_PERMISSION_INTENT[params.permissionIntent]
    : null;
  return approvalMode
    ? [...params.baseArgs, '--approval-mode', approvalMode]
    : [...params.baseArgs];
}
