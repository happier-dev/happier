// @vitest-environment jsdom

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
    DATABASE_STATS_READ_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import { type DatabaseDescriptorV1, type DatabaseStatsObservationV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkitExecuteActionInput,
} from '@happier-dev/plugin-sdk/testing';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface as renderPage } from '../WorkbenchPage.js';
import { renderSurface as renderRail } from '../DatabaseRailTab.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = createDatabaseDescriptorV1Fixture();
const descriptor: DatabaseDescriptorV1 = {
  ...fixture,
  label: 'billing_dev',
  origin: { label: 'web' },
  access: { canRead: true, canWrite: false },
};
const scope =
  descriptor.target.kind === 'worktree'
    ? {
        kind: 'worktree' as const,
        accountId: descriptor.target.accountId,
        installationId: descriptor.target.installationId,
        projectKey: descriptor.target.projectKey,
        workspace: descriptor.target.workspace,
      }
    : (() => {
        throw new Error('fixture is a worktree target');
      })();

const basis = {
  bindingKey: 'binding',
  databaseIdentity: 'billing_dev',
  selectionKey: 'statements',
};
const SLOW =
  'SELECT i.id, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status = $1';
const LINES = 'SELECT * FROM invoice_lines WHERE invoice_id = $1';
function statements(): DatabaseStatsObservationV1 {
  return {
    v: 1,
    observedAtMs: Date.parse('2026-11-17T14:05:00Z'),
    engineId: 'postgresql',
    scope: { database: 'billing_dev' },
    intervalBasis: basis,
    status: 'available',
    group: 'statements',
    coverage: { status: 'complete' },
    completeness: { complete: true },
    data: [
      {
        key: 'q-slow',
        database: 'billing_dev',
        shape: SLOW,
        calls: '18420',
        totalTimeMs: 758_904,
        rows: '4236600',
        nativeTimeUnit: 'milliseconds',
        blocksHit: '992',
        blocksRead: '8',
      },
      {
        key: 'q-lines',
        database: 'billing_dev',
        shape: LINES,
        calls: '2100000',
        totalTimeMs: 441_000,
        rows: '9240000',
        nativeTimeUnit: 'milliseconds',
      },
    ],
  };
}
const extensionMissing: DatabaseStatsObservationV1 = {
  v: 1,
  observedAtMs: 1,
  engineId: 'postgresql',
  scope: { database: 'billing_dev' },
  intervalBasis: basis,
  status: 'unavailable',
  group: 'statements',
  reason: 'extension_missing',
  remediation: "shared_preload_libraries = 'pg_stat_statements'",
};

function resourceHandlers() {
  const text = JSON.stringify({
    descriptor,
    ownWriteRevision: 0,
    relationRevisions: [],
  });
  const digest = `sha256:${computeSha256HexDigest(text)}`;
  return {
    readResource: async () => ({
      contentType: 'application/json',
      digest,
      bytes: new TextEncoder().encode(text),
    }),
    watchResource: async () => ({ digest }),
    deviceState: () => ({ status: 'ready' as const, value: null }),
    notify: () => {},
    setUnsavedChanges: async () => {},
  };
}

/** The daemon's Action answers; the host Action boundary is the only fake. */
function daemon(observation: () => DatabaseStatsObservationV1) {
  return vi.fn(
    async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> =>
      projectNativeJsonValueForTransport(
        (() => {
          switch (action) {
            case databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1):
              return {
                targets: [descriptor],
                completeness: { complete: true },
              };
            case databaseActionLocalIdV1(DATABASE_SCHEMAS_LIST_ACTION_ID_V1):
              return {
                ok: true,
                operation: 'schemas.list',
                schemas: [{ name: 'public' }],
                completeness: { complete: true },
              };
            case databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1):
              return {
                ok: true,
                operation: 'stats.read',
                observation: observation(),
              };
            default:
              throw new Error(`unexpected Action ${String(action)}`);
          }
        })(),
      ),
  );
}

async function settle(rounds = 20) {
  for (let index = 0; index < rounds; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function pageContext() {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: {
        pluginId: 'happier.database',
        localId: 'database-workbench',
      },
      container: 'appPage',
    },
    target: { kind: 'app' },
  });
}

describe('Database Insights surfaces', () => {
  it('opens Insights on statements by total time, read once, with each shape as the row', async () => {
    const executeAction = daemon(statements);
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'insights', mountNonce: 'insights' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: pageContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(),
        executeAction,
        replacePageLocation: async ({ subPath }) => subPath,
      },
    });
    try {
      await settle();
      expect(await page.queryByText(SLOW)).toBeTruthy();
      expect(await page.queryByText(LINES)).toBeTruthy();
      expect(
        executeAction.mock.calls.filter(
          ([call]) => call.action === databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1),
        ),
      ).toHaveLength(1);
    } finally {
      await page.dispose();
    }
  });

  it('shows the one diagnosed setup state with the producer’s setting when statement statistics are off', async () => {
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'setup', mountNonce: 'setup' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: pageContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(),
        executeAction: daemon(() => extensionMissing),
        replacePageLocation: async ({ subPath }) => subPath,
      },
    });
    try {
      await settle();
      expect(
        await page.queryByText('See which statements cost the most'),
      ).toBeTruthy();
      expect(
        await page.queryByText(
          "shared_preload_libraries = 'pg_stat_statements'",
        ),
      ).toBeTruthy();
    } finally {
      await page.dispose();
    }
  });

  it('opens a statement from the Insights rail tab as a details tab at that statement', async () => {
    const openSurface = vi.fn(async () => {});
    const rail = await createPluginUiTestkit({
      identity: { instanceId: 'rail', mountNonce: 'rail' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'happier.database',
            localId: 'insights-session-rail',
          },
          container: 'rightSidebarTab',
        },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(),
        executeAction: daemon(statements),
        openSurface,
      },
    });
    try {
      await settle();
      expect(await rail.queryByText(SLOW)).toBeTruthy();
      // Controls in order: the database picker, the ranked statements (costliest first), then Refresh.
      const controls = await rail.getAllByRole('button');
      expect(controls).toHaveLength(4);
      await act(async () => {
        await rail.press(controls[1]!);
      });
      expect(openSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({
            localId: 'insights-session-details',
          }),
          subPath: 'statement/q-slow',
        }),
      );
    } finally {
      await rail.dispose();
    }
  });

  it('rereads the opened statement by key and says how much of it was read from memory', async () => {
    const executeAction = daemon(statements);
    const details = await createPluginUiTestkit({
      identity: { instanceId: 'details', mountNonce: 'details' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'statement/q-slow',
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'happier.database',
            localId: 'insights-session-details',
          },
          container: 'detailsPane',
        },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...resourceHandlers(), executeAction },
    });
    try {
      await settle();
      const read = executeAction.mock.calls.find(
        ([call]) => call.action === databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1),
      )?.[0];
      expect(read?.input).toMatchObject({
        request: { group: 'statements', selection: { statementKey: 'q-slow' } },
      });
      expect(await details.queryByText('99.2%')).toBeTruthy();
    } finally {
      await details.dispose();
    }
  });
});
