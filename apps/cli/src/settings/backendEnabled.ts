import {
  isBackendTargetDisabledByAccountSettings,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import type { AgentId } from '@happier-dev/agents';

export function assertBackendEnabledByAccountSettings(params: Readonly<{
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1;
  settings: Record<string, unknown>;
}>): void {
  const backendTarget = params.backendTarget
    ?? (params.agentId ? ({ kind: 'builtInAgent', agentId: params.agentId } as const satisfies BackendTargetRefV1) : null);
  if (!backendTarget) return;

  // The canonical Account Settings owner resolves the target key; building a
  // legacy `agent:`/`acpBackend:` key here would never match the parsed
  // projection, which stores the V2 spelling.
  if (!isBackendTargetDisabledByAccountSettings(params.settings, backendTarget)) return;

  const label = backendTarget.kind === 'configuredAcpBackend' ? backendTarget.backendId : backendTarget.agentId;
  throw new Error(`${label} is disabled in your account settings (enable it in the UI provider settings).`);
}
