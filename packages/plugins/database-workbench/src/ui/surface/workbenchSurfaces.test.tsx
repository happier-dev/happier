// @vitest-environment jsdom

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    DATABASE_ACCESS_READ_ACTION_ID_V1,
    DATABASE_ACCESS_SET_ACTION_ID_V1,
    DATABASE_RELATIONS_LIST_ACTION_ID_V1,
    DATABASE_ROWS_READ_ACTION_ID_V1,
    DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
    DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    DATABASE_STATS_READ_ACTION_ID_V1,
    DATABASE_STRUCTURE_READ_ACTION_ID_V1,
    DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
    DATABASE_TARGETS_FORGET_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
    UI_DATABASE_DRAFT_READ_ACTION_ID_V1,
    UI_DATABASE_NAVIGATE_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1, type PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import type { JsonValue, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { computeSha256HexDigest, createCanonicalJsonSigningInput, PluginError } from '@happier-dev/plugin-sdk';
import {
  createPluginUiActionControlTestHost,
  createPluginClientTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkitExecuteActionInput,
  type PluginUiTestkitHostHandlers,
} from '@happier-dev/plugin-sdk/testing';
import { encodeBase64, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { Button } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { HappierPageChromeProvider } from '@happier-dev/plugin-ui/presentation';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { renderSurface as renderPanel } from './DatabasesPanel.js';
import { activate, renderSurface as renderPage } from './WorkbenchPage.js';
import { renderSurface as renderRail } from './DatabaseRailTab.js';
import { WORKBENCH_PAGE_ARTIFACT_ID, WORKBENCH_PAGE_VIEW_ID } from './views.js';
import { encodeWorkbenchRootSubPath } from './subPath.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

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
const savedDatabasePath = `target/${encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(descriptor.target))), 'base64url')}`;

/** The mounted Resource transport supplies the selected connection's admitted snapshot. */
function connectionResourceHandlers(connected = descriptor) {
  const text = JSON.stringify({ descriptor: connected, ownWriteRevision: 0, relationRevisions: [] });
  const digest = `sha256:${computeSha256HexDigest(text)}`;
  return {
    readResource: async () => ({ contentType: 'application/json', digest, bytes: new TextEncoder().encode(text) }),
    watchResource: async () => ({ digest }),
    deviceState: () => ({ status: 'ready' as const, value: null }),
    notify: () => {},
    setUnsavedChanges: async () => {},
  };
}

it('addresses one mounted Workbench and admits draft disclosure at P3 before reading device state', async () => {
  const entries = new Map<string, { value: unknown; refs: number; dispose(): void }>();
  const sharedScope: PluginEphemeralSharedScope = {
    acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
      let entry = entries.get(key);
      if (!entry) { entry = { ...create(), refs: 0 }; entries.set(key, entry); }
      entry.refs++;
      return { value: entry.value as T, release() {
        if (--entry.refs === 0) { entry.dispose(); entries.delete(key); }
      } };
    },
  };
  const registration = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST, activate,
    target: { artifactId: WORKBENCH_PAGE_ARTIFACT_ID, exportName: 'activate', platform: 'web' } });
  const navigate = registration.registration('actions', databaseActionLocalIdV1(UI_DATABASE_NAVIGATE_ACTION_ID_V1));
  const read = registration.registration('actions', databaseActionLocalIdV1(UI_DATABASE_DRAFT_READ_ACTION_ID_V1));
  expect(navigate).toBeTypeOf('function');
  expect(read).toBeTypeOf('function');
  if (!navigate || !read) throw new Error('Mounted Workbench Actions were not registered');
  const replacePageLocation = vi.fn<NonNullable<PluginUiTestkitHostHandlers['replacePageLocation']>>(async ({ subPath }) => subPath);
  const deviceState = vi.fn<NonNullable<PluginUiTestkitHostHandlers['deviceState']>>(() => ({
    status: 'ready', value: { sql: 'select 42', history: [{ sql: 'select 1' }] },
  }));
  const mountId = 'addressed-workbench';
  const daemon = daemonAnswers([descriptor]);
  const requestRead = vi.fn<(request: PluginUiTestkitExecuteActionInput) => Promise<JsonValue>>()
    .mockRejectedValueOnce(new PluginError({ code: 'database_agent_access_none' }))
    .mockResolvedValue({ setBy: 'machine', agentAccess: 'read', access: { canRead: true, canWrite: false } });
  const page = await createPluginUiTestkit({
    identity: { instanceId: mountId, mountNonce: 'addressed-occurrence' },
    authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage, subPath: savedDatabasePath,
    surfaceContext: createSurfaceContextFixture({ mountId, mount: { kind: 'destination', destination: {
      pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: sharedScope }),
    handlers: { ...connectionResourceHandlers(), deviceState, replacePageLocation, executeAction: request =>
      request.action === databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1) ? requestRead(request) : daemon(request) },
  });
  const context: Parameters<PluginClientActionHandler>[1] = {
    plugin: page.context.plugin, contribution: { id: 'fixture', qualifiedId: 'happier.database/fixture' },
    invocationSurface: 'agent', signal: new AbortController().signal, ephemeralSharedScope: sharedScope,
    ui: { ...page.context.hostApi, context: async options => {
      const scope = await page.context.hostApi.context(options);
      return { accountScope: scope.accountScope, targetedContributions: scope.targetedContributions ?? null };
    } },
  };
  try {
    await page.findByRole('button', { name: 'invoices' });
    const address = { mountId };
    await expect(navigate({ address: { mountId: 'different-mount' }, mode: 'insights' }, context)).resolves.toEqual({ status: 'unavailable' });
    expect(replacePageLocation).not.toHaveBeenCalled();
    await expect(read({ address, section: 'draft' }, context)).rejects.toMatchObject({ code: 'database_agent_access_none' });
    expect(deviceState).not.toHaveBeenCalled();
    await expect(read({ address, section: 'draft' }, context)).resolves.toEqual({ status: 'ready', sql: 'select 42' });
    await expect(read({ address, section: 'history' }, context)).resolves.toEqual({ status: 'ready', history: [{ sql: 'select 1' }] });
    expect(requestRead).toHaveBeenLastCalledWith(expect.objectContaining({
      action: databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1), input: { target: descriptor.target },
    }));
    await act(async () => {
      await expect(navigate({ address, mode: 'data', relation: invoices,
        filters: { kind: 'null', column: 'number', isNull: false } }, context))
        .resolves.toEqual({ status: 'accepted', mode: 'data', relation: invoices,
          filters: { kind: 'null', column: 'number', isNull: false } });
    });
    expect(replacePageLocation).toHaveBeenCalledWith(expect.objectContaining({ subPath: expect.stringContaining('data/public/invoices') }));
  } finally {
    await page.dispose();
    await registration.dispose();
  }
  await expect(read({ address: { mountId }, section: 'draft' }, context)).resolves.toEqual({ status: 'unavailable' });
  expect(requestRead).toHaveBeenCalledTimes(3);
});

/** The daemon's Action results for a small Postgres database; the host Action boundary is the only fake. */
function daemonAnswers(targets: readonly DatabaseDescriptorV1[], editableTextReference = false, uniqueNumber = false) {
  return vi.fn(
    async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> =>
      projectNativeJsonValueForTransport(
        (() => {
          switch (action) {
            case databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1):
              return { targets, completeness: { complete: true } };
            case databaseActionLocalIdV1(DATABASE_SCHEMAS_LIST_ACTION_ID_V1):
              return {
                ok: true,
                operation: 'schemas.list',
                schemas: [{ name: 'public' }],
                completeness: { complete: true },
              };
            case databaseActionLocalIdV1(DATABASE_RELATIONS_LIST_ACTION_ID_V1):
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
            case databaseActionLocalIdV1(DATABASE_STRUCTURE_READ_ACTION_ID_V1):
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
                  indexes: uniqueNumber ? [{ name: 'invoices_number_key', unique: true, primary: false, columns: [{ kind: 'column', column: 'number' }] }] : [],
                  capabilities: editableTextReference ? [{ operation: 'edits.apply', available: true }] : [],
                },
              };
            case databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1):
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
      if (request.action !== databaseActionLocalIdV1(DATABASE_RELATIONS_LIST_ACTION_ID_V1)) return base(request);
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

  it('discloses a managed catalogue refusal and retries the selected schema', async () => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      targetLinkId: 'link', database: 'postgres', contribution: { pluginId: 'happier.deploy.supabase', contributionId: 'database' },
      platformProjectId: 'project', branchId: 'branch' } as const;
    const managed = { ...descriptor, target } satisfies DatabaseDescriptorV1;
    const path = encodeWorkbenchRootSubPath(target);
    const code = 'provider_http_429';
    const base = daemonAnswers([managed]);
    let allowRead = false;
    let refused = false;
    const executeAction = async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      if (request.action === databaseActionLocalIdV1(DATABASE_RELATIONS_LIST_ACTION_ID_V1) && !allowRead) {
        expect(request.input).toMatchObject({ target, schema: 'public' });
        refused = true;
        return { ok: false, status: 'failed', code, reason: 'The provider is throttling catalogue reads.' };
      }
      return base(request);
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'catalogue-refusal', mountNonce: 'catalogue-refusal' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage, subPath: path,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(managed), executeAction },
    });
    try {
      await settle(20);
      expect(refused).toBe(true);
      await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
      expect(await fixture.getByText(code)).toBeTruthy();
      expect(await fixture.getByText('The provider is throttling catalogue reads.')).toBeTruthy();
      allowRead = true;
      await fixture.press(await fixture.getByRole('button', { name: 'Try again' }));
      await settle(20);
      expect(await fixture.getByText('invoices')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('selects only Console when the location carries the last table and reuses the opened target', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'console-rail', mountNonce: 'console-rail' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage, subPath: `${savedDatabasePath}/console/public/invoices`,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction },
    });
    try {
      await settle(20);
      // The test host lays out narrow but keeps the desktop rail mounted.
      expect(document.querySelector('[role="button"][aria-label="invoices"]')).toBeTruthy();
      const current = [...document.querySelectorAll('[role="button"][aria-current="page"]')];
      expect(current.map(row => row.getAttribute('aria-label') ?? row.textContent)).toEqual(['Console']);
      expect(executeAction.mock.calls.map(([request]) => request.action))
        .not.toContain(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1));
    } finally { await fixture.dispose(); }
  });

  it('confirms the selected machine policy on Save in the access sheet', async () => {
    const readAccess = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
    const setAccess = databaseActionLocalIdV1(DATABASE_ACCESS_SET_ACTION_ID_V1);
    const daemon = daemonAnswers([descriptor]);
    let agentAccess = 'readWriteAsk';
    let reviewedInput: JsonValue | undefined;
    const write = vi.fn(async (request: Parameters<Parameters<typeof createPluginUiActionControlTestHost>[0]>[0]) => {
      expect(request).toMatchObject({ action: setAccess, input: { target: descriptor.target, agentAccess: 'none' } });
      expect(reviewedInput).toEqual(request.input);
      agentAccess = 'none';
      return { ok: true as const, result: { ok: true, agentAccess } };
    });
    const control = createPluginUiActionControlTestHost(write);
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => {
      if (request.action !== readAccess) return daemon(request);
      return projectNativeJsonValueForTransport({
        setBy: 'machine', agentAccess, access: descriptor.access,
      });
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'read-access', mountNonce: 'read-access' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => (
        <PluginUiHostPresentationScope
          environment={projectHappierUiEnvironment(context.surface)}
          presentationHost={{
            renderCodeBlock: () => null,
            renderIcon: () => null,
            renderMarkdown: () => null,
            renderActionControl: ({ control: bound, presentation, reviewedInput: input }) =>
              <Button title={presentation.title} disabled={!bound || presentation.disabled} onPress={() => {
                reviewedInput = input;
                return control.press(presentation.title);
              }} />,
            renderPopover: input => input.content({
              presentation: 'sheet', maxHeight: 240, requestClose: input.onRequestClose,
            }),
          }}
        >
          {renderPage(context)}
        </PluginUiHostPresentationScope>
      ),
      subPath: savedDatabasePath,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction, actionControl: control.handler },
    });
    const reads = () => executeAction.mock.calls.map(([call]) => call).filter(call => call.action === readAccess);
    try {
      await settle(20);
      expect(reads()).toHaveLength(0);
      await act(async () => fixture.press(await fixture.getByRole('button', { name: 'Read only' })));
      await settle(20);
      expect(reads()).toMatchObject([{ input: { target: descriptor.target } }]);
      expect(await fixture.getByText('Agents can read and ask before writing.')).toBeTruthy();
      await act(async () => fixture.press(await fixture.getByRole('button', { name: 'None' })));
      expect(write).not.toHaveBeenCalled();
      await act(async () => fixture.press(await fixture.getByRole('button', { name: 'Save' })));
      expect(await fixture.getByText('Agents can’t use this database.')).toBeTruthy();
      expect(write).toHaveBeenCalledTimes(1);
      expect(reads()).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('refreshes the open Environment access word on publication without polling', async () => {
    const target = { kind: 'deployment_service', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'billing_dev' } as const;
    const connected = { ...descriptor, target, access: { canRead: true, canWrite: true } };
    const digest = `sha256:${computeSha256HexDigest(JSON.stringify({ descriptor: connected, ownWriteRevision: 0, relationRevisions: [] }))}`;
    const readAccess = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
    const daemon = daemonAnswers([connected]);
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => {
      if (request.action !== readAccess) return daemon(request);
      expect(request.input).toEqual({ target });
      return { setBy: 'environment', serverId: 'home', environmentId: 'template', expectedRevision: 2,
        access: { canRead: true, canWrite: false, reason: 'database_not_an_editor' } };
    });
    let publish: (() => void) | undefined;
    const databaseWorkbench = {
      activityResource: () => { throw new Error('Unexpected Activity demand'); },
      lastLook: () => { throw new Error('Unexpected Last Look demand'); },
      renderEnvironmentAccessObserver: ({ onChanged }: { onChanged: () => void }) => {
        publish = onChanged;
        return null;
      },
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'environment-access', mountNonce: 'environment-access' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)} presentationHost={{
          renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, databaseWorkbench,
          renderPopover: input => input.content({ presentation: 'sheet', maxHeight: 240, requestClose: input.onRequestClose }),
        }}>{renderPage(context)}</PluginUiHostPresentationScope>,
      subPath: encodeWorkbenchRootSubPath(target),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction,
        async watchResource() { return { digest }; },
        async readResource() {
          const body = { descriptor: connected, ownWriteRevision: 0, relationRevisions: [] };
          return { contentType: 'application/json', digest, bytes: new TextEncoder().encode(JSON.stringify(body)) };
        },
      },
    });
    try {
      expect(await fixture.getByRole('button', { name: 'Can edit' })).toBeTruthy();
      const reads = () => executeAction.mock.calls.filter(([request]) => request.action === readAccess);
      expect(reads()).toHaveLength(0);
      expect(publish).toBeTypeOf('function');
      await act(async () => { publish?.(); });
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'Read only' }));
      expect(await fixture.getByText('You aren’t in this Environment’s database editors.')).toBeTruthy();
      expect(reads()).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('reopens a saved database when the person retries its failed connection read', async () => {
    const connection = connectionResourceHandlers();
    const watchResource = vi.fn(connection.watchResource)
      .mockRejectedValueOnce(new Error('Connection unavailable'));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'linked-retry', mountNonce: 'linked-retry' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage, subPath: `${savedDatabasePath}/data/public/invoices`,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connection, watchResource, executeAction: daemonAnswers([descriptor]) },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('Databases could not be read')).toBeTruthy();
      expect(document.body.textContent).not.toContain('Create read-only login');
      expect(watchResource).toHaveBeenCalledTimes(1);
      await fixture.press(await fixture.getByRole('button', { name: 'Try again' }));
      await settle(20);
      expect(await fixture.getByRole('button', { name: '48212' })).toBeTruthy();
      expect(watchResource).toHaveBeenCalledTimes(2);
    } finally { await fixture.dispose(); }
  });

  it('reviews the signed Railway preview and applies its exact SQL before opening the database', async () => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
        targetLinkId: 'link', contribution: { pluginId: 'happier.deploy.railway-data', contributionId: 'postgresql' },
        platformProjectId: 'project', branchId: 'branch', database: 'billing_dev' } as const;
    const connected = { ...descriptor, target };
    const content = JSON.stringify({ descriptor: connected, ownWriteRevision: 0, relationRevisions: [] });
    const digest = `sha256:${computeSha256HexDigest(content)}`;
    const statements = ['CREATE ROLE happier_read LOGIN', 'GRANT CONNECT ON DATABASE billing_dev TO happier_read'];
    const create = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);
    let configured = false;
    const daemon = daemonAnswers([connected]);
    const execute = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async ({ input }) => {
      if (input && typeof input === 'object' && 'mode' in input && input.mode === 'preview') {
        return { ok: true, result: { ok: true, status: 'review', role: 'happier_read', statements,
          endpointTrust: 'encrypted_unverified' } };
      }
      expect(input).toEqual({ target, mode: 'apply', role: 'happier_read', statements });
      configured = true;
      return { ok: true, result: { ok: true, status: 'configured' } };
    });
    const control = createPluginUiActionControlTestHost(execute);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'managed-read-setup', mountNonce: 'managed-read-setup' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{
          renderCodeBlock: ({ code }) => <span>{code}</span>,
          renderIcon: () => null,
          renderMarkdown: () => null,
          renderPopover: () => null,
          renderActionControl: ({ control: bound, presentation }) =>
            <Button title={presentation.title} disabled={!bound || presentation.disabled}
              onPress={() => control.press(presentation.title)} />,
        }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      subPath: encodeWorkbenchRootSubPath(target),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(),
        async watchResource() {
          if (!configured) throw new PluginError({ code: 'read_role_setup_required' });
          return { digest };
        },
        async readResource() { return { contentType: 'application/json', digest, bytes: new TextEncoder().encode(content) }; },
        executeAction: daemon,
        actionControl: control.handler,
      },
    });
    try {
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'Use existing read-only login' }));
      expect(await fixture.getByText('Saved secrets are unavailable on this host.')).toBeTruthy();
      await fixture.press(await fixture.getByRole('button', { name: 'Back to setup options' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Create read-only login' }));
      await settle(20);
      expect(execute.mock.calls.map(([{ action, input }]) => ({ action, input })))
        .toEqual([{ action: create, input: { target, mode: 'preview' } }]);
      expect(daemon.mock.calls.map(([request]) => request.action)).not.toContain(create);
      for (const sql of statements) expect(document.body.textContent).toContain(sql);
      expect(await fixture.getByText('The connection is encrypted, but the provider can’t prove this is your database server.')).toBeTruthy();
      expect(configured).toBe(false);
      await fixture.press(await fixture.getByRole('button', { name: 'Create read-only login' }));
      await settle(20);
      expect(configured).toBe(true);
      expect(await fixture.findByRole('button', { name: 'invoices' })).toBeTruthy();
      expect(daemon.mock.calls.map(([request]) => request.action))
        .not.toContain(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1));
    } finally { await fixture.dispose(); }
  });

  it.each(['refused', 'unexpected'] as const)('shows the %s signed Preview result without applying read access', async (outcome) => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
        targetLinkId: 'link', contribution: { pluginId: 'happier.deploy.railway-data', contributionId: 'postgresql' },
        platformProjectId: 'project', branchId: 'branch', database: 'billing_dev' } as const;
    const create = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);
    const daemon = daemonAnswers([{ ...descriptor, target }]);
    const code = 'database_editing_off';
    const reason = 'Database editing is off for this Environment.';
    const nextStep = 'Ask an Environment manager to turn it on.';
    const presentActionFailure = vi.fn<NonNullable<PluginUiTestkitHostHandlers['presentActionFailure']>>(async ({ failure }) => {
      expect(failure.errorCode).toBe(code);
      return { reason, nextStep, technicalDetails: [{ key: 'code', label: 'Code', value: code }] };
    });
    const execute = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () =>
      outcome === 'refused' ? { ok: false, errorCode: code, error: code } : { ok: true, result: null });
    const control = createPluginUiActionControlTestHost(execute);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'managed-read-unverified', mountNonce: 'managed-read-unverified' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{
          renderCodeBlock: () => null,
          renderIcon: () => null,
          renderMarkdown: () => null,
          renderPopover: () => null,
          renderActionControl: ({ control: bound, presentation }) =>
            <Button title={presentation.title} disabled={!bound || presentation.disabled}
              onPress={() => control.press(presentation.title)} />,
        }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      subPath: encodeWorkbenchRootSubPath(target),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(),
        async watchResource() { throw new PluginError({ code: 'read_role_setup_required' }); },
        executeAction: daemon,
        actionControl: control.handler,
        presentActionFailure,
      },
    });
    try {
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'Create read-only login' }));
      await settle(20);
      expect(execute.mock.calls.map(([{ action, input }]) => ({ action, input })))
        .toEqual([{ action: create, input: { target, mode: 'preview' } }]);
      if (outcome === 'refused') {
        expect(document.body.textContent).toContain(reason);
        expect(await fixture.getByText(nextStep)).toBeTruthy();
        await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
        expect(await fixture.getByText(code)).toBeTruthy();
        expect(document.body.textContent).not.toContain('Something went wrong');
      } else {
        expect(await fixture.getByText('Could not verify the setup result.')).toBeTruthy();
        expect(presentActionFailure).not.toHaveBeenCalled();
      }
      expect(document.body.textContent).not.toContain('Review the read-only login');
      expect(await fixture.getByRole('button', { name: 'Use existing read-only login' })).toBeTruthy();
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
      if (input.action !== databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1)) return answers(input);
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
      expect(await fixture.getByRole('group', { name: 'Size: 412 MB' })).toBeTruthy();
      expect(await fixture.getByRole('group', { name: 'Statement statistics: Off, Needs pg_stat_statements' })).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('restores the saved database and relation on a cold page and keeps the database in the URL', async () => {
    const executeAction = daemonAnswers([descriptor], true);
    const watchResource = vi.fn(connectionResourceHandlers().watchResource);
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => subPath);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'cold-database', mountNonce: 'cold-database' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      subPath: `${savedDatabasePath}/data/public/invoices`,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ detailsPane: { available: true } }),
      handlers: { ...connectionResourceHandlers(), executeAction, watchResource, replacePageLocation },
    });
    try {
      await settle(20);
      expect(await fixture.queryByText('Open a database from Dev servers')).toBeFalsy();
      const row = await fixture.findByRole('button', { name: '48212' });
      expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
        action: databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1),
        input: expect.objectContaining({ target: descriptor.target, relation: invoices }),
      }));
      await act(async () => { await fixture.press(row); });
      await fixture.press(await fixture.findByRole('button', { name: 'Open in customers' }));
      // On a phone the rail is the root (lab tablesp): the host's Back returns to it from any place it opens.
      expect(replacePageLocation).toHaveBeenCalledWith(expect.objectContaining({
        subPath: `${savedDatabasePath}/data/public/customers`, backLocation: savedDatabasePath,
      }));
      expect(watchResource).toHaveBeenCalledTimes(1);
    } finally { await fixture.dispose(); }
  });

  it('writes nothing when the page it opens already has a way back (a place the host pushed)', async () => {
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => subPath);
    // The host's push mounts the place on a screen whose navigation already goes back (phone Back, lab tablesp).
    const pushedChrome = { showsTitle: true, renderBack: () => null };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'pushed-place', mountNonce: 'pushed-place' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <HappierPageChromeProvider chrome={pushedChrome}>{renderPage(context)}</HappierPageChromeProvider>,
      subPath: `${savedDatabasePath}/data/public/invoices`,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation },
    });
    try {
      await settle(20);
      expect(replacePageLocation).not.toHaveBeenCalled();
      expect(await fixture.findByRole('button', { name: '48212' })).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('opens a table picked at the root, and writes nothing but that place', async () => {
    const written: string[] = [];
    let deliver: (subPath: string) => Promise<void> = async () => undefined;
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => {
      written.push(subPath);
      // The host settles the location and delivers it back to the page, as the real page route does.
      queueMicrotask(() => { void deliver(subPath); });
      return subPath;
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'root-pick', mountNonce: 'root-pick' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      subPath: savedDatabasePath,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation },
    });
    deliver = (subPath) => fixture.updatePageLocation(subPath);
    try {
      await settle(20);
      expect(written).toEqual([]);
      await fixture.press(await fixture.findByRole('button', { name: 'invoices' }));
      await settle(30);
      expect(written).toEqual([`${savedDatabasePath}/data/public/invoices`]);
      expect(await fixture.findByRole('button', { name: '48212' })).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('opens a cold place from the root it has reached, then follows the host back to it', async () => {
    let deliver: (subPath: string) => Promise<void> = async () => undefined;
    let delivering = false;
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => {
      if (delivering) queueMicrotask(() => { void deliver(subPath); });
      return subPath;
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'cold-back', mountNonce: 'cold-back' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      subPath: `${savedDatabasePath}/data/public/invoices`,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation },
    });
    deliver = (subPath) => fixture.updatePageLocation(subPath);
    const writes = () => replacePageLocation.mock.calls.map(([request]) => request);
    try {
      await settle(20);
      // A link straight to a place first goes to the database's root; until the page is there, nothing else is written.
      expect(writes()).toEqual([expect.objectContaining({ subPath: savedDatabasePath })]);
      // Once the host delivers the root, the place opens from it as the rail would (lab tablesp), so Back has a step.
      delivering = true;
      await fixture.updatePageLocation(savedDatabasePath);
      await settle(30);
      expect(writes()).toEqual([
        expect.objectContaining({ subPath: savedDatabasePath }),
        expect.objectContaining({ subPath: `${savedDatabasePath}/data/public/invoices`, backLocation: savedDatabasePath }),
      ]);
      expect(await fixture.findByRole('button', { name: '48212' })).toBeTruthy();
      // The host's Back delivers the root; the page follows it rather than keeping the table, and writes nothing.
      delivering = false;
      await fixture.updatePageLocation(savedDatabasePath);
      await settle(20);
      expect(await fixture.queryByRole('button', { name: '48212' })).toBeUndefined();
      expect(writes()).toHaveLength(2);
      await settle(20);
      // The Overview's table directory, which the root shows beside the rail.
      expect(document.body.textContent).toContain('Biggest first.');
    } finally { await fixture.dispose(); }
  });

  it('starts the replacement workbench at the location delivered with its host binding', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page-location', mountNonce: 'page-location' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => renderPage({ ...context, hostApi: { ...context.hostApi } }),
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]) },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('invoices')).toBeTruthy();
      await fixture.updatePageLocation('data/public/invoices');
      await settle(20);
      expect(await fixture.getByText('48212')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it.each([
    { provider: 'Railway', trust: { endpointTrust: 'encrypted_unverified' as const }, showsNotice: true },
    { provider: 'Neon', trust: {}, showsNotice: false },
  ])('reviews staged changes for $provider without executing a database write', async ({ provider, trust, showsNotice }) => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      targetLinkId: 'link', database: 'billing_dev', contribution: { pluginId: `fixture.${provider.toLowerCase()}`, contributionId: 'postgres' },
      platformProjectId: 'project', branchId: 'branch' } as const;
    const connected = { ...descriptor, target, origin: { label: provider }, ...trust };
    const executeAction = daemonAnswers([connected], true);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'insert-row', mountNonce: 'insert-row' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: connected }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { ...connectionResourceHandlers(connected), executeAction },
    });
    try {
      await settle(20);
      executeAction.mockClear();
      await fixture.press(await fixture.getByRole('button', { name: 'New row' }));
      expect(await fixture.getByRole('textbox', { name: 'id' })).toBeTruthy();
      await fixture.press(await fixture.getByRole('button', { name: 'Stage row' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review' }));
      expect(await fixture.getByText('New row')).toBeTruthy();
      expect(await fixture.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy();
      const notice = 'The connection is encrypted, but the provider can’t prove this is your database server.';
      if (showsNotice) expect(await fixture.getByText(notice)).toBeTruthy();
      else expect(await fixture.queryByText(notice)).toBeUndefined();
      expect(executeAction).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  it.each(['deployment_service', 'managed_deployment'] as const)('keeps the reviewed production draft when %s write setup is required', async kind => {
    const environment = { serverId: 'home', environmentId: 'env', projectSourceId: 'source' } as const;
    const link = { environment, targetLinkId: 'link', database: 'billing_dev' };
    const target = kind === 'deployment_service'
      ? { ...link, kind, deploymentId: 'deployment', serviceId: 'postgres' }
      : { ...link, kind, contribution: { pluginId: 'fixture.database', contributionId: 'postgres' }, platformProjectId: 'project', branchId: 'branch' };
    const connected = { ...descriptor, target, origin: { label: 'Customer production', environment: 'production' as const },
      access: { canRead: true, canWrite: true } };
    const body = JSON.stringify({ descriptor: connected, ownWriteRevision: 0, relationRevisions: [] });
    const digest = `sha256:${computeSha256HexDigest(body)}`;
    const code = kind === 'deployment_service' ? 'write_role_setup_required' : 'write_connection_setup_required';
    let configured = false;
    const write = vi.fn(async (_request: Parameters<Parameters<typeof createPluginUiActionControlTestHost>[0]>[0]) => configured
      ? { ok: true as const, result: { ok: true, operation: 'edits.apply', status: 'committed', inserted: '1', updated: '0', deleted: '0' } }
      : { ok: false as const, errorCode: code, error: code });
    const control = createPluginUiActionControlTestHost(write);
    const databaseWorkbench = {
      activityResource: () => { throw new Error('Unexpected Activity demand'); },
      lastLook: () => { throw new Error('Unexpected Last Look demand'); },
      renderProductionBackup: () => <Button title="Back up now" onPress={() => {}} />,
      renderWriteSetup: (input: unknown) => {
        expect(input).toEqual({ target, code });
        return <Button title="Set up database writes" onPress={() => { configured = true; }} />;
      },
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: kind, mountNonce: kind },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{
          renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, databaseWorkbench,
          renderPopover: input => input.open ? input.content({
            presentation: 'sheet', maxHeight: 10_000, requestClose: input.onRequestClose,
          }) : null,
        }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: connected }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([connected], true), actionControl: control.handler,
        async watchResource() { return { digest }; },
        async readResource() { return { contentType: 'application/json', digest, bytes: new TextEncoder().encode(body) }; },
      },
    });
    try {
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'New row' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Stage row' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review' }));
      await act(async () => control.press('Apply to Production'));
      const setup = await fixture.getByRole('button', { name: 'Set up database writes' });
      expect(await fixture.getByRole('button', { name: 'Back up now' })).toBeTruthy();
      expect(await fixture.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy();
      expect(write).toHaveBeenCalledTimes(1);
      await fixture.press(setup);
      expect(write).toHaveBeenCalledTimes(1);
      await act(async () => control.press('Apply to Production'));
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1]?.[0].input).toEqual(write.mock.calls[0]?.[0].input);
    } finally { await fixture.dispose(); }
  });

  it.each([
    { unique: true, title: 'INV-2026-04812', subtitle: 'invoices · id 48212' },
    { unique: false, title: 'id 48212', subtitle: null },
  ])('titles an open row by its unique worded value, else by its key (unique number: $unique)', async ({ unique, title, subtitle }) => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `row-title-${unique}`, mountNonce: `row-title-${unique}` },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ detailsPane: { available: true } }),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor], true, unique) },
    });
    try {
      await settle(20);
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: '48212' })); });
      await settle(20);
      // A status tells no row apart; only a unique worded value or the key names one.
      expect(await fixture.getByRole('heading', { name: title })).toBeTruthy();
      expect((await fixture.getAllByRole('group', { name: 'Details pane' })).length).toBe(1);
      if (subtitle) expect(await fixture.getByText(subtitle)).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it('names a staged row by its key in review, digits ungrouped as the table shows them', async () => {
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'review-key', mountNonce: 'review-key' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ detailsPane: { available: true }, overlays: true }),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor], true) },
    });
    try {
      await settle(20);
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: '48212' })); });
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'Delete row' }));
      await settle(10);
      await fixture.press(await fixture.getByRole('button', { name: 'Review' }));
      await settle(10);
      // The review counts what it applies and names each row by its key (lab dbEdit-review).
      expect(await fixture.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy();
      expect(await fixture.queryByText('id 48,212')).toBeUndefined();
      expect(await fixture.getByText('id 48212')).toBeTruthy();
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
  it('offers one Referenced by at the footer when one row is on screen', async () => {
    const replacePageLocation = vi.fn(async ({ subPath }: { subPath: string }) => subPath);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'incoming-footer', mountNonce: 'incoming-footer' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation },
    });
    try {
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'Open invoice_lines rows that point at this row' }));
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
      // The type is a quiet word qualifying the value, text until the person picks another.
      expect(await fixture.getByRole('button', { name: 'Type of $1: text' })).toBeTruthy();
    } finally { await fixture.dispose(); }
  });
  it('settles a mounted Console Run and saves it to History', async () => {
    type Control = Parameters<NonNullable<PluginUiTestkitHostHandlers['actionControl']>>[0];
    let run: Control | undefined;
    let explain: Control | undefined;
    const sql = 'SELECT id, customer_id, invoice_key, total FROM invoices';
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const deviceState = vi.fn<NonNullable<PluginUiTestkitHostHandlers['deviceState']>>(request => ({
      status: 'ready', value: request.operation === 'read' && request.key?.includes('database-console') ? { sql, history: [] } : null,
    }));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'console-run', mountNonce: 'console-run' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'console',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: {
        ...connectionResourceHandlers(), executeAction: daemonAnswers([descriptor]), replacePageLocation: async ({ subPath }) => subPath,
        deviceState,
        confirm,
        actionControl(control) {
          const { request } = control;
          if (request.kind === 'bind' && request.presentation.title === 'Run') run = control;
          if (request.kind === 'bind' && request.presentation.title === 'Explain') explain = control;
          if (request.kind !== 'prepared') return;
          if (request.requestId === 'run-invalid-console') {
            expect(request.preparation?.input).toMatchObject({ statement: { sql } });
            return { ok: true, result: { ok: false, status: 'failed', code: 'database_engine_error', cause: {
              source: 'engine', code: '42601', message: 'syntax error at or near "WHERE"', position: 13, statementIndex: 0,
            } } };
          }
          if (request.requestId !== 'run-console') return;
          expect(request.preparation?.input).toMatchObject({ statement: { sql } });
          return { ok: true, result: { ok: true, operation: 'statement.run', results: [{
            columns: ['id', 'customer_id', 'invoice_key', 'total'].map(name => ({ name, nativeType: 'int8', semanticType: 'integer' })),
            rows: [{ cells: ['1001', '2002', '3003', '4004'].map(value => ({ type: 'integer', value })) }],
            command: 'SELECT',
            completeness: { complete: true },
          }] } };
        },
      },
    });
    try {
      await settle(20);
      if (!run) throw new Error('Console did not offer Run');
      expect(run.request).toMatchObject({ action: databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1) });
      expect(explain?.request).toMatchObject({ action: databaseActionLocalIdV1(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1) });
      await act(async () => { run?.publish({ kind: 'prepare', requestId: 'run-console' }); });
      await settle(20);
      expect(await fixture.getByText('1001')).toBeTruthy();
      expect(await fixture.getByText('2002 · 3003 · 4,004')).toBeTruthy();
      await fixture.press(await fixture.getByRole('button', { name: 'History' }));
      deviceState.mockClear();
      await fixture.press(await fixture.getByRole('button', { name: 'Clear history' }));
      await settle();
      expect(deviceState.mock.calls.map(([request]) => request.operation)).not.toContain('write');
      expect(await fixture.queryByRole('button', { name: 'History' })).toBeTruthy();

      await fixture.press(await fixture.getByRole('button', { name: 'Clear history' }));
      await settle();
      expect(await fixture.queryByRole('button', { name: 'History' })).toBeFalsy();
      expect(deviceState.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
        operation: 'write', value: { sql, history: [] },
      }));

      await act(async () => { run?.publish({ kind: 'prepare', requestId: 'run-invalid-console' }); });
      await settle();
      expect(await fixture.queryByText('syntax error at or near "WHERE"')).toBeTruthy();
      await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
      expect(await fixture.queryByText('42601')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });
  it('lists the checkout’s databases on Dev servers and opens the chosen one in the workbench', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const openSurface = vi.fn<NonNullable<PluginUiTestkitHostHandlers['openSurface']>>(async () => {});
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
      // Capture has one control owner, the Dev servers capture view: the panel draws no second control set.
      await expect(fixture.queryByText('Local capture')).resolves.toBeUndefined();
      await act(async () => {
        const row = (await fixture.getAllByRole('button')).find(button => button.name?.includes('billing_dev'));
        expect(row).toBeDefined();
        await fixture.press(row!);
      });
      expect(openSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({ localId: WORKBENCH_PAGE_VIEW_ID }),
          // The database's root: the Overview beside the rail, and on a phone the rail itself (lab tablesp).
          subPath: `~run-on/home/machine/installation/${savedDatabasePath}`,
        }),
      );
      expect(openSurface.mock.lastCall?.[0]).not.toHaveProperty('input');
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

  it.each(['servicesPanel', 'rightSidebarTab'] as const)('connects a Saved Secret to the selected checkout from an empty %s', async (container) => {
    const connect = databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1);
    const forget = databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1);
    const { kind: _kind, ...placement } = scope;
    const installed = { ...descriptor, target: { ...placement, kind: 'manual' as const, savedSecretId: 'saved-url' } };
    let targets: DatabaseDescriptorV1[] = [];
    let ready = false;
    const operate = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => {
      const { action, input } = request;
      if (action === connect) {
        expect(input).toMatchObject({ scope, savedSecretRef: 'saved-url' });
        targets = [installed];
        if (!ready) throw new PluginError({ code: 'database_target_unavailable', message: 'Database is offline.' });
        return projectNativeJsonValueForTransport(installed);
      }
      return daemonAnswers(targets)(request);
    });
    const unlink = vi.fn(async (request: Parameters<Parameters<typeof createPluginUiActionControlTestHost>[0]>[0]) => {
      expect(request).toMatchObject({ action: forget, input: { target: installed.target } });
      expect(request.input).toEqual({ target: installed.target });
      targets = [];
      return { ok: true as const, result: { ok: true } };
    });
    const control = createPluginUiActionControlTestHost(unlink);
    const render = container === 'servicesPanel' ? renderPanel : renderRail;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: container, mountNonce: 'connect-empty' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)} presentationHost={{
        renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
        renderSavedSecretChoiceList: input => <Button title="Saved database URL" onPress={() => input.onConnect?.('saved-url')} />,
      }}>{render(context)}</PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: container === 'servicesPanel' ? 'databases-panel' : 'database-session-rail',
      }, container },
      target: container === 'servicesPanel' ? { kind: 'services' } : { kind: 'session', sessionId: 'session' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(), executeAction: operate, actionControl: control.handler },
    });
    try {
      const start = await fixture.findByRole('button', { name: 'Connect a database' });
      if (container === 'servicesPanel') {
        // DBW review R4 #9: adding is the section's own action beside its title, never a button inside the empty sheet.
        let node: Element | null = document.querySelector('[data-testid="database.panel.connect"]');
        expect(node).not.toBeNull();
        while (node && !node.textContent?.includes('Databases this checkout')) node = node.parentElement;
        expect(node?.textContent).not.toContain('No databases found');
      }
      await act(async () => { await fixture.press(start); });
      const secret = await fixture.findByRole('button', { name: 'Saved database URL' });
      await act(async () => { await fixture.press(secret); });
      const connectButton = await fixture.findByRole('button', { name: 'Test and connect' });
      await act(async () => { await fixture.press(connectButton); });
      const retry = await fixture.findByRole('button', { name: 'Try again' });
      expect(control.presentation('Forget database')).toBeDefined();
      ready = true;
      await act(async () => { await fixture.press(retry); });
      await act(async () => { await Promise.resolve(); });
      expect(control.presentation('Forget database')).toBeDefined();
      expect(unlink).not.toHaveBeenCalled();
      await act(async () => control.press('Forget database'));
      await fixture.findByRole('button', { name: 'Connect a database' });
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(operate.mock.calls.filter(([request]) => request.action === connect)).toHaveLength(2);
    } finally { await fixture.dispose(); }
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
      expect(executeAction.mock.calls.some(([call]) => call.action === databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1))).toBe(true);
      // The row leads with its key; on a narrow host the columns that drop still speak in a line under it.
      expect(await fixture.getByText('48212')).toBeTruthy();
      expect(await fixture.getByText('INV-2026-04812 · open')).toBeTruthy();
      // One structure read serves the page; nothing re-reads it per row or per cell.
      expect(
        executeAction.mock.calls.filter(
          ([call]) => call.action === databaseActionLocalIdV1(DATABASE_STRUCTURE_READ_ACTION_ID_V1),
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
  it('prepares a scoped migration draft from the mounted view definition', async () => {
    const handoff = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => ({ ok: true, result: { kind: 'cancelled' } }));
    const execute = createPluginUiActionControlTestHost(handoff);
    const response = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'view', mountNonce: 'migration' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'structure/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(),
        replacePageLocation: async ({ subPath }) => subPath,
        async executeAction(request) {
          const result = await response(request);
          if (request.action !== databaseActionLocalIdV1(DATABASE_STRUCTURE_READ_ACTION_ID_V1)) return result;
          if (!result || typeof result !== 'object' || !('structure' in result)) throw new Error('Missing test structure');
          return { ...result, structure: { ...(result.structure as Record<string, JsonValue>), kind: 'view', viewDefinition: 'SELECT total FROM ledger' } };
        },
        actionControl: execute.handler,
      },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('Rows come from this query. To change what it shows, change the view in a migration.')).toBeTruthy();
      await act(async () => execute.press('Ask an agent to add a migration'));
      const request = handoff.mock.lastCall?.[0];
      expect(request).toMatchObject({ action: 'session.input.handoff', input: {
        delivery: 'compose', sessionChoice: { kind: 'new' },
        newSession: { kind: 'new', seed: { placement: { kind: 'exactTarget', serverId: scope.workspace.serverId,
          machineId: scope.workspace.machineId, directory: scope.workspace.rootPath } } },
        input: { text: expect.stringContaining('["public","invoices"]'), forgeEvidence: { items: [expect.objectContaining({
          text: expect.stringContaining('"kind":"migration"'),
        })] } },
      } });
    } finally { await fixture.dispose(); }
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
      expect(executeAction.mock.calls.some(([call]) => call.action === databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1))).toBe(false);
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
