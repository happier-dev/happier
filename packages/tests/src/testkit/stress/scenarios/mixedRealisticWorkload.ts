import type { StressConfig } from '../config/stressScenarioSchema';
import {
  resolvePresenceSessionCount,
  resolveReconnectCycleCount,
  resolveReconnectMessageCount,
  resolveRpcListenerCount,
} from './stressScenarioRuntime';

export type MixedRealisticWorkload = Readonly<{
  sessionCount: number;
  sessionPlans: ReadonlyArray<{
    authIndex: number;
    sessionSlot: number;
  }>;
  rpcListenerCount: number;
  rpcReadinessProbeCount: number;
  messageCount: number;
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
    sessionPlans,
    rpcListenerCount,
    rpcReadinessProbeCount,
    messageCount,
    reconnectCycles,
    verificationSessionCount,
    presencePulseCollectorCount: presenceFanInMode ? sessionCount : 0,
  };
}
