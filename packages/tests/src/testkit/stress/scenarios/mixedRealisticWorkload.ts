import type { StressConfig } from '../config/stressScenarioSchema';
import {
  resolvePresenceSessionCount,
  resolveReconnectCycleCount,
  resolveReconnectMessageCount,
  resolveRpcListenerCount,
} from './stressScenarioRuntime';

export type MixedRealisticWorkload = Readonly<{
  sessionCount: number;
  activeSessionCount: number;
  sessionPlans: ReadonlyArray<{
    authIndex: number;
    sessionSlot: number;
  }>;
  sessionPlanCount: number;
  rpcListenerCount: number;
  rpcReadinessProbeCount: number;
  messageCount: number;
  streamSegmentCount: number;
  reconnectCycles: number;
  verificationSessionCount: number;
  presencePulseCollectorCount: number;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function buildMixedSessionPlans(config: StressConfig): MixedRealisticWorkload['sessionPlans'] {
  const userCount = Math.max(1, config.load.users);
  const perUserSessionCount = config.targetMode === 'full-compose' && config.load.mixedSessionMode === 'presence-fan-in'
    ? Math.max(1, config.load.machinesPerUser * config.load.sessionsPerUser)
    : 1;

  return Array.from({ length: perUserSessionCount }, (_, sessionSlot) =>
    Array.from({ length: userCount }, (_, authIndex) => ({ authIndex, sessionSlot })),
  ).flat();
}

function resolveDurationSeconds(config: StressConfig): number {
  return Math.max(1, Math.ceil(config.duration.durationMs / 1000));
}

function resolveActiveSessionCount(sessionCount: number, config: StressConfig): number {
  const activePercent = clamp(config.load.mixedActiveSessionPercent ?? 100, 0, 100);
  if (activePercent === 0) {
    return 0;
  }

  const scaledCount = Math.floor((sessionCount * activePercent) / 100);
  return clamp(Math.max(1, scaledCount), 1, sessionCount);
}

function resolveStreamSegmentCount(config: StressConfig): number {
  const perSecond = Math.max(0, config.load.mixedStreamingSegmentsPerSecond ?? 0);
  return perSecond * resolveDurationSeconds(config);
}

export function resolveMixedSessionPlan(
  workload: MixedRealisticWorkload,
  sessionPlanIndex: number,
): MixedRealisticWorkload['sessionPlans'][number] {
  const sessionPlan = workload.sessionPlans[sessionPlanIndex];
  if (!sessionPlan) {
    throw new Error(`Missing mixed session plan at index ${sessionPlanIndex}`);
  }
  return sessionPlan;
}

export function buildMixedRealisticWorkload(config: StressConfig): MixedRealisticWorkload {
  const fanInMultiplier = Math.max(1, config.load.machinesPerUser * config.load.sessionsPerUser);
  const presenceFanInMode = config.targetMode === 'full-compose' && config.load.mixedSessionMode === 'presence-fan-in';
  const sessionPlans = buildMixedSessionPlans(config);
  const sessionCount = config.targetMode === 'full-compose'
    ? (
      presenceFanInMode
        ? resolvePresenceSessionCount(config)
        : Math.max(1, config.load.users)
    )
    : resolvePresenceSessionCount(config);
  const activeSessionCount = resolveActiveSessionCount(sessionCount, config);
  const rpcListenerBudget = Math.max(1, Math.ceil(sessionCount / 2));
  const scaledRpcListeners = presenceFanInMode
    ? resolveRpcListenerCount(config) * fanInMultiplier
    : resolveRpcListenerCount(config);
  const rpcListenerCount = clamp(scaledRpcListeners, 1, rpcListenerBudget);
  const rpcReadinessProbeLimit = config.load.rpcReadinessProbeLimit ?? rpcListenerCount;
  const rpcReadinessProbeCount = clamp(rpcReadinessProbeLimit, 1, rpcListenerCount);
  const messageCount = presenceFanInMode
    ? resolveReconnectMessageCount(config) * fanInMultiplier
    : resolveReconnectMessageCount(config);
  const reconnectCycles = Math.max(1, resolveReconnectCycleCount(config));
  const verificationSessionCount = config.targetMode === 'full-compose'
    ? clamp(Math.min(sessionCount, 8), 1, 8)
    : clamp(Math.ceil(sessionCount / 2), 1, 8);

  return {
    sessionCount,
    activeSessionCount,
    sessionPlans,
    sessionPlanCount: sessionPlans.length,
    rpcListenerCount,
    rpcReadinessProbeCount,
    messageCount,
    streamSegmentCount: resolveStreamSegmentCount(config),
    reconnectCycles,
    verificationSessionCount,
    presencePulseCollectorCount: presenceFanInMode ? sessionCount : 0,
  };
}
