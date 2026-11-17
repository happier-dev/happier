// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSurface as renderAppVitals } from './appVitalsWidget.js';
import { renderSurface as renderMetric } from './metricWidget.js';
import { rankSlowestRoutes, renderSurface as renderSlowestRoutes } from './slowestRoutesWidget.js';

/**
 * The Telemetry widgets mounted the way Home mounts an installed widget: the bindings arrive as the
 * launch input, and every read crosses the mounted Host API (the collector Actions and the
 * Environment list). Only that boundary is answered here; the widgets' own logic runs for real.
 */

const ENVIRONMENT = { serverId: 'home-1', environmentId: 'env-production' };
const HOUR = 3_600_000;

type Call = Readonly<{ localId: string; input: Record<string, unknown> }>;
type Answer = (localId: string, input: Record<string, unknown>) => JsonValue;

const ENVIRONMENTS = {
  ok: true,
  items: [
    {
      id: 'env-production',
      name: 'Production',
      projectSourceId: 'source-billing',
    },
  ],
  projectSources: [{ id: 'source-billing', name: 'billing-api' }],
};
const ENDPOINT = (
  route: string,
  requestCount: number,
  totalDurationMs: number,
  errorRate: number | null,
) => ({
  serviceName: 'billing-api/Production',
  method: 'POST',
  route,
  requestCount,
  errorCount: 0,
  errorRate,
  totalDurationMs,
  databaseTimeMs: 0,
});

/** The collector's p95 answer: one hour intervals, request counts and error rates per interval. */
function metricsAnswer(
  input: Record<string, unknown>,
  measured: Record<string, unknown>,
): JsonValue {
  const since = input.since as number;
  const until = input.until as number;
  const trend = [];
  for (let at = since; at < until; at += HOUR) {
    trend.push({
      since: at,
      until: Math.min(at + HOUR, until),
      unit: 'ms',
      value: 400,
      p95: 400,
      count: 3600,
      errorRate: 0.02,
    });
  }
  return {
    result: {
      status: 'up',
      observedAt: until,
      measurements: {
        measure: 'p95',
        unit: 'ms',
        basis: 'metric_points',
        producers: [{ serviceName: 'billing-api/Production' }],
        window: { since, until },
        completeness: 'complete',
        reasons: [],
        ...measured,
      },
      evidence: { kind: 'none' },
    },
    routes: [],
    trend,
  };
}

const okAnswer =
  (measured: Record<string, unknown>): Answer =>
  (localId, input) => {
    if (localId === 'deployments.environments.list') return ENVIRONMENTS;
    if (localId === 'capture/endpoints/list') {
      return {
        ok: true,
        source: input.source as JsonValue,
        items: [
          ENDPOINT('/cart', 200, 20_000, 0),
          ENDPOINT('/checkout', 100, 141_000, 0.05),
          ENDPOINT('/health', 0, 0, null),
        ],
      };
    }
    if (localId === 'capture/metrics/read')
      return metricsAnswer(input, measured);
    throw new Error(`unexpected ${localId}`);
  };

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(
  surface: typeof renderAppVitals,
  launchInput: JsonValue,
  answer: Answer,
) {
  const calls: Call[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'telemetry-widget', mountNonce: 'mount-1' },
      authorPlugin: { id: 'happier.telemetry', version: '0.0.0' },
      surface,
      surfaceContext: createSurfaceContextFixture({
        locale: 'en-GB',
        accountScope: { serverId: 'home-1', accountId: 'account-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput,
      handlers: {
        executeAction: async ({ action, input }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          calls.push({ localId, input: input as Record<string, unknown> });
          return answer(localId, input as Record<string, unknown>);
        },
      },
    });
  });
  mounted.push(fixture);
  return { page: fixture, calls };
}

describe('App vitals widget', () => {
  it('reads its Environment once on mount and draws requests, p95 and errors over the last 24 hours', async () => {
    const day = 24 * HOUR;
    const { page, calls } = await mount(
      renderAppVitals,
      { environment: ENVIRONMENT },
      okAnswer({
        p95Ms: 412,
        errorRate: 0.024,
        requestCount: Math.round((3.3 * day) / 1000),
      }),
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('412 ms')).resolves.toBeDefined();
    });
    await expect(page.getByText('3.3/s')).resolves.toBeDefined();
    await expect(page.getByText('2.4%')).resolves.toBeDefined();
    // One Environment name read, one route read for the service, one whole-service read: nothing per row or per line.
    expect(calls.map((call) => call.localId).sort()).toEqual([
      'capture/endpoints/list',
      'capture/metrics/read',
      'deployments.environments.list',
    ]);
    const metrics = calls.find(
      (call) => call.localId === 'capture/metrics/read',
    )!.input;
    expect(metrics).toMatchObject({
      ...ENVIRONMENT,
      serviceName: 'billing-api/Production',
      measure: { kind: 'http', statistic: 'p95' },
    });
    expect((metrics.until as number) - (metrics.since as number)).toBe(day);
  });

  it('keeps a missing value a dash and a zero a zero', async () => {
    const { page } = await mount(
      renderAppVitals,
      { environment: ENVIRONMENT },
      okAnswer({ errorRate: 0, requestCount: 0 }),
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('0%')).resolves.toBeDefined();
    });
    await expect(page.getByText('0/s')).resolves.toBeDefined();
    await expect(page.getByText('—')).resolves.toBeDefined();
  });

  it('says it is waiting for traffic, without a metrics read, when the window saw no request', async () => {
    const { page, calls } = await mount(
      renderAppVitals,
      { environment: ENVIRONMENT },
      (localId, input) =>
        localId === 'capture/endpoints/list'
          ? { ok: true, source: input.source as JsonValue, items: [] }
          : okAnswer({})(localId, input),
    );
    await vi.waitFor(async () => {
      await expect(
        page.getByText('Waiting for traffic'),
      ).resolves.toBeDefined();
    });
    expect(calls.some((call) => call.localId === 'capture/metrics/read')).toBe(
      false,
    );
  });

  it("shows the collector's typed refusal as the error block, with Retry", async () => {
    const { page } = await mount(
      renderAppVitals,
      { environment: ENVIRONMENT },
      (localId, input) =>
        localId === 'capture/endpoints/list'
          ? {
              ok: false,
              code: 'collector_unreachable',
              message: 'The collector is offline.',
            }
          : okAnswer({})(localId, input),
    );
    await vi.waitFor(async () => {
      await expect(
        page.getByText('Telemetry is unavailable'),
      ).resolves.toBeDefined();
    });
    await expect(page.getByText('Retry')).resolves.toBeDefined();
  });
});

describe('Metric widget', () => {
  it('reads the chosen metric over the chosen range', async () => {
    const { page, calls } = await mount(
      renderMetric,
      { environment: ENVIRONMENT, metric: 'errorRate', range: '7d' },
      okAnswer({ errorRate: 0.051 }),
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('5.1%')).resolves.toBeDefined();
    });
    const metrics = calls.find(
      (call) => call.localId === 'capture/metrics/read',
    )!.input;
    expect(metrics.measure).toEqual({ kind: 'http', statistic: 'errorRate' });
    expect((metrics.until as number) - (metrics.since as number)).toBe(
      7 * 24 * HOUR,
    );
  });
});

describe('Slowest routes widget', () => {
  it('ranks routes by mean time per request, slowest first, untimed last', () => {
    const ranked = rankSlowestRoutes([
      ENDPOINT('/cart', 200, 20_000, 0),
      ENDPOINT('/health', 0, 0, null),
      ENDPOINT('/checkout', 100, 141_000, 0.05),
    ]);
    expect(ranked.map(route => [route.route, route.meanMs, route.errorRate])).toEqual([
      ['POST /checkout', 1410, 0.05], ['POST /cart', 100, 0], ['POST /health', null, null],
    ]);
  });

  it('reads every page of the window\'s routes before it ranks them, and nothing else from the collector', async () => {
    const cursor = { serviceName: 'billing-api/Production', method: 'POST', route: '/cart' };
    const { calls } = await mount(renderSlowestRoutes, { environment: ENVIRONMENT }, (localId, input) => {
      if (localId !== 'capture/endpoints/list') return okAnswer({})(localId, input);
      const page = input.page as { before?: unknown };
      return page.before === undefined
        ? { ok: true, source: input.source as JsonValue, items: [ENDPOINT('/cart', 200, 20_000, 0)], nextCursor: cursor }
        : { ok: true, source: input.source as JsonValue, items: [ENDPOINT('/checkout', 100, 141_000, 0.05)] };
    });
    await vi.waitFor(() => {
      expect(calls.filter(call => call.localId === 'capture/endpoints/list')).toHaveLength(2);
    });
    expect((calls.filter(call => call.localId === 'capture/endpoints/list')[1]!.input.page as { before?: unknown }).before).toEqual(cursor);
    expect(calls.some(call => call.localId === 'capture/metrics/read')).toBe(false);
  });
});
