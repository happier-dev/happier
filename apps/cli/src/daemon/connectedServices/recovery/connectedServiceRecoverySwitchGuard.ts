import type { ConnectedServiceId, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import { evaluatePredictiveSoftSwitchPolicy } from '../accountGroups/switching/predictiveSoftSwitchPolicy';

export type ConnectedServiceRecoverySoftSwitchGuardInput = Readonly<{
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  agentId?: string | null;
  reason: 'soft_threshold' | 'usage_limit' | 'auth_expired';
}>;

export type ConnectedServiceRecoverySoftSwitchGuardResult =
  | Readonly<{ status: 'allow' }>
  | Readonly<{ status: 'suppress'; reason: string }>;

type RuntimeAuthRecoveryReader = Readonly<{
  readForSession(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent>;
}>;

type UsageLimitRecoveryReader = Readonly<{
  read(sessionId: string): SessionUsageLimitRecoveryV1 | null;
}>;

type PredictiveSoftSwitchMode = 'supported' | 'unsupported';
type ConnectedServiceRecoverySwitchTurnState = Readonly<{
  inFlight: boolean;
}>;

export const QUOTA_SOFT_SWITCH_SUPPRESSED_RECOVERY_PENDING_REASON =
  'quota_soft_switch_suppressed_recovery_pending';

function isPendingRuntimeAuthRecovery(intent: RuntimeAuthRecoveryIntent | null): boolean {
  return intent?.status === 'waiting'
    || intent?.status === 'checking';
}

function hasPendingRuntimeAuthRecovery(input: Readonly<{
  runtimeAuthRecovery: RuntimeAuthRecoveryReader | null | undefined;
  target: ConnectedServiceRecoverySoftSwitchGuardInput;
}>): boolean {
  if (!input.runtimeAuthRecovery) return false;
  const intents = input.runtimeAuthRecovery.readForSession(input.target.sessionId);
  return intents.some((intent) => {
    if (!isPendingRuntimeAuthRecovery(intent)) return false;
    if (intent.serviceId !== input.target.serviceId) return false;
    if (intent.groupId === input.target.groupId) return true;
    return intent.groupId === null && intent.profileId === input.target.activeProfileId;
  });
}

function isPendingUsageLimitRecovery(intent: SessionUsageLimitRecoveryV1 | null): boolean {
  return intent?.status === 'armed'
    || intent?.status === 'waiting'
    || intent?.status === 'checking';
}

function usageLimitRecoveryMatchesTarget(input: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  target: ConnectedServiceRecoverySoftSwitchGuardInput;
}>): boolean {
  const selectedAuth = input.intent.selectedAuth;
  if (selectedAuth.kind !== 'group') return false;
  return selectedAuth.serviceId === input.target.serviceId
    && selectedAuth.groupId === input.target.groupId
    && selectedAuth.profileId === input.target.activeProfileId;
}

function hasPendingUsageLimitRecovery(input: Readonly<{
  usageLimitRecovery: UsageLimitRecoveryReader | null | undefined;
  target: ConnectedServiceRecoverySoftSwitchGuardInput;
}>): boolean {
  const intent = input.usageLimitRecovery?.read(input.target.sessionId) ?? null;
  return Boolean(
    intent
    && isPendingUsageLimitRecovery(intent)
    && usageLimitRecoveryMatchesTarget({ intent, target: input.target }),
  );
}

export function createConnectedServiceRecoverySwitchGuard(deps: Readonly<{
  runtimeAuthRecovery?: RuntimeAuthRecoveryReader | null;
  usageLimitRecovery?: UsageLimitRecoveryReader | null;
  readTurnState?: (sessionId: string) => ConnectedServiceRecoverySwitchTurnState | null;
  resolvePredictiveSoftSwitchMode?: (
    input: ConnectedServiceRecoverySoftSwitchGuardInput,
  ) => PredictiveSoftSwitchMode | Promise<PredictiveSoftSwitchMode>;
}>): (input: ConnectedServiceRecoverySoftSwitchGuardInput) => Promise<ConnectedServiceRecoverySoftSwitchGuardResult> {
  return async (input) => {
    if (input.reason === 'soft_threshold') {
      const predictiveDecision = evaluatePredictiveSoftSwitchPolicy({
        reason: input.reason,
        predictiveSoftSwitchMode: deps.resolvePredictiveSoftSwitchMode
          ? await deps.resolvePredictiveSoftSwitchMode(input)
          : 'supported',
        turnState: deps.readTurnState?.(input.sessionId) ?? null,
      });
      if (predictiveDecision.status === 'suppress') {
        return predictiveDecision;
      }
    }
    if (
      hasPendingRuntimeAuthRecovery({ runtimeAuthRecovery: deps.runtimeAuthRecovery, target: input })
      || hasPendingUsageLimitRecovery({ usageLimitRecovery: deps.usageLimitRecovery, target: input })
    ) {
      return {
        status: 'suppress',
        reason: QUOTA_SOFT_SWITCH_SUPPRESSED_RECOVERY_PENDING_REASON,
      };
    }
    return { status: 'allow' };
  };
}
