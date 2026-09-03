import { AGENTS_CORE } from '@happier-dev/agents';

import type {
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
} from '@/backends/types';

function supportsService(serviceId: string): boolean {
  return (AGENTS_CORE.codex.connectedServices.supportedServiceIds as readonly string[]).includes(serviceId);
}

export async function resolveCodexConnectedServiceSwitchContinuity(
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  if (!supportsService(params.serviceId)) {
    return { mode: 'unsupported', reason: 'unsupported_service' };
  }
  if (params.serviceId !== 'openai-codex') {
    return { mode: 'unsupported', reason: 'codex_api_key_switch_continuity_unsupported' };
  }

  // Codex owns live credential adoption through account/login/start. A missing or temporarily
  // unreachable runtime callback is an apply failure, never permission to replace app-server and
  // reconstruct the thread under a second auth-application path.
  return { mode: 'hot_apply' };
}
