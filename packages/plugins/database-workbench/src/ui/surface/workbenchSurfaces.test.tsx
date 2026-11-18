// @vitest-environment jsdom

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DATABASE_RELATIONS_LIST_ACTION_ID_V1,
  DATABASE_ROWS_READ_ACTION_ID_V1,
  DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
  DATABASE_STATS_READ_ACTION_ID_V1,
  DATABASE_STRUCTURE_READ_ACTION_ID_V1,
  DATABASE_TARGETS_LIST_ACTION_ID_V1,
  readAutomationDatabaseSubjectV1,
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
import { renderSurface as renderRail } from './DatabaseRailTab.js';
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
function daemonAnswers(targets: readonly DatabaseDescriptorV1[], editableTextReference = false) {
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
                  { relation: invoices, kind: 'table', estimatedRows: '48210',
                    size: { bytes: '31000000', tableBytes: '18000000', indexBytes: '13000000', measurement: 'table_bytes_estimate' } },
                  {
                    relation: { schema: 'public', name: 'customers' },
                    kind: 'table',
                    estimatedRows: '12040',
                    size: { bytes: '4200000', tableBytes: '2600000', indexBytes: '1600000', measurement: 'table_bytes_estimate' },
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
                  foreignKeys: editableTextReference ? [{ name: 'invoice_customer', columns: ['number'],
                    target: { schema: 'public', name: 'customers' }, targetColumns: ['code'] }] : [],
                  incomingForeignKeys: [{ name: 'invoice_lines_invoice', source: { schema: 'public', name: 'invoice_lines' },
                    sourceColumns: ['invoice_id'], targetColumns: ['id'] }],
                  indexes: [],
                  capabilities: editableTextReference ? [{ operation: 'edits.apply', available: true }] : [],
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
                      ...(editableTextReference ? { identity: { key: [{ column: 'id', value: { type: 'integer', value: '48212' } }], original: [] } } : {}),
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
  it.each(['rail', 'directory'])('reaches later catalogue pages from the %s', async (surface) => {
    const base = daemonAnswers([descriptor]);
    const reads: (string | undefined)[] = [];
    const executeAction = async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action !== DATABASE_RELATIONS_LIST_ACTION_ID_V1) return base(request);
      // This fixture is the daemon Action boundary; the real host has already admitted its input.
      const input = request.input as { page: { after?: string } };
      reads.push(input.page.after);
      return projectNativeJsonValueForTransport({ ok: true, operation: 'relations.list',
        relations: [{ relation: { schema: 'public', name: input.page.after ? 'later_table' : 'first_table' }, kind: 'table', estimatedRows: '2' }],
        completeness: input.page.after ? { complete: true } : { complete: false, reason: 'page', continuation: {
          kind: 'catalog', operation: 'relations.list', target: descriptor.target, schema: 'public', after: 'second' } } });
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `paging-${surface}`, mountNonce: `paging-${surface}` },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope, ...(surface === 'directory' ? { descriptor } : {}) }),
      subPath: surface === 'directory' ? 'overview' : undefined,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: surface === 'directory' ? 'database-session-details' : 'database-session-rail' }, container: surface === 'directory' ? 'detailsPane' : 'rightSidebarTab' }, target: { kind: 'session', sessionId: 'paging' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('first_table')).toBeTruthy();
      expect(reads).toEqual([undefined]);
      await fixture.press(await fixture.getByRole('button', { name: 'Next tables' }));
      await settle(20);
      expect(await fixture.getByText('later_table')).toBeTruthy();
      await fixture.press(await fixture.getByRole('button', { name: 'Previous tables' }));
      await settle(20);
      expect(await fixture.getByText('first_table')).toBeTruthy();
      expect(reads).toEqual([undefined, 'second']);
    } finally { await fixture.dispose(); }
  });

  it('opens the Overview directory as the selected page detail', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page-overview', mountNonce: 'page-overview' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation: async ({ subPath }) => subPath },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('~48K rows · 31 MB')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('heads the Overview with where the database is, not the engine the rail already says', async () => {
    const located = { ...descriptor, endpointLabel: 'localhost:5432' };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page-overview-facts', mountNonce: 'page-overview-facts' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: located }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([located]), replacePageLocation: async ({ subPath }) => subPath },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('localhost:5432')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('leads the Overview with the database size and whether statement statistics are on', async () => {
    const basis = { bindingKey: 'binding', databaseIdentity: 'billing_dev', selectionKey: 'overview' };
    const answers = daemonAnswers([descriptor]);
    const executeAction = vi.fn(async (input: PluginUiTestkitExecuteActionInput) => {
      if (input.action !== DATABASE_STATS_READ_ACTION_ID_V1) return answers(input);
      const group = (input.input as { request?: { group?: string } }).request?.group;
      return projectNativeJsonValueForTransport({
        ok: true,
        operation: 'stats.read',
        observation: group === 'size'
          ? { v: 1, observedAtMs: 1, engineId: 'postgresql', scope: { database: 'billing_dev' }, intervalBasis: basis,
              status: 'available', group: 'size', coverage: { status: 'complete' }, completeness: { complete: true },
              data: { bytes: '412000000', measurement: 'database_bytes' } }
          : { v: 1, observedAtMs: 1, engineId: 'postgresql', scope: { database: 'billing_dev' }, intervalBasis: basis,
              status: 'unavailable', group: group ?? 'statements', reason: 'extension_missing' },
      });
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page-overview-tiles', mountNonce: 'page-overview-tiles' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction, replacePageLocation: async ({ subPath }) => subPath },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('412 MB')).toBeTruthy();
      expect(await fixture.getByText('Needs pg_stat_statements')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('keeps reference navigation beside an editable text foreign-key cell', async () => {
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => subPath);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'text-reference', mountNonce: 'text-reference' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ detailsPane: { available: true } }),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor], true), replacePageLocation },
    });
    try {
      await settle(20);
      // A key names its row: its digits stay ungrouped.
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: '48212' })); });
      await settle(20);
      expect(await fixture.getByRole('textbox', { name: 'number' })).toBeTruthy();
      await fixture.press(await fixture.getByRole('button', { name: 'Open in customers' }));
      await settle(20);
      expect(replacePageLocation).toHaveBeenCalledWith(expect.objectContaining({ subPath: 'data/public/customers' }));
    } finally { await fixture.dispose(); }
  });
  it('names the tables that point at an open row and opens their rows filtered to it', async () => {
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => subPath);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'incoming-reference', mountNonce: 'incoming-reference' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ detailsPane: { available: true } }),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation },
    });
    try {
      await settle(20);
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: '48212' })); });
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'Open invoice_lines rows that point here' }));
      await settle(20);
      expect(replacePageLocation).toHaveBeenCalledWith(expect.objectContaining({ subPath: 'data/public/invoice_lines' }));
    } finally { await fixture.dispose(); }
  });
  it('offers one typed field per placeholder in the Console statement, text by default', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'console-slots', mountNonce: 'console-slots' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'console',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation: async ({ subPath }) => subPath,
        deviceState: (request: { operation: string; key?: string }) => ({
          status: 'ready',
          value: request.operation === 'read' && request.key?.includes('database-console')
            ? { sql: 'select number from invoices where customer_id = $1 and status = $2', history: [] }
            : null,
        }),
      },
    });
    try {
      await settle(20);
      expect(await fixture.getByRole('textbox', { name: 'Value of $1' })).toBeTruthy();
      expect(await fixture.getByRole('textbox', { name: 'Value of $2' })).toBeTruthy();
    } finally { await fixture.dispose(); }
  });
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
      // The row leads with its key; on a narrow host the columns that drop still speak in a line under it.
      expect(await fixture.getByText('48212')).toBeTruthy();
      expect(await fixture.getByText('INV-2026-04812 · open')).toBeTruthy();
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
  it('mounts the database\u2019s Automations on the Overview, on the subject its admitted read projected', async () => {
    const automated = { ...descriptor, automationSubject: readAutomationDatabaseSubjectV1(descriptor.placement.serverId, descriptor.target) };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page-automations', mountNonce: 'page-automations' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: automated }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([automated]), replacePageLocation: async ({ subPath }) => subPath },
    });
    try {
      await settle(20);
      // This test host has no core Automations controller, so the public section says so in its place.
      expect(await fixture.getByText('Automations are unavailable on this host.')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('shows the database Overview as its table directory: biggest first, with data, index and total sizes', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'overview', mountNonce: 'overview' }, authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail, launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-session-details' }, container: 'detailsPane' },
        target: { kind: 'session', sessionId: 'session-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction },
    });
    try {
      await settle(20);
      // D27 #1: the producer's byte figures, never a row read; D27 #2: the estimate is marked approximate.
      // The test host lays out narrow, so each table reads as its name over its estimate and total.
      expect(await fixture.getByText('invoices')).toBeTruthy();
      expect(await fixture.getByText('~48K rows · 31 MB')).toBeTruthy();
      expect(await fixture.getByText('~12K rows · 4.2 MB')).toBeTruthy();
      expect(executeAction.mock.calls.some(([call]) => call.action === DATABASE_ROWS_READ_ACTION_ID_V1)).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
  it('opens a table from the Session rail tab as a details tab at that table', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const openSurface = vi.fn(async () => {});
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'rail', mountNonce: 'rail' }, authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail, launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-session-rail' }, container: 'rightSidebarTab' },
        target: { kind: 'session', sessionId: 'session-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction, openSurface },
    });
    try {
      await settle(20);
      // Nothing is open until a press; the list names the tables of the first database.
      // Controls in order: the database picker, Console, the public schema, then its tables (invoices first).
      const controls = await fixture.getAllByRole('button');
      expect(controls).toHaveLength(5);
      await act(async () => { await fixture.press(controls[3]!); });
      expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
        view: expect.objectContaining({ localId: 'database-session-details' }), subPath: 'data/public/invoices',
        input: expect.objectContaining({ descriptor: expect.objectContaining({ label: 'billing_dev' }) }) }));
    } finally { await fixture.dispose(); }
  });

  it('renders the details tab the rail opened, at its table', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'details', mountNonce: 'details' }, authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail, launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-session-details' }, container: 'detailsPane' },
        target: { kind: 'session', sessionId: 'session-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('48212')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });
});
