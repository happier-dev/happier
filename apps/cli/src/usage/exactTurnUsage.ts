import type { UsageObservation } from './usageObservation';

export type ExactTurnUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}>;

export type ExactTurnUsageAccumulator = Readonly<{
  observe(observation: UsageObservation): void;
  current(): ExactTurnUsage | undefined;
}>;

function addSafeInteger(current: number | undefined, delta: number | null): number | null {
  if (delta === null || !Number.isSafeInteger(delta) || delta < 0) return null;
  const next = (current ?? 0) + delta;
  return Number.isSafeInteger(next) ? next : null;
}

/**
 * One exact-turn aggregation policy shared by Session transcript observation
 * and detached Workflow observation. Session-wide snapshots are deliberately
 * ignored: adding them to deltas would double count provider usage.
 */
export function createExactTurnUsageAccumulator(): ExactTurnUsageAccumulator {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let costUsd: number | undefined;
  let inputTokensUnavailable = false;
  let outputTokensUnavailable = false;
  let costUsdUnavailable = false;

  return Object.freeze({
    observe(observation) {
      if (observation.scope !== 'turn_delta') return;

      {
        const nextInput = addSafeInteger(inputTokens, observation.tokens?.input ?? null);
        if (observation.availability?.inputTokens === true
          && !inputTokensUnavailable && nextInput !== null) {
          inputTokens = nextInput;
        } else {
          inputTokens = undefined;
          inputTokensUnavailable = true;
        }

        const nextOutput = addSafeInteger(outputTokens, observation.tokens?.output ?? null);
        if (observation.availability?.outputTokens === true
          && !outputTokensUnavailable && nextOutput !== null) {
          outputTokens = nextOutput;
        } else {
          outputTokens = undefined;
          outputTokensUnavailable = true;
        }
      }

      {
        const exactReportedUsd = observation.availability?.reportedCostUsd === true
          && observation.cost?.currency === 'USD'
          && (observation.cost.costSource === 'provider_reported'
            || observation.cost.costSource === 'provider_reported_api_equivalent')
          ? observation.cost.reportedUsd
          : null;
        const nextCost = exactReportedUsd === null ? null : (costUsd ?? 0) + exactReportedUsd;
        if (!costUsdUnavailable && nextCost !== null && Number.isFinite(nextCost) && nextCost >= 0) {
          costUsd = nextCost;
        } else {
          costUsd = undefined;
          costUsdUnavailable = true;
        }
      }
    },
    current() {
      return inputTokens === undefined && outputTokens === undefined && costUsd === undefined
        ? undefined
        : {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(costUsd === undefined ? {} : { costUsd }),
          };
    },
  });
}
