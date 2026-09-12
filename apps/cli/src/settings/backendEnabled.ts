import {
  buildBackendTargetKey,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import type { AgentId } from '@happier-dev/agents';

export function isBackendEnabledByAccountSettings(params: Readonly<{
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1;
  settings: Record<string, unknown>;
}>): boolean {
  const backendEnabledByTargetKey = params.settings.backendEnabledByTargetKey;
  if (!backendEnabledByTargetKey || typeof backendEnabledByTargetKey !== 'object' || Array.isArray(backendEnabledByTargetKey)) return true;

  const backendTarget = params.backendTarget
    ?? (params.agentId ? ({ kind: 'builtInAgent', agentId: params.agentId } as const satisfies BackendTargetRefV1) : null);
  if (!backendTarget) return true;

  return (backendEnabledByTargetKey as Record<string, unknown>)[buildBackendTargetKey(backendTarget)] !== false;
}

export function assertBackendEnabledByAccountSettings(params: Readonly<{
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1;
  settings: Record<string, unknown>;
}>): void {
  const backendTarget = params.backendTarget
    ?? (params.agentId ? ({ kind: 'builtInAgent', agentId: params.agentId } as const satisfies BackendTargetRefV1) : null);
  if (!backendTarget) return;
  if (!isBackendEnabledByAccountSettings(params)) {
    const label = backendTarget.kind === 'configuredAcpBackend' ? backendTarget.backendId : backendTarget.agentId;
    throw new Error(`${label} is disabled in your account settings (enable it in the UI provider settings).`);
  }
}
