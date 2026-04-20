import type { StressConfig } from '../config/stressScenarioSchema';

export type MixedConnectCeilingShardPlan = Readonly<{
  shardIndex: number;
  authIndexStart: number;
  authIndexEndExclusive: number;
  userCount: number;
  mixedSetupConcurrency: number;
  mixedConnectConcurrency: number;
}>;

function splitFairly(total: number, parts: number): number[] {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeParts = Math.max(1, Math.floor(parts));
  const base = Math.floor(safeTotal / safeParts);
  const remainder = safeTotal % safeParts;

  return Array.from({ length: safeParts }, (_, index) => base + (index < remainder ? 1 : 0));
}

function resolveShardCount(config: StressConfig): number {
  const requested = Math.max(1, config.load.mixedRunnerShards ?? 1);
  return Math.min(Math.max(1, config.load.users), requested);
}

function resolvePerShardBudget(total: number | undefined, shardCount: number): number[] {
  const resolvedTotal = Math.max(1, total ?? 1);
  const distributed = splitFairly(resolvedTotal, shardCount);
  return distributed.map((value) => Math.max(1, value));
}

export function buildMixedConnectCeilingShardPlans(config: StressConfig): readonly MixedConnectCeilingShardPlan[] {
  const shardCount = resolveShardCount(config);
  const userCounts = splitFairly(Math.max(1, config.load.users), shardCount);
  const setupBudgets = resolvePerShardBudget(config.load.mixedSetupConcurrency, shardCount);
  const connectBudgets = resolvePerShardBudget(config.load.mixedConnectConcurrency, shardCount);

  let authIndexCursor = 0;
  return userCounts.map((userCount, shardIndex) => {
    const authIndexStart = authIndexCursor;
    authIndexCursor += userCount;

    return {
      shardIndex,
      authIndexStart,
      authIndexEndExclusive: authIndexCursor,
      userCount,
      mixedSetupConcurrency: setupBudgets[shardIndex] ?? 1,
      mixedConnectConcurrency: connectBudgets[shardIndex] ?? 1,
    };
  });
}
