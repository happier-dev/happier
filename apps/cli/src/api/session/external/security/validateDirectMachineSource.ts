import type { DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { DirectSourceValidationResult } from '@/session/external/sourceValidation';

export async function validateDirectMachineSource(params: Readonly<{
  providerId: DirectSessionsProviderId;
  source: DirectSessionsSource;
  env: NodeJS.ProcessEnv;
}>): Promise<DirectSourceValidationResult> {
  const { providerId, source, env } = params;
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(providerId)).directSessions;
  if (!providerOps) {
    return { ok: false, error: `Unsupported direct-session provider: ${providerId}` };
  }
  return await providerOps.validateSource({ source, env });
}
