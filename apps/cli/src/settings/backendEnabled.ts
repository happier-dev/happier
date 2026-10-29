import { isBackendTargetDisabledByAccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { AgentId } from '@happier-dev/agents';

function formatBackendDisabledMessage(label: string): string {
  return `${label} is disabled in your account settings (enable it in the UI provider settings).`;
}

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

  throw new Error(formatBackendDisabledMessage(
    backendTarget.kind === 'configuredAcpBackend' ? backendTarget.backendId : backendTarget.agentId,
  ));
}

/**
 * Launch-admission form of the disable check: a disabled backend never gets a new runner,
 * whether the launch starts, forks, or resumes a session. Live runners are not relaunched.
 */
export function resolveBackendDisabledSpawnRefusal(params: Readonly<{
  backendTarget: BackendTargetRefV2;
  settings: unknown;
}>): Readonly<{ type: 'error'; errorCode: typeof SPAWN_SESSION_ERROR_CODES.BACKEND_DISABLED; errorMessage: string }> | null {
  if (!isBackendTargetDisabledByAccountSettings(params.settings, params.backendTarget)) return null;
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.BACKEND_DISABLED,
    errorMessage: formatBackendDisabledMessage(params.backendTarget.configuredBackendId ?? params.backendTarget.backendId),
  };
}
