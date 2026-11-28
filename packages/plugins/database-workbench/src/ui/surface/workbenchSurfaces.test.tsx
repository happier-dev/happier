// @vitest-environment jsdom

import { act, Profiler, useEffect, useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    DATABASE_ACCESS_READ_ACTION_ID_V1,
    DATABASE_ACCESS_SET_ACTION_ID_V1,
    DATABASE_DESCRIBE_ACTION_ID_V1,
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
    UI_DATABASE_HISTORY_CLEAR_ACTION_ID_V1,
    UI_DATABASE_NAVIGATE_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1, type PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1, DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { buildActionExecuteResultFromRecordedApprovalExecution } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { PluginUiActionControlExecutionV1Schema } from '@happier-dev/protocol/plugins/ui/actionControl';
import { decryptWithDataKeyResult, encryptWithDataKey } from '../../../../../../apps/cli/src/api/encryption';
import { projectContributedActionFailure } from '../../../../../../apps/cli/src/plugins/runtime/invocation/actions/contributedActionFailure';
import { settleTargetActionExecution } from '../../../../../../apps/cli/src/session/actions/approvals/targetActionSettlement';
import type { JsonValue, PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { computeSha256HexDigest, createCanonicalJsonSigningInput, PluginError } from '@happier-dev/plugin-sdk';
import {
  createPluginUiActionControlTestHost,
  createPluginClientTestkit,
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkitExecuteActionInput,
  type PluginUiTestkitHostHandlers,
} from '@happier-dev/plugin-sdk/testing';
import { encodeBase64, formatSharedSavedSecretRefV1, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { HappierPageChromeProvider } from '@happier-dev/plugin-ui/presentation';
import { Button, SelectionTiles } from '@happier-dev/plugin-ui';
import type { SavedSecretChoiceListProps } from '@happier-dev/plugin-ui/components';
import { PluginUiHostPresentationScope, type PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { renderSurface as renderPanel } from './DatabasesPanel.js';
import { activate, openWorkbenchPage, renderSurface as renderPage } from './WorkbenchPage.js';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { renderSurface as renderRail } from './DatabaseRailTab.js';
import { WORKBENCH_PAGE_ARTIFACT_ID, WORKBENCH_PAGE_VIEW_ID } from './views.js';
import { encodeWorkbenchRootSubPath } from './subPath.js';
import { PLUGIN_MANIFEST, plugin } from '../../manifest.js';

/**
 * The app's phone sheet at the host boundary: the host draws the content as its bottom sheet and pins the footer the
 * Popover requested under it, as the app's floating sheet does.
 */
function phoneSheet(input: Parameters<PluginUiPresentationHost['renderPopover']>[0], maxHeight: number) {
  return <>
    {input.content({ presentation: 'sheet', maxHeight, requestClose: input.onRequestClose })}
    {input.sheet?.footer ?? null}
  </>;
}

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

it('addresses one mounted Workbench and scopes device history clearing without changing the SQL draft', async () => {
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
  const clearHistory = registration.registration('actions', databaseActionLocalIdV1(UI_DATABASE_HISTORY_CLEAR_ACTION_ID_V1));
  expect(navigate).toBeTypeOf('function');
  expect(read).toBeTypeOf('function');
  if (!navigate || !read) throw new Error('Mounted Workbench Actions were not registered');
  const replacePageLocation = vi.fn<NonNullable<PluginUiTestkitHostHandlers['replacePageLocation']>>(async ({ subPath }) => subPath);
  const saved = new Map<string, JsonValue>();
  const initialConsole = { sql: 'select 42', history: [{ sql: 'select 1' }] };
  const deviceState = vi.fn<NonNullable<PluginUiTestkitHostHandlers['deviceState']>>(request => {
    if (request.operation === 'write') {
      saved.set(request.key, request.value);
      return { status: 'ready', value: request.value };
    }
    return { status: 'ready', value: saved.get(request.key) ?? initialConsole };
  });
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
    expect(clearHistory).toBeTypeOf('function');
    if (!clearHistory) throw new Error('Mounted Workbench history Action was not registered');
    await expect(clearHistory({ address: { mountId: 'different-mount' } }, context))
      .resolves.toEqual({ status: 'unavailable' });
    requestRead.mockRejectedValueOnce(new PluginError({ code: 'database_agent_access_none' }));
    await expect(clearHistory({ address }, context)).rejects.toMatchObject({ code: 'database_agent_access_none' });
    expect(saved.size).toBe(0);
    await act(async () => {
      await expect(clearHistory({ address }, context)).resolves.toEqual({ status: 'cleared' });
    });
    expect([...saved.values()]).toEqual([{ sql: 'select 42', history: [] }]);
    await expect(read({ address, section: 'history' }, context)).resolves.toEqual({ status: 'ready', history: [] });
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
  await expect(clearHistory?.({ address: { mountId } }, context)).resolves.toEqual({ status: 'unavailable' });
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
  it('retries a refused own-server read after the host finishes setting up the read login', async () => {
    const target = { kind: 'deployment_service', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'billing_dev' } as const;
    const connected = { ...descriptor, target };
    const resources = connectionResourceHandlers(connected);
    let configured = false;
    let finishSetup: (() => void) | undefined;
    const watchResource = vi.fn(async () => {
      if (!configured) throw new PluginError({ code: 'read_role_setup_required' });
      return await resources.watchResource();
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'own-server-read-setup', mountNonce: 'own-server-read-setup' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{
          renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
          databaseWorkbench: {
          activityResource: () => { throw new Error('Unexpected Activity demand'); },
          lastLook: () => { throw new Error('Unexpected Activity counters'); },
          renderWriteSetup: input => {
            expect(input).toMatchObject({ target, code: 'read_role_setup_required' });
            return <Button title="Set up read-only login" onPress={() => {
              finishSetup = () => { configured = true; input.onConfigured(); };
            }} />;
          },
        } }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      subPath: encodeWorkbenchRootSubPath(target),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...resources, watchResource, executeAction: daemonAnswers([connected]) },
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Set up read-only login' }));
      expect(watchResource).toHaveBeenCalledTimes(1);
      expect(finishSetup).toBeDefined();
      await act(async () => { finishSetup?.(); });
      await fixture.findByRole('button', { name: 'invoices' });
      expect(await fixture.queryByText('Set up read-only login')).toBeUndefined();
    } finally { await fixture.dispose(); }
  });

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
      launchInput: projectNativeJsonValueForTransport({ scope, ...(surface === 'directory' ? { descriptor, place: 'overview' } : {}) }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: surface === 'directory' ? 'database-session-details' : 'database-session-rail' }, container: surface === 'directory' ? 'detailsTab' : 'rightSidebarTab' }, target: { kind: 'session', sessionId: 'paging' } }),
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

  it.each(['describe', 'catalogue'] as const)('discloses a managed %s refusal and retries the selected database', async (read) => {
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
      const action = read === 'describe' ? DATABASE_DESCRIBE_ACTION_ID_V1 : DATABASE_RELATIONS_LIST_ACTION_ID_V1;
      if (request.action === databaseActionLocalIdV1(action)) {
        expect(request.input).toMatchObject(read === 'describe' ? { target } : { target, schema: 'public' });
        if (!allowRead) {
          refused = true;
          return { ok: false, status: 'failed', code, reason: 'The provider refused the read.',
            cause: { source: 'platform', code: '429', message: 'The provider is throttling catalogue reads.' } };
        }
        if (read === 'describe') return projectNativeJsonValueForTransport({ ok: true, operation: 'describe', descriptor: managed });
      }
      return base(request);
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'catalogue-refusal', mountNonce: 'catalogue-refusal' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage, subPath: path,
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(managed),
        ...(read === 'describe' ? {
          async watchResource() { throw new PluginError({ code: 'plugin_resource_transport_unavailable' }); },
        } : {}),
        executeAction,
      },
    });
    try {
      await settle(20);
      expect(refused).toBe(true);
      await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
      expect(await fixture.getByText(`Code: ${code}`)).toBeTruthy();
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
            renderPopover: input => phoneSheet(input, 240),
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
      // The agent level is one titled field select, the shared choice control for four long options, showing the
      // saved level; no second line repeats it.
      const agentsField = async () => (await fixture.getAllByRole('button')).find(target => target.name?.startsWith('Agents'));
      const agents = await agentsField();
      expect(agents, 'Expected the Agents field select').toBeDefined();
      expect(agents!.name).toContain('Read and write (asks first)');
      expect(await fixture.queryByText('Agents can read and ask before writing.')).toBeUndefined();
      await act(async () => fixture.press(agents!));
      await act(async () => fixture.press(await fixture.getByRole('menuitemradio', { name: 'None' })));
      expect(write).not.toHaveBeenCalled();
      await act(async () => fixture.press(await fixture.getByRole('button', { name: 'Save' })));
      expect((await agentsField())!.name).toContain('None');
      expect(write).toHaveBeenCalledTimes(1);
      expect(reads()).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('reads Environment access on demand and carries a registered handler refusal to the access sheet', async () => {
    const target = { kind: 'deployment_service', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'billing_dev' } as const;
    const connected = { ...descriptor, target, access: { canRead: true, canWrite: true } };
    const connection = connectionResourceHandlers(connected);
    const watchResource = vi.fn(connection.watchResource);
    const readResource = vi.fn(connection.readResource);
    const commits = vi.fn();
    const readAccess = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
    const daemon = daemonAnswers([connected]);
    let refused = false;
    const refusalCode = 'deployment_target_role_unavailable';
    const refusalMessage = 'The Environment’s database reader is unavailable.';
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected database request'); };
    const host = await createPluginTestkit({ manifest: plugin.manifest, module: plugin,
      services: { deploymentDatabases: { listTargets: unexpected, resolve: unexpected,
        async admit(input, access) {
          expect(input).toEqual({ operation: 'describe', target });
          expect(access).toBe('read');
          if (refused) throw new PluginError({ code: refusalCode, message: refusalMessage });
          return { environment: { serverId: 'home', environmentId: 'template', revision: 2 },
            access: { canRead: true, canWrite: false, reason: 'database_not_an_editor' } };
        },
      } },
    });
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => {
      if (request.action !== readAccess) return daemon(request);
      return host.invokeAction(readAccess, request.input ?? null);
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
      surface: context => <Profiler id="Workbench" onRender={commits}><PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)} presentationHost={{
          renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, databaseWorkbench,
          renderPopover: input => phoneSheet(input, 240),
        }}>{renderPage(context)}</PluginUiHostPresentationScope></Profiler>,
      subPath: encodeWorkbenchRootSubPath(target),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connection, executeAction, watchResource, readResource },
    });
    try {
      await settle(20);
      expect(await fixture.queryByRole('button', { name: 'Can edit' })).toBeTruthy();
      expect(watchResource).toHaveBeenCalledTimes(1);
      expect(readResource).toHaveBeenCalledTimes(1);
      const statsRead = databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1);
      expect(executeAction.mock.calls.map(([request]) => request.action).sort()).toEqual([
        databaseActionLocalIdV1(DATABASE_SCHEMAS_LIST_ACTION_ID_V1),
        databaseActionLocalIdV1(DATABASE_RELATIONS_LIST_ACTION_ID_V1),
        statsRead,
        statsRead,
      ].sort());
      expect(executeAction.mock.calls.filter(([request]) => request.action === statsRead)).toEqual(expect.arrayContaining([
        [expect.objectContaining({ input: expect.objectContaining({ request: expect.objectContaining({ group: 'size' }) }) })],
        [expect.objectContaining({ input: expect.objectContaining({ request: expect.objectContaining({ group: 'statements' }) }) })],
      ]));
      const reads = () => executeAction.mock.calls.filter(([request]) => request.action === readAccess);
      expect(reads()).toHaveLength(0);
      expect(publish).toBeTypeOf('function');
      await act(async () => { publish?.(); });
      await settle(20);
      const button = await fixture.queryByRole('button', { name: 'Read only' });
      expect(button).toBeTruthy();
      await fixture.press(button!);
      expect(document.body.textContent).toContain('You aren’t in this Environment’s database editors.');
      expect(reads()).toHaveLength(1);
      commits.mockClear();
      vi.useFakeTimers();
      act(() => { vi.advanceTimersByTime(60_000); });
      vi.useRealTimers();
      await settle();
      expect(executeAction).toHaveBeenCalledTimes(5);
      expect(watchResource).toHaveBeenCalledTimes(1);
      expect(readResource).toHaveBeenCalledTimes(1);
      expect(commits).not.toHaveBeenCalled();
      refused = true;
      await act(async () => { publish?.(); });
      await settle(20);
      expect(reads()).toHaveLength(2);
      expect(document.body.textContent).toContain(refusalMessage);
      expect(commits).toHaveBeenCalledTimes(1);
      await fixture.press(await fixture.getByRole('button', { name: 'Details' }));
      expect(document.body.textContent).toContain(refusalCode);
    } finally {
      vi.useRealTimers();
      await fixture.dispose();
      await host.dispose();
    }
  });

  it('reopens a saved database when the person retries its failed connection read', async () => {
    const connection = connectionResourceHandlers();
    const watchResource = vi.fn(connection.watchResource)
      .mockRejectedValueOnce(new PluginError({ code: 'connection_unavailable', message: 'Connection unavailable' }));
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
      expect(await fixture.getByText('Connection unavailable')).toBeTruthy();
      expect(document.body.textContent).not.toContain('Create read-only login');
      expect(watchResource).toHaveBeenCalledTimes(1);
      await fixture.press(await fixture.getByRole('button', { name: 'Try again' }));
      await settle(20);
      expect(await fixture.getByRole('button', { name: '48212' })).toBeTruthy();
      expect(watchResource).toHaveBeenCalledTimes(2);
    } finally { await fixture.dispose(); }
  });

  it.each([
    ['postgresql', 'PostgreSQL', 'applied', 'direct'],
    ['mysql', 'MySQL', 'applied', 'direct'],
    ['postgresql', 'PostgreSQL', 'recoverable binding failure', 'direct'],
    ['postgresql', 'PostgreSQL', 'binding failure without a secret', 'direct'],
    ['postgresql', 'PostgreSQL', 'recoverable binding failure', 'browser approval'],
    ['mysql', 'MySQL', 'binding failure without a secret', 'browser approval'],
  ] as const)('identifies Railway %s (%s) through setup, review and %s settlement (%s)',
    async (engine, engineName, outcome, approval) => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
        targetLinkId: 'link', contribution: { pluginId: 'happier.deploy.railway-data', contributionId: engine },
        platformProjectId: 'project', branchId: 'branch', database: 'railway' } as const;
    const connected = { ...descriptor, target, engine, label: 'Billing',
      origin: { label: 'Railway', environmentName: 'Orders API Production', environment: 'production' as const } };
    // The identity line uses the saved label followed by the rail's facts.
    const identity = `Billing · ${engineName} · Orders API Production`;
    const openSurface = vi.fn<PluginUiHostApi['openSurface']>().mockResolvedValue(undefined);
    await openWorkbenchPage({ openSurface }, connected);
    const [, , options] = openSurface.mock.calls[0]!;
    const { serverId, machineId, installationId } = connected.placement;
    const prefix = `~run-on/${serverId}/${machineId}/${installationId}/`;
    expect(options?.subPath).toEqual(expect.stringContaining(prefix));
    const subPath = options?.subPath?.slice(prefix.length);
    const content = JSON.stringify({ descriptor: connected, ownWriteRevision: 0, relationRevisions: [] });
    const digest = `sha256:${computeSha256HexDigest(content)}`;
    const statements = ['CREATE ROLE happier_read LOGIN', 'GRANT SELECT ON railway.* TO happier_read'];
    const create = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);
    const attach = databaseActionLocalIdV1(DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1);
    const savedSecretRef = formatSharedSavedSecretRefV1('billing-reader');
    const resourceRevision = 3;
    const attachTitle = 'Use existing read-only login';
    const bindingFailureMessage = outcome === 'recoverable binding failure'
      ? 'The database login and its Saved Secret were created, but binding it did not complete. Use the existing read-only login to finish.'
      : 'The database login was created, but its Saved Secret was not saved.';
    let configured = false;
    let approvedFailureRecorded = false;
    const daemon = daemonAnswers([connected]);
    const execute = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async ({ action, input }) => {
      if (action === attach) {
        expect(input).toEqual({ target, savedSecretRef, resourceRevision });
        configured = true;
        return { ok: true, result: { ok: true, status: 'configured' } };
      }
      if (input && typeof input === 'object' && 'mode' in input && input.mode === 'preview') {
        return { ok: true, result: { ok: true, status: 'review', role: 'happier_read', statements,
          endpointTrust: 'encrypted_unverified' } };
      }
      expect(input).toEqual({ target, mode: 'apply', role: 'happier_read', statements });
      if (outcome !== 'applied') {
        const failure = { ok: false as const, errorCode: 'database_read_role_binding_failed', error: bindingFailureMessage,
          effectAttempted: true, details: { role: 'happier_read',
            ...(outcome === 'recoverable binding failure' ? { savedSecretRef, resourceRevision } : {}) },
          failureCause: { phase: 'deployment.bindings.prepare.destination', errorClass: 'Error' as const,
            errorCode: 'deployment_conflict', httpStatus: null } };
        const contributedFailure = projectContributedActionFailure({
          errorCode: failure.errorCode, error: failure.error, data: {
            effectAttempted: failure.effectAttempted, failureCause: failure.failureCause, details: failure.details,
          },
        });
        if (approval === 'direct') {
          return PluginUiActionControlExecutionV1Schema.parse(projectNativeJsonValueForTransport(contributedFailure));
        }
        // In-memory required-E2EE Artifact storage and a remote database refusal.
        // Consent, encryption, settlement and recorded-result reading use production owners.
        const dataKey = new Uint8Array(32).fill(23);
        let ciphertext = encryptWithDataKey(TargetActionApprovalRequestV1Schema.parse({
          v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
          createdBy: { surface: 'system' }, requestedSurface: 'api', qualifiedActionId: DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1,
          input, secretInputPaths: [], replayPlacement: { serverId, machineId },
          executionOriginV1: {
            v: 1, authority: 'account_automation', surface: 'api', caller: { kind: 'host' },
            serverId, machineId, accountId: 'owner', principalId: 'principal',
            credentialId: 'credential', actionId: 'action.invoke', requestId: 'database-apply',
          },
          sourceCustody: { kind: 'bundled_first_party', packagedRuntime: {
            kind: 'source_declaration', packageName: '@happier-dev/plugins-database-workbench',
          } },
          policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Create read-only login',
        }), dataKey);
        const read = async () => {
          const opened = decryptWithDataKeyResult(ciphertext, dataKey);
          if (opened.status !== 'authenticated') throw new Error('Could not open the approval Artifact');
          return TargetActionApprovalRequestV1Schema.parse(opened.value);
        };
        const decide = createTargetActionApprovalDecision({
          now: () => 2,
          read,
          update: async ({ request }) => {
            const admitted = admitTargetActionApprovalTransition(await read(), request);
            if (admitted.ok) ciphertext = encryptWithDataKey(request, dataKey);
            return admitted;
          },
          executeApproved: async ({ request, persist, nextTimestamp }) => {
            const executing = { ...request, status: 'executing' as const, updatedAtMs: nextTimestamp(request) };
            expect(await persist(executing)).toBeNull();
            return settleTargetActionExecution({ request: executing, result: contributedFailure, persist,
              operationCredentialUses: [], executedAtMs: nextTimestamp(executing) });
          },
        });
        expect(await decide({ artifactId: 'database-apply', decision: 'approve',
          context: { surface: 'ui', authority: 'present_user', runtimeAccountId: 'owner' },
        })).toMatchObject({ ok: false, errorCode: failure.errorCode });
        const receipt = await read();
        expect(receipt.execution?.details).toEqual(outcome === 'recoverable binding failure'
          ? { savedSecretRef, resourceRevision } : undefined);
        approvedFailureRecorded = receipt.status === 'failed' && receipt.decision?.authority === 'present_user';
        const recorded = buildActionExecuteResultFromRecordedApprovalExecution(receipt);
        if (!recorded || recorded.ok) throw new Error('Expected an approved database Apply failure receipt');
        return PluginUiActionControlExecutionV1Schema.parse(projectNativeJsonValueForTransport(recorded));
      }
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
          ...(outcome === 'applied' ? {} : {
            renderSavedSecretChoiceList: ({ selectedRef }: { selectedRef: string | null }) =>
              <span>{selectedRef === savedSecretRef ? 'Saved read-only URL selected' : 'Choose a saved URL'}</span>,
          }),
          renderActionControl: ({ control: bound, presentation }) =>
            <Button title={presentation.title} disabled={!bound || presentation.disabled}
              onPress={() => control.press(presentation.title)} />,
        }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      subPath,
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
      if (outcome === 'applied') {
        expect(document.body.textContent).toContain(identity);
        await fixture.press(await fixture.getByRole('button', { name: attachTitle }));
        expect(await fixture.getByText('Saved secrets are unavailable on this host.')).toBeTruthy();
        await fixture.press(await fixture.getByRole('button', { name: 'Back to setup options' }));
      }
      await fixture.press(await fixture.getByRole('button', { name: 'Create read-only login' }));
      await settle(20);
      expect(execute.mock.calls.map(([{ action, input }]) => ({ action, input })))
        .toEqual([{ action: create, input: { target, mode: 'preview' } }]);
      expect(daemon.mock.calls.map(([request]) => request.action)).not.toContain(create);
      for (const sql of statements) expect(document.body.textContent).toContain(sql);
      expect(await fixture.getByText(identity)).toBeTruthy();
      expect(await fixture.getByText('The connection is encrypted, but the provider can’t prove this is your database server.')).toBeTruthy();
      expect(configured).toBe(false);
      await fixture.press(await fixture.getByRole('button', { name: 'Create read-only login' }));
      await settle(20);
      if (outcome !== 'applied') {
        expect(configured).toBe(false);
        expect(execute.mock.calls.map(([{ action }]) => action)).toEqual([create, create]);
        if (approval === 'browser approval') {
          await execute.mock.results[1]?.value;
          expect(approvedFailureRecorded).toBe(true);
        }
        if (outcome === 'binding failure without a secret') {
          if (approval === 'direct') expect(await fixture.getByText(bindingFailureMessage)).toBeTruthy();
          expect(await fixture.queryByRole('button', { name: attachTitle })).toBeUndefined();
          expect(await fixture.queryByRole('button', { name: 'Create read-only login' })).toBeTruthy();
          return;
        }
        // The login exists and is saved: using it is the one way forward, and a second login is not offered.
        expect(document.body.textContent).toContain('happier_read');
        expect(await fixture.queryByRole('button', { name: 'Create read-only login' })).toBeUndefined();
        expect(await fixture.getAllByRole('button', { name: attachTitle })).toHaveLength(1);
        await fixture.press(await fixture.getByRole('button', { name: attachTitle }));
        expect(await fixture.getByText('Saved read-only URL selected')).toBeTruthy();
        expect(await fixture.queryByRole('button', { name: 'Create read-only login' })).toBeUndefined();
        expect(execute.mock.calls).toHaveLength(2);
        await fixture.press(await fixture.getByRole('button', { name: 'Use this login' }));
        await settle(20);
        expect(execute.mock.calls.map(([{ action }]) => action)).toEqual([create, create, attach]);
      }
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
    let editingOff = outcome === 'refused';
    const execute = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => {
      if (editingOff) return { ok: false, errorCode: code, error: code };
      return { ok: true, result: outcome === 'refused' ? { ok: true, status: 'review', role: 'happier_read',
        statements: ['CREATE ROLE happier_read'], endpointTrust: 'encrypted_unverified' } : null };
    });
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
          databaseWorkbench: {
            activityResource: () => { throw new Error('Unexpected Activity demand'); },
            lastLook: () => { throw new Error('Unexpected Last Look demand'); },
            // The host's Environment wake, delivered when a manager turns editing on.
            renderEnvironmentAccessObserver: ({ target: observed, onChanged }) => {
              expect(observed).toEqual(target);
              return <Button title="Environment changed" onPress={onChanged} />;
            },
          },
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
        // Editing off is the Environment's policy: a refusal line without a failure's diagnostic disclosure.
        expect(await fixture.queryByRole('button', { name: 'Details' })).toBeUndefined();
        expect(document.body.textContent).not.toContain('Something went wrong');
        expect((await fixture.getByRole('button', { name: 'Use existing read-only login' })).state?.disabled).not.toBe(true);
        // Editing off forbids creating a login, so Create is not offered while the refusal stands.
        expect(await fixture.queryByRole('button', { name: 'Create read-only login' })).toBeUndefined();
        editingOff = false;
        await fixture.press(await fixture.getByRole('button', { name: 'Environment changed' }));
        await settle(5);
        await fixture.press(await fixture.getByRole('button', { name: 'Create read-only login' }));
        await settle(20);
        expect(execute.mock.calls).toHaveLength(2);
        expect(execute.mock.calls[1]?.[0]).toMatchObject({ action: create, input: { target, mode: 'preview' } });
        expect(await fixture.getByText('Review the read-only login')).toBeTruthy();
        return;
      } else {
        expect(await fixture.getByText('Could not verify the setup result.')).toBeTruthy();
        expect(presentActionFailure).not.toHaveBeenCalled();
      }
      expect(document.body.textContent).not.toContain('Review the read-only login');
      expect(await fixture.getByRole('button', { name: 'Use existing read-only login' })).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it.each(['write_connection_setup_required', 'write_role_setup_required', 'database_unmapped_refusal'] as const)(
    'leads read setup refused with %s through the host write setup, then Create again', async (code) => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
        targetLinkId: 'link', contribution: { pluginId: 'happier.deploy.railway-data', contributionId: 'postgresql' },
        platformProjectId: 'project', branchId: 'branch', database: 'billing_dev' } as const;
    const create = databaseActionLocalIdV1(DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1);
    const writeSetup = code !== 'database_unmapped_refusal';
    let configured = false;
    const execute = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => configured
      ? { ok: true as const, result: { ok: true, status: 'review', role: 'happier_read', statements: ['CREATE ROLE happier_read'] } }
      : { ok: false as const, errorCode: code, error: code });
    const control = createPluginUiActionControlTestHost(execute);
    const renderWriteSetup = vi.fn((input: { onConfigured(): void }) =>
      <Button title="Set up database writes" onPress={() => { configured = true; input.onConfigured(); }} />);
    const presentActionFailure = vi.fn<NonNullable<PluginUiTestkitHostHandlers['presentActionFailure']>>(async () =>
      ({ reason: 'Something went wrong', nextStep: null, technicalDetails: [] }));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `read-setup-${code}`, mountNonce: `read-setup-${code}` },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{
          renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
          databaseWorkbench: {
            activityResource: () => { throw new Error('Unexpected Activity demand'); },
            lastLook: () => { throw new Error('Unexpected Last Look demand'); },
            renderWriteSetup,
          },
        }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      subPath: encodeWorkbenchRootSubPath(target, { engine: 'postgresql', label: 'Billing Postgres', origin: 'Billing staging' }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(),
        async watchResource() { throw new PluginError({ code: 'read_role_setup_required' }); },
        executeAction: daemonAnswers([{ ...descriptor, target }]),
        actionControl: control.handler,
        presentActionFailure,
      },
    });
    try {
      await settle(20);
      // The identity line leads with the label the open carried, not the database's address name.
      expect(document.body.textContent).toContain('Billing Postgres · ');
      expect(document.body.textContent).not.toContain('billing_dev');
      await act(async () => control.press('Create read-only login'));
      await settle(20);
      expect(execute.mock.calls.map(([{ action, input }]) => ({ action, input })))
        .toEqual([{ action: create, input: { target, mode: 'preview' } }]);
      if (!writeSetup) {
        // A code no owner names keeps the generic failure presentation.
        expect(renderWriteSetup).not.toHaveBeenCalled();
        expect(presentActionFailure).toHaveBeenCalled();
        expect(document.body.textContent).toContain('Something went wrong');
        return;
      }
      expect(renderWriteSetup).toHaveBeenLastCalledWith({ target, code, onConfigured: expect.any(Function) });
      expect(document.body.textContent).not.toContain('Something went wrong');
      // While the setup stands it is the way forward; Create would refuse again, so it is not the filled control.
      expect(control.presentation('Create read-only login')?.variant).toBe('secondary');
      await fixture.press(await fixture.getByRole('button', { name: 'Set up database writes' }));
      await settle(5);
      expect(control.presentation('Create read-only login')?.variant).toBe('primary');
      await act(async () => control.press('Create read-only login'));
      await settle(20);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1]?.[0]).toMatchObject({ action: create, input: { target, mode: 'preview' } });
      expect(await fixture.getByText('Review the read-only login')).toBeTruthy();
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

  it.each(['manual', 'service'] as const)('offers Forget database at the end of a %s database Overview only when it was connected by hand', async kind => {
    const forget = databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1);
    const { kind: _kind, ...placement } = scope;
    const shown = kind === 'manual'
      ? { ...descriptor, target: { ...placement, kind: 'manual' as const, savedSecretId: 'saved-url' } }
      : descriptor;
    const write = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async request => {
      expect(request.action).toEqual(forget);
      expect(request.input).toEqual({ target: shown.target });
      return { ok: true, result: { ok: true } };
    });
    const control = createPluginUiActionControlTestHost(write);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `page-forget-${kind}`, mountNonce: `page-forget-${kind}` },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: shown }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(shown), executeAction: daemonAnswers([shown]), actionControl: control.handler,
        replacePageLocation: async ({ subPath }) => subPath },
    });
    try {
      await settle(20);
      if (kind === 'service') {
        expect(control.presentation('Forget database')).toBeUndefined();
        return;
      }
      // A quiet control at its own width; the review the Action carries confirms it.
      expect(control.presentation('Forget database')?.variant).toBe('secondary');
      await act(async () => control.press('Forget database'));
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(await fixture.getByText('billing_dev is no longer connected')).toBeTruthy();
      expect(control.presentation('Forget database')).toBeUndefined();
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

  it('shows Overview facts with a single Activity sample even when the Account enables auto-refresh', async () => {
    const basis = { bindingKey: 'binding', databaseIdentity: 'billing_dev', selectionKey: 'overview' };
    const retainAutoRefresh = vi.fn<(demand: { intervalMs: number }) => void>();
    const presentationHost: PluginUiPresentationHost = {
      renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
      databaseWorkbench: {
        useActivityRefreshIntervalMs: () => 5_000,
        activityResource: source => {
          let snapshot = { value: null as Awaited<ReturnType<typeof source.read>> | null, loading: true, error: null };
          const listeners = new Set<() => void>();
          const refresh = async () => {
            const value = await source.read({ signal: new AbortController().signal });
            snapshot = { value, loading: false, error: null };
            for (const listener of listeners) listener();
          };
          return {
            getSnapshot: () => snapshot,
            subscribe: listener => {
              listeners.add(listener);
              return () => { listeners.delete(listener); };
            },
            retainAutoRefresh: demand => {
              retainAutoRefresh(demand);
              void refresh();
              return () => {};
            },
            refresh, invalidate: () => {}, dispose: () => {},
          };
        },
        lastLook: () => ({
          observe: () => ({ comparison: { status: 'unavailable', reason: 'previous_sample_required' }, persistenceError: null }),
        }),
      },
    };
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
          : group === 'activity'
            ? { v: 1, observedAtMs: 1, engineId: 'postgresql', scope: { database: 'billing_dev' }, intervalBasis: basis,
                status: 'available', group: 'activity', coverage: { status: 'complete' }, completeness: { complete: true }, data: [] }
            : { v: 1, observedAtMs: 1, engineId: 'postgresql', scope: { database: 'billing_dev' }, intervalBasis: basis,
              status: 'unavailable', group: group ?? 'statements', reason: 'extension_missing' },
      });
    });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'page-overview-tiles', mountNonce: 'page-overview-tiles' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={presentationHost}>{renderPage(context)}</PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }), subPath: 'overview',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-workbench' }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction, replacePageLocation: async ({ subPath }) => subPath },
    });
    try {
      await settle(20);
      expect(await fixture.getByRole('group', { name: 'Size: 412 MB' })).toBeTruthy();
      expect(await fixture.getByRole('group', { name: 'Statement statistics: Off, Needs pg_stat_statements' })).toBeTruthy();
      expect(retainAutoRefresh.mock.calls).toEqual([[{ intervalMs: 0 }]]);
      expect(await fixture.getByRole('group', { name: 'Connections: 0' })).toBeTruthy();
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
    { provider: 'Railway', engine: 'mysql' as const, environmentName: 'Billing preview', environment: 'preview' as const,
      trust: { endpointTrust: 'encrypted_unverified' as const }, showsNotice: true },
    { provider: 'Neon', engine: 'postgresql' as const, environmentName: 'Billing EU', environment: 'production' as const,
      trust: {}, showsNotice: false },
  ])('reviews staged changes for $provider without executing a database write', async ({ provider, engine, environmentName, environment, trust, showsNotice }) => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      targetLinkId: 'link', database: 'billing_dev', contribution: { pluginId: `fixture.${provider.toLowerCase()}`, contributionId: engine },
      platformProjectId: 'project', branchId: 'branch' } as const;
    const connected = { ...descriptor, engine, target, origin: { label: provider, environmentName, environment },
      access: { canRead: true, canWrite: true }, ...trust };
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
      expect(document.body.textContent).toContain(`in ${environmentName}`);
      if (environment === 'production') expect(document.body.textContent).toContain('on Production');
      expect(/triggers.*MyISAM/i.test(document.body.textContent ?? '')).toBe(engine === 'mysql');
      const notice = 'The connection is encrypted, but the provider can’t prove this is your database server.';
      if (showsNotice) expect(await fixture.getByText(notice)).toBeTruthy();
      else expect(await fixture.queryByText(notice)).toBeUndefined();
      expect(executeAction).not.toHaveBeenCalled();

      if (engine === 'mysql') {
        await fixture.press(await fixture.getByRole('button', { name: 'Cancel' }));
        expect(await fixture.queryByRole('heading', { name: 'Review 1 change' })).toBeUndefined();
        expect(executeAction).not.toHaveBeenCalled();
        await fixture.press(await fixture.getByRole('button', { name: 'Review' }));
        expect(await fixture.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy();
      }
      await fixture.press(await fixture.getByRole('button', { name: 'Take back' }));
      expect(await fixture.findByRole('button', { name: '48212' })).toBeTruthy();
      expect(await fixture.queryByRole('button', { name: 'Review' })).toBeUndefined();
      expect(executeAction).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  it.each([
    { kind: 'deployment_service', hasSetup: true },
    { kind: 'managed_deployment', hasSetup: true },
    { kind: 'managed_deployment', hasSetup: false },
  ] as const)('keeps the reviewed production draft when $kind write setup is required (setup offered: $hasSetup)', async ({ kind, hasSetup }) => {
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
    const reason = 'The direct write connection needs to be configured.';
    let configured = false;
    const write = vi.fn(async (_request: Parameters<Parameters<typeof createPluginUiActionControlTestHost>[0]>[0]) => configured
      ? { ok: true as const, result: { ok: true, operation: 'edits.apply', status: 'committed', inserted: '1', updated: '0', deleted: '0' } }
      : { ok: false as const, errorCode: code, error: code });
    const control = createPluginUiActionControlTestHost(write);
    const databaseWorkbench = {
      activityResource: () => { throw new Error('Unexpected Activity demand'); },
      lastLook: () => { throw new Error('Unexpected Last Look demand'); },
      renderProductionBackup: () => <Button title="Back up now" onPress={() => {}} />,
      renderWriteSetup: (input: { onConfigured(): void }) => {
        expect(input).toEqual({ target, code, onConfigured: expect.any(Function) });
        return hasSetup ? <Button title="Set up database writes" onPress={() => { configured = true; input.onConfigured(); }} /> : null;
      },
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: kind, mountNonce: kind },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{
          renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, databaseWorkbench,
          renderPopover: input => input.open ? phoneSheet(input, 10_000) : null,
        }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: connected }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { ...connectionResourceHandlers(), executeAction: daemonAnswers([connected], true), actionControl: control.handler,
        async presentActionFailure({ failure }) {
          expect(failure.errorCode).toBe(code);
          return { reason, nextStep: null, technicalDetails: [] };
        },
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
      expect(await fixture.getByRole('button', { name: 'Back up now' })).toBeTruthy();
      expect(await fixture.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy();
      expect(write).toHaveBeenCalledTimes(1);
      if (!hasSetup) {
        await settle(20);
        expect(await fixture.getByText(reason)).toBeTruthy();
        expect(document.body.textContent).not.toContain('Something went wrong');
        return;
      }
      const setup = await fixture.getByRole('button', { name: 'Set up database writes' });
      expect(document.body.textContent).not.toContain('Something went wrong');
      // While the setup stands, it is the way forward: Apply would refuse again, so it is not the filled control.
      expect(control.presentation('Apply to Production')?.variant).toBe('secondary');
      await fixture.press(setup);
      await settle(5);
      expect(control.presentation('Apply to Production')?.variant).toBe('destructive');
      expect(write).toHaveBeenCalledTimes(1);
      await act(async () => control.press('Apply to Production'));
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1]?.[0].input).toEqual(write.mock.calls[0]?.[0].input);
    } finally { await fixture.dispose(); }
  });

  it.each([
    { label: 'selected Member', canWrite: true },
    { label: 'unselected Guest', canWrite: false },
  ])('uses held Environment access on a cold relation for the $label', async ({ canWrite }) => {
    const target = { kind: 'deployment_service', environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
      deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'billing_dev' } as const;
    const connected: DatabaseDescriptorV1 = { ...descriptor, target, access: {
      canRead: true, canWrite, ...(canWrite ? {} : { reason: 'database_not_an_editor' }),
    } };
    const executeAction = daemonAnswers([connected], true);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'cold-environment-relation', mountNonce: 'cold-environment-relation' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: connected }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...connectionResourceHandlers(connected), executeAction },
    });
    try {
      await fixture.findByRole('button', { name: '48212' });
      expect(Boolean(await fixture.queryByRole('button', { name: 'New row' }))).toBe(canWrite);
      expect(executeAction.mock.calls.map(([request]) => request.action))
        .not.toContain(databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1));
    } finally { await fixture.dispose(); }
  });

  it.each(['database_editing_off', 'database_not_an_editor'] as const)('leads a %s Review refusal with its access recovery until the Environment access update lets the person edit', async code => {
    const environment = { serverId: 'home', environmentId: 'env', projectSourceId: 'source' } as const;
    const target = { kind: 'deployment_service', environment, targetLinkId: 'link', database: 'billing_dev', deploymentId: 'deployment', serviceId: 'postgres' } as const;
    const connected = { ...descriptor, target, origin: { label: 'Staging' }, access: { canRead: true, canWrite: true } };
    const body = JSON.stringify({ descriptor: connected, ownWriteRevision: 0, relationRevisions: [] });
    const digest = `sha256:${computeSha256HexDigest(body)}`;
    const readAccess = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
    const reason = 'Database editing is off for this Environment.';
    let canEdit = false;
    const policyListeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      policyListeners.add(listener);
      return () => { policyListeners.delete(listener); };
    };
    function EnvironmentAccess({ onEditingAllowed }: { onEditingAllowed?: () => void }) {
      const currentCanEdit = useSyncExternalStore(subscribe, () => canEdit);
      useEffect(() => {
        if (currentCanEdit) onEditingAllowed?.();
      }, [currentCanEdit, onEditingAllowed]);
      return <Button title="Open Environment settings" onPress={() => {}} />;
    }
    const daemon = daemonAnswers([connected], true);
    const executeAction = vi.fn(async (request: PluginUiTestkitExecuteActionInput) => request.action !== readAccess ? daemon(request)
      : projectNativeJsonValueForTransport({ setBy: 'environment', serverId: 'home', environmentId: 'env', expectedRevision: 2,
        access: { canRead: true, canWrite: false, reason: code } }));
    const write = vi.fn(async (_request: Parameters<Parameters<typeof createPluginUiActionControlTestHost>[0]>[0]) => canEdit
      ? { ok: true as const, result: { ok: true, operation: 'edits.apply', status: 'committed', inserted: '1', updated: '0', deleted: '0' } }
      : { ok: false as const, errorCode: code, error: code });
    const control = createPluginUiActionControlTestHost(write);
    const databaseWorkbench = {
      activityResource: () => { throw new Error('Unexpected Activity demand'); },
      lastLook: () => { throw new Error('Unexpected Last Look demand'); },
      renderEnvironmentAccessSettings: ({ onEditingAllowed }: { target: unknown; onEditingAllowed?: () => void }) => (
        <EnvironmentAccess onEditingAllowed={onEditingAllowed} />
      ),
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `refusal-${code}`, mountNonce: `refusal-${code}` },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={{ renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, databaseWorkbench,
          renderPopover: input => input.open ? phoneSheet(input, 10_000) : null }}>
        {renderPage(context)}
      </PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor: connected }), subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      handlers: { ...connectionResourceHandlers(), executeAction, actionControl: control.handler,
        async presentActionFailure() { return { reason, nextStep: null, technicalDetails: [] }; },
        async watchResource() { return { digest }; },
        async readResource() { return { contentType: 'application/json', digest, bytes: new TextEncoder().encode(body) }; },
      },
    });
    try {
      await settle(20);
      await fixture.press(await fixture.getByRole('button', { name: 'New row' }));
      // Each field shows the column it fills (TRACKING 1360), not only its type.
      expect(await fixture.getByText('number')).toBeDefined();
      await fixture.press(await fixture.getByRole('button', { name: 'Stage row' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Review' }));
      expect(control.presentation('Apply 1 change')?.variant).toBe('primary');
      await act(async () => control.press('Apply 1 change'));
      await settle(20);
      // The refusal's recovery is the way forward; Apply would refuse again, so it steps back.
      expect(await fixture.getByRole('button', { name: 'Open Environment settings' })).toBeTruthy();
      expect(await fixture.getByText(reason)).toBeTruthy();
      expect(control.presentation('Apply 1 change')?.variant).toBe('secondary');
      const accessReads = () => executeAction.mock.calls.filter(([request]) => request.action === readAccess).length;
      const readsBeforeSave = accessReads();
      // Settings publishes the saved capability to the same Review while the earlier Action result stays held.
      await act(async () => {
        canEdit = true;
        for (const listener of policyListeners) listener();
      });
      expect(await fixture.queryByText(reason)).toBeUndefined();
      expect(await fixture.queryByRole('button', { name: 'Open Environment settings' })).toBeUndefined();
      expect(control.presentation('Apply 1 change')?.variant).toBe('primary');
      expect(accessReads()).toBe(readsBeforeSave);
      expect(await fixture.getByRole('heading', { name: 'Review 1 change' })).toBeTruthy();
      expect(write).toHaveBeenCalledTimes(1);
      await act(async () => control.press('Apply 1 change'));
      expect(write.mock.calls[1]?.[0].input).toEqual(write.mock.calls[0]?.[0].input);
      expect(await fixture.queryByRole('heading', { name: 'Review 1 change' })).toBeUndefined();
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
          if (request.requestId === 'run-unknown-console') {
            return { ok: true, result: { ok: false, status: 'outcome_unknown', code: 'database_outcome_unknown', cause: {
              source: 'transport', code: 'ECONNRESET', message: 'Connection reset during COMMIT',
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

      await act(async () => { run?.publish({ kind: 'prepare', requestId: 'run-unknown-console' }); });
      await settle();
      expect(await fixture.queryByText('Connection reset during COMMIT')).toBeTruthy();
      expect(await fixture.queryByText('Nothing was changed.')).toBeFalsy();
    } finally { await fixture.dispose(); }
  });
  it('replaces the dotenv row in mounted Dev servers when the worktree bindings change', async () => {
    const dotenv: DatabaseDescriptorV1 = {
      ...descriptor,
      label: '.env · DATABASE_URL',
      origin: { label: '.env' },
      target: { ...scope, kind: 'worktree', source: { kind: 'env_file', path: '.env', variable: 'DATABASE_URL' } },
    };
    const beforeStart = daemonAnswers([dotenv]);
    const afterStart = daemonAnswers([descriptor]);
    let running = false;
    let serviceChanged: (() => void) | undefined;
    const databaseWorkbench = {
      useActivityRefreshIntervalMs: () => 0,
      useActivityMachineOffline: () => false,
      activityResource: () => { throw new Error('No database is open'); },
      lastLook: () => { throw new Error('No database is open'); },
      useWorktreeTargetChanges(worktree: typeof scope | null, changed: () => void) {
        useEffect(() => {
          if (!worktree) return;
          serviceChanged = changed;
          return () => { serviceChanged = undefined; };
        }, [worktree, changed]);
      },
    };
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'service-start', mountNonce: 'service-start' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)} presentationHost={{
        renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null, databaseWorkbench,
      }}>{renderPanel(context)}</PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
        destination: { pluginId: 'happier.database', localId: 'databases-panel' }, container: 'servicesPanel' },
        target: { kind: 'services' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: request => (running ? afterStart : beforeStart)(request) },
    });
    try {
      await settle();
      const buttonNames = async () => (await fixture.getAllByRole('button')).map(button => button.name ?? '').join('\n');
      expect(await buttonNames()).toContain('.env · DATABASE_URL');
      expect(afterStart).not.toHaveBeenCalled();
      await act(async () => {
        running = true;
        serviceChanged?.();
      });
      await settle();
      expect(await buttonNames()).toContain('billing_dev');
      expect(await buttonNames()).not.toContain('.env · DATABASE_URL');
      expect(afterStart).toHaveBeenCalledTimes(1);
    } finally { await fixture.dispose(); }
    expect(serviceChanged).toBeUndefined();
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

  it.each(['servicesPanel', 'rightSidebarTab'] as const)('discloses a typed target-list refusal on %s', async container => {
    const refusal = new PluginError({ code: 'database_machine_unavailable', message: 'The selected machine could not list databases.' });
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: container, mountNonce: 'target-list-refusal' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: container === 'servicesPanel' ? renderPanel : renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: container === 'servicesPanel' ? 'databases-panel' : 'database-session-rail',
      }, container }, target: container === 'servicesPanel' ? { kind: 'services' } : { kind: 'session', sessionId: 'session' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => { throw refusal; } },
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Details' }));
      expect(await fixture.getByText('Code: database_machine_unavailable')).toBeTruthy();
      expect(await fixture.getByText(refusal.message)).toBeTruthy();
    } finally { await fixture.dispose(); }
  });

  it.each(['servicesPanel', 'rightSidebarTab'] as const)('connects a Saved Secret to the selected checkout from an empty %s', async (container) => {
    const connect = databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1);
    const forget = databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1);
    const { kind: _kind, ...placement } = scope;
    const installed = { ...descriptor, target: { ...placement, kind: 'manual' as const, savedSecretId: 'saved-url' } };
    let targets: DatabaseDescriptorV1[] = [];
    let ready = false;
    const operate = vi.fn((request: PluginUiTestkitExecuteActionInput) => daemonAnswers(targets)(request));
    const write = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async request => {
      if (request.action === connect) {
        expect(request.input).toEqual({ scope, savedSecretRef: 'saved-url', label: 'Database with a Saved Secret' });
        targets = [installed];
        if (!ready) return { ok: false, errorCode: 'database_target_unavailable', error: 'Database is offline.' };
        return { ok: true, result: projectNativeJsonValueForTransport(installed) };
      }
      expect(request).toMatchObject({ action: forget, input: { target: installed.target } });
      expect(request.input).toEqual({ target: installed.target });
      targets = [];
      return { ok: true, result: { ok: true } };
    });
    const control = createPluginUiActionControlTestHost(write);
    const render = container === 'servicesPanel' ? renderPanel : renderRail;
    function SavedKeyPicker(input: SavedSecretChoiceListProps) {
      const select = input.onSelect;
      if (!select) return <Button title="Add a key" onPress={() => input.onConnect?.('new-url')} />;
      return <SelectionTiles accessibilityLabel="Saved key" value={input.selectedRef ?? ''}
        onChange={ref => select({ ref, resourceRevision: 1 })}
        options={[
          { id: 'saved-url', title: 'Saved database URL' },
          { id: 'different-url', title: 'Different database URL' },
        ]} />;
    }
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: container, mountNonce: 'connect-empty' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)} presentationHost={{
        renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
        renderSavedSecretChoiceList: input => <SavedKeyPicker {...input} />,
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
      await fixture.press(await fixture.getByRole('radio', { name: 'Saved database URL' }));
      expect((await fixture.getByRole('radio', { name: 'Saved database URL' })).state?.checked).toBe(true);
      expect(await fixture.getByText('Connection name')).toBeTruthy();
      const name = document.querySelector<HTMLInputElement>('input[aria-label="Connection name"]')!;
      expect(name).toBeTruthy();
      expect(control.presentation('Test and connect')?.disabled).toBe(false);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Database with a Saved Secret');
        name.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await fixture.press(await fixture.getByRole('radio', { name: 'Different database URL' }));
      expect((await fixture.getByRole('radio', { name: 'Different database URL' })).state?.checked).toBe(true);
      await fixture.press(await fixture.getByRole('radio', { name: 'Saved database URL' }));
      expect((await fixture.getByRole('radio', { name: 'Saved database URL' })).state?.checked).toBe(true);
      expect(name.value).toBe('Database with a Saved Secret');
      await act(async () => control.press('Test and connect'));
      expect(control.presentation('Try again')).toBeDefined();
      expect(control.presentation('Forget database')).toBeDefined();
      ready = true;
      await act(async () => control.press('Try again'));
      await settle();
      expect(await fixture.getByText(installed.label)).toBeTruthy();
      expect(write.mock.calls.map(([request]) => request.action)).toEqual([connect, connect]);
      // A connected database is forgotten from its Overview, never from its row or the rail at rest (DBW ORCH 11-28).
      expect(control.presentation('Forget database')).toBeUndefined();
      expect(operate.mock.calls.some(([request]) => request.action === connect || request.action === forget)).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it.each(['servicesPanel', 'rightSidebarTab'] as const)('opens an existing SQLite file from %s', async container => {
    const path = 'data/selected file.sqlite';
    const target = { ...scope, source: { kind: 'sqlite_file' as const, path } };
    const selected: DatabaseDescriptorV1 = { ...descriptor, target, engine: 'sqlite', label: path, origin: { label: path } };
    const describe = databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1);
    let denied = true;
    const dispatch = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async request => {
      expect(request).toMatchObject({ action: describe, input: { operation: 'describe', target } });
      if (denied) return { ok: true, result: { ok: false, status: 'failed', code: 'database_file_unavailable',
        cause: { source: 'engine', code: 'SQLITE_CANTOPEN', message: 'SQLite could not open the database file.' } } };
      return { ok: true, result: projectNativeJsonValueForTransport({ ok: true, operation: 'describe', descriptor: selected }) };
    });
    const control = createPluginUiActionControlTestHost(dispatch);
    const openSurface = vi.fn<NonNullable<PluginUiTestkitHostHandlers['openSurface']>>(async () => {});
    const presentActionFailure = vi.fn<NonNullable<PluginUiTestkitHostHandlers['presentActionFailure']>>(async ({ failure }) => ({
      reason: failure.error ?? failure.errorCode, nextStep: null, technicalDetails: [],
    }));
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: container, mountNonce: 'selected-sqlite-file' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: container === 'servicesPanel' ? renderPanel : renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: container === 'servicesPanel' ? 'databases-panel' : 'database-session-rail',
      }, container },
      target: container === 'servicesPanel' ? { kind: 'services' } : { kind: 'session', sessionId: 'session' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: daemonAnswers([]), actionControl: control.handler, openSurface, presentActionFailure },
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Connect a database' }));
      // What to connect is one visible choice (no mode toggle): a database server or a SQLite file in this checkout.
      expect((await fixture.getByRole('radio', { name: 'A database server, Its address, kept as a Saved Secret' })).state?.checked).toBe(true);
      await fixture.press(await fixture.getByRole('radio', { name: 'A SQLite file, A file in this checkout' }));
      const field = document.querySelector<HTMLInputElement>('input[aria-label="SQLite file path"]')!;
      expect(field).toBeTruthy();
      expect(control.presentation('Open SQLite file')?.disabled).toBe(true);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, path);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => control.press('Open SQLite file'));
      await settle();
      expect(presentActionFailure).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.objectContaining({
        errorCode: 'database_file_unavailable', details: expect.objectContaining({ cause: { source: 'engine', code: 'SQLITE_CANTOPEN',
          message: 'SQLite could not open the database file.' } }),
      }) }));
      denied = false;
      await act(async () => control.press('Open SQLite file'));
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
        view: expect.objectContaining({ localId: WORKBENCH_PAGE_VIEW_ID }),
        subPath: expect.stringContaining(encodeWorkbenchRootSubPath(target)),
      }));
    } finally { await fixture.dispose(); }
  });

  it.each(['servicesPanel', 'rightSidebarTab'] as const)('picks the SQLite file from the checkout on %s; a dismissal changes nothing and an unavailable checkout says why', async container => {
    const path = 'data/picked.sqlite';
    const target = { ...scope, source: { kind: 'sqlite_file' as const, path } };
    const selected: DatabaseDescriptorV1 = { ...descriptor, target, engine: 'sqlite', label: path, origin: { label: path } };
    const dispatch = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async request => {
      expect(request).toMatchObject({ input: { operation: 'describe', target } });
      return { ok: true, result: projectNativeJsonValueForTransport({ ok: true, operation: 'describe', descriptor: selected }) };
    });
    const control = createPluginUiActionControlTestHost(dispatch);
    const answers = [
      { kind: 'cancelled' as const },
      { kind: 'unavailable' as const, reason: 'checkout_unavailable' as const },
      { kind: 'picked' as const, relativePath: path },
    ];
    const pickWorkspaceFile = vi.fn(async () => answers.shift()!);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: `pick-${container}`, mountNonce: 'picked-sqlite-file' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: container === 'servicesPanel' ? renderPanel : renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: container === 'servicesPanel' ? 'databases-panel' : 'database-session-rail',
      }, container },
      target: container === 'servicesPanel' ? { kind: 'services' } : { kind: 'session', sessionId: 'session' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: daemonAnswers([]), actionControl: control.handler, pickWorkspaceFile },
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Connect a database' }));
      await fixture.press(await fixture.getByRole('radio', { name: 'A SQLite file, A file in this checkout' }));
      const field = () => document.querySelector<HTMLInputElement>('input[aria-label="SQLite file path"]')!;
      // Typing stays the alternative; the picker fills the same field.
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), 'typed.sqlite');
        field().dispatchEvent(new Event('input', { bubbles: true }));
      });
      const choose = async () => { await fixture.press(await fixture.getByRole('button', { name: 'Choose file…' })); await settle(); };
      // Dismissed: the field keeps what was there, and nothing is called an error.
      await choose();
      expect(field().value).toBe('typed.sqlite');
      expect(await fixture.queryByText('This checkout isn’t available on its Machine right now')).toBeUndefined();
      // An unavailable checkout says its typed reason; the field is unchanged.
      await choose();
      expect(await fixture.queryByText('This checkout isn’t available on its Machine right now')).toBeTruthy();
      expect(field().value).toBe('typed.sqlite');
      // Picked: the checkout-relative path fills the field and opens as typed would.
      await choose();
      expect(field().value).toBe(path);
      expect(await fixture.queryByText('This checkout isn’t available on its Machine right now')).toBeUndefined();
      await act(async () => control.press('Open SQLite file'));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(pickWorkspaceFile).toHaveBeenCalledTimes(3);
    } finally { await fixture.dispose(); }
  });

  it('opens the selected table and Refresh reads its structure and rows once', async () => {
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
      const countReads = (action: string) => executeAction.mock.calls.filter(([call]) => call.action === action).length;
      const rows = databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1);
      const structure = databaseActionLocalIdV1(DATABASE_STRUCTURE_READ_ACTION_ID_V1);
      // The row leads with its key; on a narrow host the columns that drop still speak in a line under it.
      expect(await fixture.getByText('48212')).toBeTruthy();
      expect(await fixture.getByText('INV-2026-04812 · open')).toBeTruthy();
      expect([countReads(structure), countReads(rows)]).toEqual([1, 1]);
      await fixture.press(await fixture.getByRole('button', { name: 'Refresh' }));
      await settle(20);
      expect([countReads(structure), countReads(rows)]).toEqual([2, 2]);
    } finally {
      await fixture.dispose();
    }
  });
  it('opens a compact row without rendering its partial payload in the row summary', async () => {
    const payload = 'x'.repeat(1_000);
    const execute = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'partial-row', mountNonce: 'partial-row' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'data/public/invoices',
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: {
        pluginId: 'happier.database', localId: WORKBENCH_PAGE_VIEW_ID,
      }, container: 'appPage' }, target: { kind: 'app' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...connectionResourceHandlers(),
        async executeAction(request) {
          if (request.action !== databaseActionLocalIdV1(DATABASE_ROWS_READ_ACTION_ID_V1)) return execute(request);
          return projectNativeJsonValueForTransport({
            ok: true,
            operation: 'rows.read',
            result: {
              columns: [
                { name: 'id', nativeType: 'int8', semanticType: 'integer', nullable: false },
                { name: 'number', nativeType: 'text', semanticType: 'text', nullable: false },
                { name: 'status', nativeType: 'text', semanticType: 'text', nullable: false },
              ],
              rows: [{ cells: [
                { type: 'integer', value: '48212' },
                { type: 'text', value: 'INV-2026-04812' },
                { type: 'partial', valueType: 'text', value: payload, encoding: 'utf8',
                  range: { offset: 0, length: payload.length, total: payload.length + 1, unit: 'utf8_bytes' } },
              ] }],
              completeness: { complete: true },
            },
          });
        },
      },
    });
    try {
      const row = await fixture.findByRole('button', { name: '48212' });
      expect(document.body.textContent).not.toContain(payload);
      expect(await fixture.getByText('INV-2026-04812')).toBeTruthy();
      await fixture.press(row);
      await vi.waitFor(async () => expect(await fixture.getByText(`${payload}…`)).toBeTruthy());
    } finally { await fixture.dispose(); }
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
      surface: renderRail, launchInput: projectNativeJsonValueForTransport({ scope, descriptor, place: 'overview' }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-session-details' }, container: 'detailsTab' },
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
    const openSurface = vi.fn<NonNullable<PluginUiTestkitHostHandlers['openSurface']>>(async () => {});
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
        view: expect.objectContaining({ localId: 'database-session-details' }), instanceKey: expect.any(String),
        input: expect.objectContaining({ place: 'data/public/invoices', descriptor: expect.objectContaining({ label: 'billing_dev' }) }) }));
      expect(openSurface.mock.lastCall?.[0]).not.toHaveProperty('subPath');
    } finally { await fixture.dispose(); }
  });

  it('renders the details tab the rail opened, at its table', async () => {
    const executeAction = daemonAnswers([descriptor]);
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'details', mountNonce: 'details' }, authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail, launchInput: projectNativeJsonValueForTransport({ scope, descriptor, place: 'data/public/invoices' }),
      surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'database-session-details' }, container: 'detailsTab' },
        target: { kind: 'session', sessionId: 'session-1' } }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { ...connectionResourceHandlers(), executeAction },
    });
    try {
      await settle(20);
      expect(await fixture.getByText('48212')).toBeTruthy();
    } finally { await fixture.dispose(); }
  });
});
