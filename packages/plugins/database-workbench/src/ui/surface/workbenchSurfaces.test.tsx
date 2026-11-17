// @vitest-environment jsdom

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_RELATIONS_LIST_ACTION_ID_V1,
  DATABASE_ROWS_READ_ACTION_ID_V1,
  DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
  DATABASE_STRUCTURE_READ_ACTION_ID_V1,
  DATABASE_TARGETS_LIST_ACTION_ID_V1,
  type DatabaseDescriptorV1,
} from '@happier-dev/database-protocol';
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
import { renderSurface as renderPanel } from './DatabasesPanel.js';
import { renderSurface as renderPage } from './WorkbenchPage.js';
import { WORKBENCH_PAGE_VIEW_ID } from './views.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function billingDatabase(): DatabaseDescriptorV1 {
  const descriptor = createDatabaseDescriptorV1Fixture();
  return {
    ...descriptor,
    label: 'billing_dev',
    origin: { label: 'web' },
    target:
      descriptor.target.kind === 'worktree'
        ? {
            ...descriptor.target,
            source: {
              kind: 'service',
              serviceId: 'web',
              variable: 'DATABASE_URL',
            },
          }
        : descriptor.target,
    access: { canRead: true, canWrite: false },
  };
}
const descriptor = billingDatabase();
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
const invoices = { schema: 'public', name: 'invoices' };

/** The mounted Resource transport supplies the selected connection's admitted snapshot. */
function connectionResourceHandlers() {
  const text = JSON.stringify({ descriptor, ownWriteRevision: 0, relationRevisions: [] });
  const digest = `sha256:${computeSha256HexDigest(text)}`;
  return {
    readResource: async () => ({ contentType: 'application/json', digest, bytes: new TextEncoder().encode(text) }),
    watchResource: async () => ({ digest }),
    deviceState: () => ({ status: 'ready' as const, value: null }),
    notify: () => {},
    setUnsavedChanges: async () => {},
  };
}

/** The daemon's Action results for a small Postgres database; the host Action boundary is the only fake. */
function daemonAnswers(targets: readonly DatabaseDescriptorV1[]) {
  return vi.fn(
    async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> =>
      projectNativeJsonValueForTransport(
        (() => {
          switch (action) {
            case DATABASE_TARGETS_LIST_ACTION_ID_V1:
              return { targets, completeness: { complete: true } };
            case DATABASE_SCHEMAS_LIST_ACTION_ID_V1:
              return {
                ok: true,
                operation: 'schemas.list',
                schemas: [{ name: 'public' }],
                completeness: { complete: true },
              };
            case DATABASE_RELATIONS_LIST_ACTION_ID_V1:
              return {
                ok: true,
                operation: 'relations.list',
                completeness: { complete: true },
                relations: [
                  { relation: invoices, kind: 'table', estimatedRows: '48210' },
                  {
                    relation: { schema: 'public', name: 'customers' },
                    kind: 'table',
                    estimatedRows: '12040',
                  },
                ],
              };
            case DATABASE_STRUCTURE_READ_ACTION_ID_V1:
              return {
                ok: true,
                operation: 'relation.structure',
                structure: {
                  relation: invoices, kind: 'table',
                  columns: [
                    {
                      name: 'id',
                      nativeType: 'int8',
                      semanticType: 'integer',
                      nullable: false,
                      generated: false,
                    },
                    {
                      name: 'number',
                      nativeType: 'text',
                      semanticType: 'text',
                      nullable: false,
                      generated: false,
                    },
                    {
                      name: 'status',
                      nativeType: 'invoice_status',
                      semanticType: 'text',
                      nullable: false,
                      generated: false,
                    },
                  ],
                  primaryKey: ['id'],
                  foreignKeys: [],
                  indexes: [],
                  capabilities: [],
                },
              };
            case DATABASE_ROWS_READ_ACTION_ID_V1:
              return {
                ok: true,
                operation: 'rows.read',
                result: {
                  columns: [
                    {
                      name: 'id',
                      nativeType: 'int8',
                      semanticType: 'integer',
                      nullable: false,
                    },
                    {
                      name: 'number',
                      nativeType: 'text',
                      semanticType: 'text',
                      nullable: false,
                    },
                    {
                      name: 'status',
                      nativeType: 'invoice_status',
                      semanticType: 'text',
                      nullable: false,
                    },
                  ],
                  rows: [
                    {
                      cells: [
                        { type: 'integer', value: '48212' },
                        { type: 'text', value: 'INV-2026-04812' },
                        { type: 'text', value: 'open' },
                      ],
                    },
                  ],
                  estimate: '48210',
                  completeness: { complete: true },
                },
              };
            default:
              throw new Error(`unexpected Action ${String(action)}`);
          }
        })(),
      ),
  );
}


/** Reads settle through real promises; let them land before asking what is on screen. */
async function settle(rounds = 10) {
    for (let index = 0; index < rounds; index += 1) await act(async () => { await Promise.resolve(); });
}

describe('Database workbench surfaces', () => {
  it('lists the checkout’s databases on Dev servers and opens the chosen one in the workbench', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const openSurface = vi.fn(async () => {});
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'panel', mountNonce: 'panel' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPanel,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'happier.database',
            localId: 'databases-panel',
          },
          container: 'servicesPanel',
        },
        target: { kind: 'services' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction, openSurface },
    });
    try {
      await settle();
      expect(await fixture.queryByText('billing_dev')).toBeTruthy();
      // The database row is the panel's only control while one database is found.
      const [row, ...others] = await fixture.getAllByRole('button');
      expect(others).toHaveLength(0);
      await act(async () => {
        await fixture.press(row!);
      });
      expect(openSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({ localId: WORKBENCH_PAGE_VIEW_ID }),
          input: expect.objectContaining({
            descriptor: expect.objectContaining({ label: 'billing_dev' }),
          }),
        }),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('says plainly when the checkout’s services name no database', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'empty', mountNonce: 'empty' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPanel,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'happier.database',
            localId: 'databases-panel',
          },
          container: 'servicesPanel',
        },
        target: { kind: 'services' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: daemonAnswers([]) },
    });
    try {
      expect(await fixture.getByText('No databases found in this checkout’s services')).toBeTruthy();
    } finally {
      await fixture.dispose();
    }
  });

  it('opens on the table its location names and reads its structure once', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page', mountNonce: 'page' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'happier.database',
            localId: 'database-workbench',
          },
          container: 'appPage',
        },
        target: { kind: 'app' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(),
        executeAction,
        setUnsavedChanges: async () => {},
        replacePageLocation: async ({ subPath }) => subPath,
      },
    });
    try {
      await settle(20);
      expect(executeAction.mock.calls.some(([call]) => call.action === DATABASE_ROWS_READ_ACTION_ID_V1)).toBe(true);
      // The row leads with its key, grouped for reading; narrower columns stay in the row pane.
      expect(await fixture.getByText('48,212')).toBeTruthy();
      // One structure read serves the page; nothing re-reads it per row or per cell.
      expect(
        executeAction.mock.calls.filter(
          ([call]) => call.action === DATABASE_STRUCTURE_READ_ACTION_ID_V1,
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
});
