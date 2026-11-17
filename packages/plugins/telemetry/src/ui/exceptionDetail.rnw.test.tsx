// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getTelemetryException,
  TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1,
  TELEMETRY_EXCEPTION_SOURCE_V1,
  exceptionLocalRefV1,
} from '../exceptions/source.js';
import { renderSurface } from './exceptionDetail.js';

/**
 * The native exception detail, mounted the way Triage mounts it: the launch input is what the
 * source's exact `get` produced, and every collector read goes through the telemetry occurrence
 * Action at the mounted Host API boundary.
 */

const instance = {
  v: 1 as const,
  instance: {
    source: TELEMETRY_EXCEPTION_SOURCE_V1,
    sourceInstanceId: '0b0e57a0-3c7e-4c7a-9f39-6a4f1f0a1b2c',
  },
  binding: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.binding,
  localInstanceKey: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.localInstanceKey,
  configuration: TELEMETRY_EXCEPTION_SOURCE_DRAFT_V1.configuration,
};

const NOW = Date.UTC(2026, 10, 17, 19, 50);
const record = {
  id: 'issue-1',
  environmentId: 'env-production',
  fingerprint: 'fp-currency',
  title: 'TypeError: Cannot read properties of undefined (reading ’currency’)',
  serviceName: 'billing-api',
  type: 'TypeError',
  topFrame: 'formatTotal (lib/billing/totals.ts:42)',
  status: 'open' as const,
  regressed: true as const,
  count: 312,
  firstSeenAtMs: NOW - 5 * 86_400_000,
  lastSeenAtMs: NOW - 120_000,
  asOfMs: NOW - 60_000,
  lastServiceVersion: 'v1.43',
  resolution: {
    atMs: NOW - 3 * 86_400_000,
    version: 'v1.42',
    priorVersions: ['v1.41'],
  },
  createdAtMs: NOW - 5 * 86_400_000,
  updatedAtMs: NOW - 60_000,
};

/** The launch input from the source's own exact read, so the surface admits what the source produces. */
async function detailInput(shared: boolean, panel?: string) {
  const row = {
    rowId: 'issue-1',
    value: record,
    ...(shared ? { ownerAccountId: 'owner-1' } : {}),
  };
  const collection = {
    get: async () => row,
    sharing: { get: async () => row },
  };
  const got = await getTelemetryException(
    {
      v: 1,
      instance,
      localRef: exceptionLocalRefV1('issue-1', shared ? 'owner-1' : undefined),
    },
    {
      signal: new AbortController().signal,
      services: { storage: { account: { collection: () => collection } } },
    } as never,
  );
  if (got.kind !== 'present') throw new Error('fixture issue absent');
  const { kind: _kind, localRef, detailData, ...present } = got;
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    instance,
    detailData,
    observation: {
      entryRef: { source: TELEMETRY_EXCEPTION_SOURCE_V1, ...localRef },
      observedAtMs: NOW,
      locator: present.locator,
      snapshot: present.snapshot,
      viewer: present.viewer,
    },
    linkedSessions: [],
    ...(panel === undefined ? {} : { panel }),
  });
}

const OCCURRENCES = [
  {
    id: 'occ-3',
    at: NOW - 120_000,
    origin: 'span',
    serviceName: 'api-2',
    serviceVersion: 'v1.43',
    type: 'TypeError',
    message: 'Cannot read properties of undefined',
    topFrame: record.topFrame,
    traceId: 'trace-7f2c',
    spanId: 'span-receipt',
  },
  {
    id: 'occ-2',
    at: NOW - 140_000,
    origin: 'span',
    serviceName: 'api-1',
    serviceVersion: 'v1.43',
  },
];
const STACK = [
  'TypeError: Cannot read properties of undefined',
  '    at formatTotal (lib/billing/totals.ts:42:18)',
  '    at buildReceipt (lib/billing/receipt.ts:18:9)',
  '    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)',
].join('\n');

type Call = Readonly<{ localId: string; input: JsonValue }>;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(
  input: JsonValue,
  read: (input: Record<string, unknown>, localId: string) => Promise<JsonValue>,
) {
  const calls: Call[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        instanceId: 'telemetry-exception-detail',
        mountNonce: 'mount-1',
      },
      authorPlugin: { id: 'happier.telemetry', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        locale: 'en-GB',
        accountScope: { serverId: 'home-1', accountId: 'account-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input,
      handlers: {
        executeAction: async ({ action, input: actionInput }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          calls.push({ localId, input: actionInput as JsonValue });
          return await read(actionInput as Record<string, unknown>, localId);
        },
      },
    });
  });
  mounted.push(fixture);
  return { page: fixture, calls };
}

const HOUR = 3_600_000;
/** The trend the collector answers for whatever window the surface authored: one count per bucket. */
function trendFor(window: { since: number; until: number; bucketMs: number }) {
  const buckets = [];
  for (let since = window.since; since < window.until; since += window.bucketMs)
    buckets.push({ since, until: Math.min(since + window.bucketMs, window.until), count: since >= window.until - 6 * window.bucketMs ? 40 : 0 });
  return buckets;
}

const okRead = async (input: Record<string, unknown>): Promise<JsonValue> => {
  const window = input.window as { since: number; until: number; bucketMs: number } | undefined;
  return {
    status: 'ok',
    items: OCCURRENCES,
    ...(input.occurrenceId === undefined ? {} : { stacktrace: STACK }),
    ...(window === undefined ? {} : { trend: trendFor(window), requestsAffected: 287 }),
  };
};

/** The occurrence's request as the existing capture trace read returns it (summaries carry no bodies). */
const span = (id: string, at: number, durationMs: number, extra: Record<string, unknown>) => ({
  id, worktree: 'env', kind: 'span', source: 'otlp', at, durationMs, traceId: 'trace-7f2c', ...extra,
});
const TRACE = {
  ok: true,
  source: { kind: 'environment', serverId: 'home-1', environmentId: 'env-production' },
  traceId: 'trace-7f2c',
  summaries: [
    span('root', 1_000, 412, { spanId: 'span-root', spanKind: 2, endpointMethod: 'POST', endpointRoute: '/checkout', httpStatusCode: 500, outcome: 'error' }),
    span('stripe', 1_040, 318, { spanId: 'span-stripe', parentSpanId: 'span-root', shape: 'stripe.paymentIntents.create' }),
    span('receipt', 1_360, 58, { spanId: 'span-receipt', parentSpanId: 'span-root', shape: 'buildReceipt', outcome: 'error' }),
    { id: 'log-1', worktree: 'env', kind: 'log', source: 'otlp', at: 1_004, traceId: 'trace-7f2c', spanId: 'span-root', severityNumber: 9 },
    { id: 'log-2', worktree: 'env', kind: 'log', source: 'otlp', at: 1_400, traceId: 'trace-7f2c', spanId: 'span-receipt', severityNumber: 17 },
  ],
  repeatedQueries: [],
  slowChildSpans: [],
  logCorrelations: [
    { logId: 'log-1', traceId: 'trace-7f2c', spanId: 'span-root', spanObservationId: 'root' },
    { logId: 'log-2', traceId: 'trace-7f2c', spanId: 'span-receipt', spanObservationId: 'receipt' },
  ],
};

/** The collector answers each read by the Action it went through. */
const collectorRead = (input: Record<string, unknown>, localId: string): Promise<JsonValue> => {
  if (localId === 'capture/trace/get') return Promise.resolve(TRACE as unknown as JsonValue);
  if (localId === 'capture/query/get')
    return Promise.resolve({ ok: true, source: TRACE.source, detail: { body: `body of ${String(input.id)}` } } as JsonValue);
  return okRead(input);
};

describe('the Happier exception detail', () => {
  it('states the spread from the exact read and reads the trend and Requests affected once from the collector', async () => {
    const { page, calls } = await mount(
      (await detailInput(false, 'overview')) as unknown as JsonValue,
      okRead,
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('Resolved in')).resolves.toBeDefined();
    });
    await expect(page.getByText('v1.42')).resolves.toBeDefined();
    await expect(page.getByText('~312')).resolves.toBeDefined();
    await vi.waitFor(async () => {
      await expect(page.getByText('287')).resolves.toBeDefined();
    });
    await expect(page.getByText('Requests affected')).resolves.toBeDefined();
    await expect(page.getByText('Last 7 days')).resolves.toBeDefined();
    // One read serves the trend and the first occurrence page; the window is whole hours over seven days.
    expect(calls).toHaveLength(1);
    const window = (calls[0]!.input as { window: { since: number; until: number; bucketMs: number } }).window;
    expect(window.until - window.since).toBe(7 * 24 * HOUR);
    expect(window.until % window.bucketMs).toBe(0);
    expect(window.bucketMs % HOUR).toBe(0);
  });

  it('reads nothing for a Team-shared issue’s overview', async () => {
    const { page, calls } = await mount(
      (await detailInput(true, 'overview')) as unknown as JsonValue,
      okRead,
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('~312')).resolves.toBeDefined();
    });
    expect(calls).toEqual([]);
  });

  it('reads this issue’s occurrences on the viewer’s Home only when the panel opens', async () => {
    const { page, calls } = await mount(
      (await detailInput(false, 'occurrences')) as unknown as JsonValue,
      okRead,
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('v1.43 · api-2')).resolves.toBeDefined();
    });
    expect(calls).toEqual([
      {
        localId: 'capture/exceptions/occurrences/read',
        input: {
          serverId: 'home-1',
          environmentId: 'env-production',
          fingerprint: 'fp-currency',
          page: { limit: 25 },
          window: expect.objectContaining({ bucketMs: expect.any(Number) }),
        },
      },
    ]);
  });

  it('reads the newest occurrence’s stack on demand and says how the issue is grouped', async () => {
    const { page, calls } = await mount(
      (await detailInput(false, 'stack-trace')) as unknown as JsonValue,
      collectorRead,
    );
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.localId === 'capture/exceptions/occurrences/read')).toHaveLength(2);
    });
    // The stack opens on its frames (the frame header already names the exception).
    await vi.waitFor(async () => {
      await expect(page.getByText('formatTotal')).resolves.toBeDefined();
    });
    await expect(page.getByText('lib/billing/totals.ts:42:18')).resolves.toBeDefined();
    expect(document.body.textContent).toContain(
      `Grouped by type, message and top frame ${record.topFrame}`,
    );
    // Library frames fold under one counted row.
    await expect(page.getByText('Frames from libraries and Node')).resolves.toBeDefined();
    await expect(page.queryByText('Layer.handle')).resolves.toBeUndefined();
    expect(
      calls
        .filter((call) => call.localId === 'capture/exceptions/occurrences/read')
        .map((call) => (call.input as { occurrenceId?: string }).occurrenceId),
    ).toEqual([undefined, 'occ-3']);
  });

  it('draws the occurrence’s request from the capture trace read and reads a log body only when opened', async () => {
    const { page, calls } = await mount(
      (await detailInput(false, 'stack-trace')) as unknown as JsonValue,
      collectorRead,
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('The request')).resolves.toBeDefined();
    });
    expect(calls.filter((call) => call.localId === 'capture/trace/get')).toEqual([
      {
        localId: 'capture/trace/get',
        input: {
          source: { kind: 'environment', serverId: 'home-1', environmentId: 'env-production' },
          traceId: 'trace-7f2c',
          page: { limit: expect.any(Number) },
        },
      },
    ]);
    // The span this occurrence threw in says so; the request line names its route and time.
    await vi.waitFor(async () => {
      await expect(page.getByText('POST /checkout · 412 ms · v1.43')).resolves.toBeDefined();
    });
    // The span that threw carries its tag where the waterfall row is read.
    expect((await page.getAllByRole('button')).some((target) => target.name?.includes('threw'))).toBe(true);
    await expect(page.getByText('Logs from this request')).resolves.toBeDefined();
    expect(calls.some((call) => call.localId === 'capture/query/get')).toBe(false);
    const errorLine = (await page.getAllByRole('button')).find((target) => target.name?.includes('error'));
    expect(errorLine).toBeDefined();
    await act(async () => {
      await page.press(errorLine!);
    });
    await vi.waitFor(async () => {
      await expect(page.getByText('body of log-2')).resolves.toBeDefined();
    });
    expect(calls.filter((call) => call.localId === 'capture/query/get').map((call) => call.input)).toEqual([
      { source: TRACE.source, id: 'log-2' },
    ]);
  });

  it('sends a Team-shared issue to its owner’s collector instead of reading', async () => {
    const { page, calls } = await mount(
      (await detailInput(true, 'occurrences')) as unknown as JsonValue,
      okRead,
    );
    await vi.waitFor(async () => {
      await expect(
        page.getByText('Occurrences stay with the owner'),
      ).resolves.toBeDefined();
    });
    expect(calls).toEqual([]);
  });

  it('keeps the issue usable when the collector is away and reads again on Retry', async () => {
    let fail = true;
    const { page, calls } = await mount(
      (await detailInput(false, 'occurrences')) as unknown as JsonValue,
      async (input) => {
        if (fail)
          throw new PluginError({
            code: 'collector_unavailable',
            retryable: true,
          });
        return await okRead(input);
      },
    );
    await vi.waitFor(async () => {
      await expect(
        page.getByText('The collector isn’t answering'),
      ).resolves.toBeDefined();
    });
    fail = false;
    await act(async () => {
      await page.press(await page.getByRole('button', { name: 'Retry' }));
    });
    await vi.waitFor(async () => {
      await expect(page.getByText('v1.43 · api-2')).resolves.toBeDefined();
    });
    expect(calls).toHaveLength(2);
  });
});
