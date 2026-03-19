import {
  buildBackendTargetKey,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import type { AgentId } from '@happier-dev/agents';

export function assertBackendEnabledByAccountSettings(params: Readonly<{
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1;
  settings: Record<string, unknown>;
}>): void {
  const backendEnabledByTargetKey = (params.settings as any)?.backendEnabledByTargetKey as unknown;
  if (!backendEnabledByTargetKey || typeof backendEnabledByTargetKey !== 'object' || Array.isArray(backendEnabledByTargetKey)) return;

  const backendTarget = params.backendTarget
    ?? (params.agentId ? ({ kind: 'builtInAgent', agentId: params.agentId } as const satisfies BackendTargetRefV1) : null);
  if (!backendTarget) return;

  const targetKey = buildBackendTargetKey(backendTarget);
  const enabled = (backendEnabledByTargetKey as any)?.[targetKey] as unknown;
  if (enabled === false) {
    const label = backendTarget.kind === 'configuredAcpBackend' ? backendTarget.backendId : backendTarget.agentId;
    throw new Error(`${label} is disabled in your account settings (enable it in the UI provider settings).`);
  }
}
