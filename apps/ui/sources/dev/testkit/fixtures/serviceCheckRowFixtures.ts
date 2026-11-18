import type { TelemetryKeyFlowConfigV1 } from '@happier-dev/database-protocol';

import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';

/**
 * Saved Check rows in the managed inventory's own shape (definition facts plus retained results), for Check bodies in
 * tests and `/dev` specimens. Results follow the health owner's result shape: a Key flow over its limit is failing
 * (degraded), one with no traffic is unknown, an HTTP target that cannot answer is down.
 */
export type ServiceCheckRowFixtureState =
  | 'passing'
  | 'failing'
  | 'unknown'
  | 'down';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SCOPE = Object.freeze({
  serverId: 'specimen-server',
  accountId: 'specimen-account',
});

export function createKeyFlowFixture(
  name: string,
  input: Readonly<{ limitMs: number; routes: readonly string[] }>,
): TelemetryKeyFlowConfigV1 {
  return {
    name,
    environmentId: 'env-billing-prod',
    serviceName: 'billing-api',
    windowMs: 10 * MINUTE,
    measure: {
      kind: 'route',
      statistic: 'p95',
      routes: input.routes.map((route) => {
        const [method, path] = route.split(' ');
        return { method: method!, route: path! };
      }),
    },
    threshold: { operator: 'above', value: input.limitMs },
  };
}

/** A plausible, deterministic response time per index: a slow swell and a little noise. */
function wave(index: number, base: number, spread: number) {
  return Math.round(
    base + spread * Math.sin(index / 7) + (spread / 3) * Math.sin(index * 1.7),
  );
}

function keyFlowResults(
  state: ServiceCheckRowFixtureState,
  nowMs: number,
  failingValue: number,
) {
  return Array.from({ length: 40 }, (_, index) => {
    const age = 39 - index;
    const failing = state === 'failing' && age < 3;
    const unknown = state === 'unknown' && age < 14;
    const observedAt = nowMs - age * MINUTE;
    const value = failing ? failingValue - age * 20 : wave(index, 240, 40);
    return {
      status: failing ? 'degraded' : unknown ? 'unknown' : 'up',
      observedAt,
      ...(unknown ? {} : { latencyMs: value }),
      measurements: {
        measure: 'p95',
        unit: 'ms',
        basis: 'metric_points',
        producers: [{ serviceName: 'billing-api' }],
        window: { since: observedAt - 10 * MINUTE, until: observedAt },
        completeness: unknown ? 'unknown' : 'complete',
        reasons: unknown ? ['no_traffic'] : [],
        ...(unknown
          ? {}
          : { value, p95Ms: value, errorRate: 0.002, requestCount: 140 }),
      },
      cause: {
        kind: 'keyFlow',
        vantage: 'sameMachine',
        reason: failing
          ? 'threshold_exceeded'
          : unknown
            ? 'no_traffic'
            : 'within_threshold',
      },
      evidence: { kind: 'none' },
    };
  });
}

function httpResults(state: ServiceCheckRowFixtureState, nowMs: number) {
  return Array.from({ length: 40 }, (_, index) => {
    const age = 39 - index;
    const down = state === 'down' && age < 4;
    return {
      status: down ? 'down' : 'up',
      observedAt: nowMs - age * MINUTE,
      ...(down ? {} : { latencyMs: wave(index, 140, 20) }),
      ...(down
        ? {
            cause: {
              kind: 'http',
              vantage: 'outside',
              httpStatus: 502,
              expectStatus: 200,
            },
          }
        : {}),
      evidence: { kind: 'none' },
    };
  });
}

function history(nowMs: number, uptimePercent: number) {
  const today = Math.floor(nowMs / DAY) * DAY;
  return {
    lastObservedAt: nowMs,
    uptimePercent,
    days: Array.from({ length: 30 }, (_, index) => ({
      dayStartAt: today - (29 - index) * DAY,
      up: 1440,
      down: 0,
      degraded: 0,
      unknown: 0,
      uptimePercent: 100,
    })),
  };
}

export function createServiceCheckRowFixture(
  input: Readonly<{
    key: string;
    state: ServiceCheckRowFixtureState;
    /** A Key flow check; absent, an HTTP check on `target`. */
    keyFlow?: TelemetryKeyFlowConfigV1;
    target?: string;
    /** The failing Key flow's newest measured value. */
    failingValue?: number;
    nowMs?: number;
    enabled?: boolean;
  }>,
): ManagedConfiguredCheckRow {
  const nowMs = input.nowMs ?? Math.floor(Date.now() / MINUTE) * MINUTE;
  const keyFlow = input.keyFlow ?? null;
  const recent = keyFlow
    ? keyFlowResults(input.state, nowMs, input.failingValue ?? 1420)
    : httpResults(input.state, nowMs);
  const failing = input.state === 'failing' || input.state === 'down';
  const target =
    keyFlow && keyFlow.measure.kind === 'route'
      ? keyFlow.measure.routes
          .map((route) => `${route.method} ${route.route}`)
          .join(', ')
      : (input.target ?? 'billing.acme.dev/health');
  return {
    kind: 'configuredCheck',
    key: input.key,
    scope: SCOPE,
    automationId: `automation-${input.key}`,
    triggerId: 'trigger-1',
    native: {
      id: `automation-${input.key}`,
      name: keyFlow ? `${keyFlow.name} key flow` : target,
      templateVersion: 1,
      enabled: input.enabled ?? true,
      triggers: [],
    },
    definitionFacts: {
      kind: 'available',
      observerMachineId: 'collector',
      checks: [
        {
          checkId: input.key,
          name: keyFlow ? 'Key flow' : 'HTTP',
          targetLabel: target,
          periodMs: MINUTE,
          domainId: null,
          keyFlow,
        },
      ],
    },
    lastResults: {
      kind: 'available',
      checks: [
        {
          checkId: input.key,
          result: recent.at(-1)!,
          recentResults: recent,
          recentResultsCoverage: 'complete',
          history: history(nowMs, failing ? 96.4 : 99.98),
          ...(failing
            ? { failingSince: nowMs - 3 * MINUTE, failureStreak: 3 }
            : {}),
        },
      ],
    },
  } as never;
}
