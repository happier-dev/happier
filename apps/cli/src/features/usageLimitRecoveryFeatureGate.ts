import { configuration } from '@/configuration';

import { resolveCliFeatureDecisionForServer } from './featureDecisionService';

const USAGE_LIMIT_RECOVERY_FEATURE_ID = 'sessions.usageLimitRecovery';
const USAGE_LIMIT_RECOVERY_FEATURE_GATE_TIMEOUT_MS = 800;

export function usageLimitRecoveryDisabledResult(): Readonly<{
  ok: false;
  errorCode: 'feature_disabled';
  error: 'sessions.usageLimitRecovery is disabled.';
}> {
  return {
    ok: false,
    errorCode: 'feature_disabled',
    error: 'sessions.usageLimitRecovery is disabled.',
  };
}

export async function resolveUsageLimitRecoveryEnabled(params: Readonly<{
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  timeoutMs?: number;
}> = {}): Promise<boolean> {
  const resolved = await resolveCliFeatureDecisionForServer({
    featureId: USAGE_LIMIT_RECOVERY_FEATURE_ID,
    env: params.env ?? process.env,
    serverUrl: params.serverUrl ?? configuration.apiServerUrl,
    timeoutMs: params.timeoutMs ?? USAGE_LIMIT_RECOVERY_FEATURE_GATE_TIMEOUT_MS,
  });

  return resolved.decision.state === 'enabled';
}
