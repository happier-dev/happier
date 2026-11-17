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
  },
  {
    id: 'occ-2',
    at: NOW - 140_000,
    origin: 'span',
    serviceName: 'api-1',
    serviceVersion: 'v1.43',
  },
];
// One line: the shared CodeBlock owns how a multi-line body is laid out.
const STACK = 'TypeError: Cannot read properties of undefined at formatTotal (lib/billing/totals.ts:42:18)';

type Call = Readonly<{ localId: string; input: JsonValue }>;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mount(
  input: JsonValue,
  read: (input: Record<string, unknown>) => Promise<JsonValue>,
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
          return await read(actionInput as Record<string, unknown>);
        },
      },
    });
  });
  mounted.push(fixture);
  return { page: fixture, calls };
}

const okRead = async (input: Record<string, unknown>): Promise<JsonValue> => ({
  status: 'ok',
  items: OCCURRENCES,
  ...(input.occurrenceId === undefined ? {} : { stacktrace: STACK }),
});

describe('the Happier exception detail', () => {
  it('states the regression and the spread from the exact read without reading the collector', async () => {
    const { page, calls } = await mount(
      (await detailInput(false, 'overview')) as unknown as JsonValue,
      okRead,
    );
    await vi.waitFor(async () => {
      await expect(page.getByText('Resolved in')).resolves.toBeDefined();
    });
    await expect(page.getByText('v1.42')).resolves.toBeDefined();
    await expect(page.getByText('~312')).resolves.toBeDefined();
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
        },
      },
    ]);
  });

  it('reads the newest occurrence’s stack on demand and says how the issue is grouped', async () => {
    const { page, calls } = await mount(
      (await detailInput(false, 'stack-trace')) as unknown as JsonValue,
      okRead,
    );
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await vi.waitFor(async () => {
      await expect(page.getByText(STACK)).resolves.toBeDefined();
    });
    await expect(
      page.getByText(
        `Grouped by type, message and top frame ${record.topFrame}`,
      ),
    ).resolves.toBeDefined();
    expect(
      calls.map(
        (call) => (call.input as { occurrenceId?: string }).occurrenceId,
      ),
    ).toEqual([undefined, 'occ-3']);
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
