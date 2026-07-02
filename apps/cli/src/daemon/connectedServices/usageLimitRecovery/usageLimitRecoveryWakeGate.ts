import type { DurableRecoveryGateResult } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
import type { UsageLimitRecoveryIntent } from './UsageLimitRecoveryScheduler';

const DEFAULT_RUNNER_UNAVAILABLE_RETRY_DELAY_MS = 60_000;
const DEFAULT_COALESCE_WINDOW_MS = 1_000;

function normalizePositiveMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeKeyPart(value: string): string {
  return value.trim();
}

function resolveSelectedAuthCoalesceKey(intent: UsageLimitRecoveryIntent): string | null {
  const selectedAuth = intent.selectedAuth;
  if (selectedAuth.kind === 'native') return null;
  if (selectedAuth.kind === 'profile') {
    return [
      normalizeKeyPart(selectedAuth.serviceId),
      'profile',
      normalizeKeyPart(selectedAuth.profileId),
    ].join('\0');
  }
  return [
    normalizeKeyPart(selectedAuth.serviceId),
    'group',
    normalizeKeyPart(selectedAuth.groupId),
  ].join('\0');
}

export function createUsageLimitRecoveryWakeGate(params: Readonly<{
  nowMs: () => number;
  hasRunner: (sessionId: string) => boolean;
  runnerUnavailableRetryDelayMs?: number;
  coalesceWindowMs?: number;
}>): (input: Readonly<{ sessionId: string; intent: UsageLimitRecoveryIntent }>) => DurableRecoveryGateResult {
  const runnerUnavailableRetryDelayMs = normalizePositiveMs(
    params.runnerUnavailableRetryDelayMs,
    DEFAULT_RUNNER_UNAVAILABLE_RETRY_DELAY_MS,
  );
  const coalesceWindowMs = normalizePositiveMs(
    params.coalesceWindowMs,
    DEFAULT_COALESCE_WINDOW_MS,
  );
  const nextOpenAtMsByAuthKey = new Map<string, number>();

  return ({ sessionId, intent }) => {
    const nowMs = params.nowMs();
    if (!params.hasRunner(sessionId)) {
      return {
        status: 'delayed',
        retryAtMs: nowMs + runnerUnavailableRetryDelayMs,
        reason: 'usage_limit_recovery_check_runner_unavailable',
      };
    }

    const authKey = resolveSelectedAuthCoalesceKey(intent);
    if (!authKey) return { status: 'open' };
    const nextOpenAtMs = nextOpenAtMsByAuthKey.get(authKey);
    if (typeof nextOpenAtMs === 'number' && nowMs < nextOpenAtMs) {
      return {
        status: 'delayed',
        retryAtMs: nextOpenAtMs,
        reason: 'usage_limit_recovery_wake_coalesced',
      };
    }
    nextOpenAtMsByAuthKey.set(authKey, nowMs + coalesceWindowMs);
    return { status: 'open' };
  };
}
