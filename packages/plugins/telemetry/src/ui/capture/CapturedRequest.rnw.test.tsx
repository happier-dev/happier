// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import type { DatabaseCaptureSummaryV1 } from '@happier-dev/database-protocol';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CapturedLogLines,
  CapturedRequestSlowest,
  CapturedRequestWaterfall,
  type CapturedTraceV1,
} from './CapturedRequest.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The captured request's shared parts (DESIGN-1118-B delta 1), mounted the way a plugin surface mounts them: the
 * slowest steps' share bars, the waterfall's SQL rows and the log lines' hanging indent.
 */
const NOW = Date.UTC(2026, 10, 17, 19, 48, 12);
const base = {
  worktree: 'environment:production',
  source: 'otlp' as const,
  traceId: 'trace-1',
  serviceName: 'billing-api',
};
const span = (
  id: string,
  at: number,
  durationMs: number,
  extra: Partial<DatabaseCaptureSummaryV1> = {},
): DatabaseCaptureSummaryV1 => ({
  ...base,
  id,
  kind: 'span',
  at,
  durationMs,
  spanId: id,
  ...extra,
});
const trace: CapturedTraceV1 = {
  ok: true,
  source: {
    kind: 'environment',
    serverId: 'home',
    environmentId: 'production',
  },
  traceId: 'trace-1',
  repeatedQueries: [],
  slowChildSpans: [],
  logCorrelations: [],
  summaries: [
    span('root', NOW, 400, {
      spanKind: 2,
      endpointMethod: 'POST',
      endpointRoute: '/checkout',
      httpStatusCode: 500,
    }),
    span('stripe', NOW + 20, 300, {
      parentSpanId: 'root',
      shape: 'stripe.paymentIntents.create',
      spanKind: 3,
    }),
    {
      ...base,
      id: 'q-carts',
      kind: 'query',
      at: NOW + 330,
      durationMs: 6,
      parentSpanId: 'root',
      shape: 'SELECT * FROM carts WHERE id = $1',
    },
  ],
};
const longError: DatabaseCaptureSummaryV1 = {
  ...base,
  id: 'log-1',
  kind: 'log',
  at: NOW + 50,
  severityNumber: 17,
  bodyPrefix:
    "TypeError: Cannot read properties of undefined (reading 'total') at formatTotal (receipt.ts:42) while building the receipt",
};

let mounted: PluginUiTestkit | undefined;
afterEach(async () => {
  await mounted?.dispose();
  mounted = undefined;
});

async function mount(content: () => ReactElement) {
  await act(async () => {
    mounted = await createPluginUiTestkit({
      identity: { instanceId: 'captured-request', mountNonce: 'mount-1' },
      authorPlugin: { id: 'happier.telemetry', version: '0.0.0' },
      surface: defineUiSurface(content),
      surfaceContext: createSurfaceContextFixture({ locale: 'en-GB' }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: null,
      handlers: {},
    });
  });
}

const byTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('a captured request', () => {
  it('draws each slowest step’s share of the request as a bar', async () => {
    await mount(() => <CapturedRequestSlowest trace={trace} locale="en-GB" />);
    const fill = byTestId('telemetry.request.slowest.share.stripe-meter-fill');
    expect(fill).not.toBeNull();
    expect(fill!.style.width).toBe('75%');
  });

  it('sets a waterfall’s SQL rows in the code face, led by the database mark', async () => {
    await mount(() => (
      <CapturedRequestWaterfall
        trace={trace}
        locale="en-GB"
        title="Waterfall"
      />
    ));
    const label = [...document.querySelectorAll<HTMLElement>('div, span')].find(
      (node) =>
        node.childElementCount === 0 &&
        node.textContent === 'SELECT * FROM carts WHERE id = $1' &&
        node.style.fontFamily !== '',
    );
    expect(label).toBeDefined();
    const request = [
      ...document.querySelectorAll<HTMLElement>('div, span'),
    ].find(
      (node) =>
        node.childElementCount === 0 && node.textContent === 'POST /checkout',
    )!;
    expect(request.style.fontFamily).toBe('');
  });

  it('hangs a wrapped log message under itself, not under the line’s clock', async () => {
    await mount(() => (
      <CapturedLogLines
        logs={[longError]}
        locale="en-GB"
        readBody={async () => null}
        testIDPrefix="t"
      />
    ));
    const message = byTestId('t.log.log-1.message');
    expect(message).not.toBeNull();
    // The message is its own column beside the clock and level, so its wrapped lines start under its first word.
    expect(message!.textContent).toContain('TypeError');
    expect(message!.textContent).not.toContain('error  ');
    expect(byTestId('t.log.log-1.prefix')?.textContent).toContain('error');
  });
});
