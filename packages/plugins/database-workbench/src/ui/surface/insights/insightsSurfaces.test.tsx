// @vitest-environment jsdom

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_RESOURCE_REF_V1,
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1,
    DATABASE_SCHEMAS_LIST_ACTION_ID_V1,
    DATABASE_STATS_ENABLE_ACTION_ID_V1,
    DATABASE_STATS_READ_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import {
  DATABASE_INSIGHT_SOURCES_POINT_REF_V1,
  type DatabaseDescriptorV1,
  type DatabaseStatsObservationV1,
} from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { computeSha256HexDigest, PluginError } from '@happier-dev/plugin-sdk';
import { SessionInputHandoffInputV1Schema } from '@happier-dev/plugin-sdk/sessions';
import {
  createPluginUiActionControlTestHost,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkitExecuteActionInput,
  type PluginUiTestkitHostHandlers,
  type PluginUiTestkitSelectActionInputInput,
} from '@happier-dev/plugin-sdk/testing';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { PluginUiHostPresentationScope, type PluginUiPresentationHost } from '@happier-dev/plugin-ui/advanced';
import type { HostDatabaseLastLook } from '@happier-dev/plugin-ui/hostApi';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface as renderPage } from '../WorkbenchPage.js';
import { renderSurface as renderRail } from '../DatabaseRailTab.js';
import { WORKBENCH_PAGE_VIEW_ID } from '../views.js';
import { formatMoment } from './format.js';
import { statementByKey } from './statements.js';

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

function resourceHandlers(selected = descriptor) {
  const text = JSON.stringify({
    descriptor: selected,
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
  it('reads the selected Worktree database captures and likely N+1 on demand', async () => {
    const target = descriptor.target;
    if (target.kind !== 'worktree' || target.workspace.kind === 'managed') {
      throw new Error('Expected a local Worktree database');
    }
    const source = {
      kind: 'worktree', serverId: target.workspace.serverId, machineId: target.workspace.machineId,
      workspaceId: target.workspace.workspaceId, projectId: target.projectKey,
    } as const;
    const selected = {
      id: 'captured-lines', traceId: 'captured-request', worktree: 'selected-partition',
      kind: 'query', source: 'wire', shape: LINES, at: 1, durationMs: 3,
    } as const;
    const capture = vi.fn(async (request: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => {
      expect(request.input).toMatchObject({ source, databaseTarget: target });
      const action = typeof request.action === 'string' ? request.action : request.action.localId;
      switch (action) {
        case databaseActionLocalIdV1(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1):
          return { ok: true, source, items: [selected] };
        case databaseActionLocalIdV1(DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1):
          expect(request.input).toMatchObject({ id: selected.id });
          return { ok: true, source, detail: { sql: 'Masked statement detail' } };
        case databaseActionLocalIdV1(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1):
          expect(request.input).toMatchObject({ traceId: selected.traceId });
          return { ok: true, source, traceId: selected.traceId, summaries: [selected], slowChildSpans: [], logCorrelations: [],
            repeatedQueries: [{ traceId: selected.traceId, requestSpanId: 'request', shape: LINES,
              kind: 'suspected_n_plus_one', repetitionCount: 3, totalDatabaseTimeMs: 9,
              observationIds: [selected.id], callsites: [], explanation: 'Different parameter values within one request' }],
          };
        default:
          throw new Error(`Unexpected Capture Action ${action}`);
      }
    });
    const nativeRead = daemon(statements);
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'insights-capture', mountNonce: 'insights-capture' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: pageContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(),
        executeAction: request => typeof request.action !== 'string'
          && request.action.pluginId === DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId ? capture(request) : nativeRead(request),
        replacePageLocation: async ({ subPath }) => subPath,
      },
    });
    try {
      await settle();
      expect(capture).not.toHaveBeenCalled();
      const reads = (id: Parameters<typeof databaseActionLocalIdV1>[0]) => capture.mock.calls.filter(([request]) =>
        typeof request.action !== 'string' && request.action.localId === databaseActionLocalIdV1(id)).length;
      await page.press(await page.getByRole('tab', { name: 'Queries' }));
      await settle();
      expect(reads(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1)).toBe(1);
      expect(reads(DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1)).toBe(0);
      // The row leads its name with the statement, then where and when.
      const row = (await page.getAllByRole('button')).find(target => target.name?.startsWith(`${LINES}, `));
      if (!row) throw new Error('Expected the captured statement row');
      await page.press(row);
      await settle();
      expect(await page.queryByText('Masked statement detail')).toBeTruthy();
      expect(reads(DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1)).toBe(1);
      expect(reads(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1)).toBe(0);
      await page.press(await page.getByRole('button', { name: 'Inspect request' }));
      await settle();
      expect(await page.queryByText('Likely N+1')).toBeTruthy();
      expect(await page.queryByText('Different parameter values within one request')).toBeTruthy();
      expect(reads(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1)).toBe(1);
      expect(reads(DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1)).toBe(1);
    } finally {
      await page.dispose();
    }
  });

  it('opens the selected statement and its actions in the host details pane', async () => {
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'hosted-statement', mountNonce: 'hosted-statement' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: pageContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ detailsPane: { available: true } }),
      handlers: {
        ...resourceHandlers(),
        executeAction: daemon(statements),
        replacePageLocation: async ({ subPath }) => subPath,
      },
    });
    try {
      await settle();
      await act(async () => { await page.press(await page.getByRole('button', { name: SLOW })); });
      expect(await page.getByRole('group', { name: 'Details pane' })).toBeTruthy();
      expect(await page.getByRole('button', { name: 'Check for index suggestions' })).toBeTruthy();
      expect(await page.getByRole('button', { name: 'Prepare brief' })).toBeTruthy();
    } finally {
      await page.dispose();
    }
  });

  it('keeps current statements visible when Last Look cannot compare the samples', async () => {
    const presentationHost: PluginUiPresentationHost = {
      renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
      databaseWorkbench: {
        activityResource: () => { throw new Error('Statements must not acquire Activity'); },
        lastLook: () => ({
          observe: () => ({ comparison: { status: 'unavailable', reason: 'comparison_unavailable' }, persistenceError: null }),
        }),
      },
    };
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'incomparable-statements', mountNonce: 'incomparable-statements' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={presentationHost}>{renderPage(context)}</PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: { ...pageContext(), accountScope: { serverId: scope.workspace.serverId, accountId: scope.accountId } },
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(), replacePageLocation: async ({ subPath }) => subPath,
        executeAction: daemon(statements),
      },
    });
    try {
      await settle();
      expect(await page.getByText(SLOW)).toBeTruthy();
      expect(await page.getByText('comparison unavailable for this sample')).toBeTruthy();
      expect(await page.queryByText('statistics restarted since your last look')).toBeUndefined();
    } finally { await page.dispose(); }
  });

  it('refreshes the selected Activity and shows its sample time in manual mode', async () => {
    const activityReads = vi.fn((): DatabaseStatsObservationV1 => ({
      v: 1, engineId: 'postgresql', observedAtMs: Date.parse('2026-11-17T14:05:00Z'),
      scope: { database: 'billing_dev' }, intervalBasis: { ...basis, selectionKey: 'activity' },
      status: 'available', group: 'activity', coverage: { status: 'complete' },
      completeness: { complete: true }, data: [],
    }));
    const nativeRead = daemon(statements);
    const activityRead = daemon(activityReads);
    const presentationHost: PluginUiPresentationHost = {
      renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
      databaseWorkbench: {
        useActivityRefreshIntervalMs: () => 0,
        activityResource: source => {
          let snapshot = { value: null as Awaited<ReturnType<typeof source.read>> | null, loading: true, error: null };
          const listeners = new Set<() => void>();
          return {
            getSnapshot: () => snapshot,
            subscribe: listener => {
              listeners.add(listener);
              return () => { listeners.delete(listener); };
            },
            refresh: async () => {
              const value = await source.read({ signal: new AbortController().signal });
              snapshot = { value, loading: false, error: null };
              for (const listener of listeners) listener();
            },
            retainAutoRefresh: () => () => {}, invalidate: () => {}, dispose: () => {},
          };
        },
        lastLook: () => ({
          observe: () => ({ comparison: { status: 'unavailable', reason: 'previous_sample_required' }, persistenceError: null }),
        }),
      },
    };
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'manual-activity', mountNonce: 'manual-activity' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={presentationHost}>{renderPage(context)}</PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: pageContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(), replacePageLocation: async ({ subPath }) => subPath,
        executeAction: call => JSON.stringify(call.input).includes('"group":"activity"')
          ? activityRead(call) : nativeRead(call),
      },
    });
    try {
      await settle();
      await page.press(await page.getByRole('tab', { name: 'Activity' }));
      await settle();
      expect(activityReads).not.toHaveBeenCalled();
      await page.press(await page.getByRole('button', { name: 'Refresh' }));
      await settle();
      expect(activityReads).toHaveBeenCalledTimes(1);
      expect(await page.getByText(`as of ${formatMoment(activityReads.mock.results[0].value.observedAtMs)}`)).toBeTruthy();
    } finally { await page.dispose(); }
  });

  it('loads native findings on demand and reads only the selected detail', async () => {
    const nativeRead = daemon(statements);
    const sample = statements();
    const observation = { v: 1, sourceRef: { pluginId: 'happier.database',
      localId: databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1) },
      sourceScope: { machineId: scope.workspace.machineId, serverId: scope.workspace.serverId },
      evidenceIdentity: 'observation-a', kind: 'statements',
      observedWindow: { fromMs: sample.observedAtMs, toMs: sample.observedAtMs },
      coverage: { status: 'complete' }, summary: { records: 2 } };
    const listId = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1);
    const readId = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1);
    const dismissId = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_DISMISS_ACTION_ID_V1);
    const dismissalKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const list = vi.fn(async (_call: PluginUiTestkitExecuteActionInput) => projectNativeJsonValueForTransport({ ok: true, observation, findings: [
      { recordKey: 'q-slow', summary: { records: 1, calls: '18420', totalTimeMs: 758904 } },
      { recordKey: 'q-lines', dismissalKey, summary: { records: 1, calls: '2100000', totalTimeMs: 441000 } },
    ] }));
    const dismiss = vi.fn(async (_call: PluginUiTestkitExecuteActionInput) => ({ ok: true }));
    const openAutomationEvent = vi.fn(async (_request: unknown) => {});
    const detail = vi.fn(async (_call: PluginUiTestkitExecuteActionInput) =>
      projectNativeJsonValueForTransport({ ok: true, finding: { ...observation, target: descriptor.target,
        normalizedShape: LINES, summary: { records: 1, calls: '2100000', totalTimeMs: 441000 },
        verification: { read: statementByKey('q-lines'), basis } } }));
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'native-findings', mountNonce: 'native-findings' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' }, surface: renderPage, subPath: 'insights',
      surfaceContext: pageContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      handlers: { ...resourceHandlers(), replacePageLocation: async ({ subPath }) => subPath, openAutomationEvent,
        executeAction: call => call.action === dismissId ? dismiss(call) : call.action === listId ? list(call)
          : call.action === readId ? detail(call) : nativeRead(call) },
    });
    try {
      await settle();
      expect(list).not.toHaveBeenCalled();
      expect(detail).not.toHaveBeenCalled();
      await page.press(await page.getByRole('tab', { name: 'Findings' }));
      await settle();
      expect(list).toHaveBeenCalledTimes(1);
      expect(detail).not.toHaveBeenCalled();
      await page.press(await page.getByRole('button', { name: '2,100,000 calls' }));
      await settle();
      expect(detail).toHaveBeenCalledTimes(1);
      expect(detail.mock.calls[0]?.[0].input).toMatchObject({
        target: descriptor.target, recordKey: 'q-lines', subscriptionId: expect.any(String),
      });
      expect(await page.queryByText(LINES)).toBeTruthy();
      const workflow = await page.findByRole('button', { name: 'Create workflow from finding' });
      await act(async () => { await page.press(workflow); });
      expect(detail).toHaveBeenCalledTimes(1);
      expect(openAutomationEvent.mock.lastCall?.[0]).toMatchObject({
        request: { setupInput: { sourceScope: observation.sourceScope },
          initialFilter: { v: 1, all: [{ op: 'eq', field: '/observation/kind', value: 'statements' }] } },
      });
      await page.press(await page.getByRole('button', { name: 'Dismiss finding' }));
      await settle();
      expect(dismiss.mock.calls.map(([call]) => call.input)).toEqual([{ target: descriptor.target, dismissalKey }]);
      expect(await page.queryByRole('button', { name: '2,100,000 calls' })).toBeUndefined();
      expect(await page.getByRole('button', { name: '18,420 calls' })).toBeTruthy();
      expect(list).toHaveBeenCalledTimes(1);
      async function chooseEvidence(label: string) {
        await page.press(await page.getByRole('radio', { name: label }));
        await settle();
      }
      await chooseEvidence('Tables');
      expect(list.mock.lastCall?.[0].input).toMatchObject({ request: {
        kind: 'stats.read', group: 'tables', selection: { schema: 'public', page: { offset: 0 } },
      } });
      await chooseEvidence('Indexes');
      expect(list.mock.lastCall?.[0].input).toMatchObject({ request: {
        kind: 'stats.read', group: 'indexes', selection: { schema: 'public', page: { offset: 0 } },
      } });
      expect(list).toHaveBeenCalledTimes(3);
      expect(detail).toHaveBeenCalledTimes(1);
    } finally {
      await page.dispose();
    }
  });
  it.each(['live', 'unsupported', 'transient', 'delayed', 'withdrawn'] as const)('reads only the selected insight source with a %s watch and drops a disabled occurrence', async watchKind => {
    const { pointId, protocol, pluginId } = DATABASE_INSIGHT_SOURCES_POINT_REF_V1;
    const contributorPluginId = 'acme.database-observations';
    const sourceRef = { pluginId: contributorPluginId, localId: 'findings' };
    const current = pageContext();
    const target = { pluginId, occurrenceId: 'target-a',
      sourceCustody: { kind: 'development' as const, registeredRootId: 'target-root' } };
    const presentSource = (occurrenceId: string) => {
      const contributor = { pluginId: contributorPluginId, contributionId: sourceRef.localId, occurrenceId,
        sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } };
      const operations = ['list', 'detail'].map(role => ({ role, point: { pointId, protocol }, contributor,
        action: { pluginId: contributorPluginId, localId: role } }));
      return { ...current, targetedContributions: { target, points: [{ pointId, protocols: [{ protocol, contributions: [{
        contributor, protocol, operations, surfaces: [], descriptor: {
          displayName: 'Database observations', evidenceSchema: { type: 'object' as const },
          targetKinds: ['worktree'], engineIds: ['postgresql'],
          changeResourceRef: { pluginId: contributorPluginId, localId: 'changes' },
        },
      }, {
        contributor: { ...contributor, contributionId: 'other-db' }, protocol, operations: operations.map(operation => ({
          ...operation, contributor: { ...contributor, contributionId: 'other-db' },
        })), surfaces: [], descriptor: {
          displayName: 'MySQL observations', evidenceSchema: { type: 'object' as const },
          targetKinds: ['worktree'], engineIds: ['mysql'],
          changeResourceRef: { pluginId: contributorPluginId, localId: 'changes' },
        },
      }] }] }] } };
    };
    const pick = vi.fn(async ({ request }: PluginUiTestkitSelectActionInputInput) => {
      if (!('operation' in request) || !request.draft) throw new Error('expected a scoped source Action');
      const { operation } = request;
      return { kind: 'submitted' as const, action: operation.action, input: request.draft,
        selection: { target: { pluginId, sourceCustody: target.sourceCustody }, point: operation.point, contributor: {
          pluginId: operation.contributor.pluginId, contributionId: operation.contributor.contributionId,
          sourceCustody: operation.contributor.sourceCustody,
        } }, connectedAccount: { kind: 'none' as const }, presentation: { connectedAccountLabel: null, machineDisplayName: null } };
    });
    const observation = {
      v: 1, sourceRef, sourceScope: { serverId: scope.workspace.serverId, machineId: scope.workspace.machineId },
      evidenceIdentity: 'source-observation', kind: 'suspected_n_plus_one', observedWindow: { fromMs: 1, toMs: 2 },
      coverage: { status: 'complete' }, summary: { records: 1 },
    };
    let findingTitle = 'Repeated query';
    const sourceRead = vi.fn(async (call: PluginUiTestkitExecuteActionInput) => {
      expect(call.selectedActionInput?.operation.action).toEqual({
        pluginId: contributorPluginId, localId: call.selectedActionInput?.operation.role,
      });
      if (call.selectedActionInput?.operation.role === 'detail') {
        return projectNativeJsonValueForTransport({ ok: true, finding: {
          ...observation, title: 'Repeated query', normalizedShape: LINES,
          exercise: 'Open the project reports page once.',
        } });
      }
      return projectNativeJsonValueForTransport({
        ok: true, findings: [{ recordKey: 'n-plus-one-17', title: findingTitle, summary: { records: 17 } }],
      });
    });
    const prepare = vi.fn(async (_call: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => ({
      ok: true, brief: { text: 'Investigate repeated queries.', evidence: { v: 1, items: [{
        source: { kind: 'databaseFinding', label: 'Repeated query' }, author: { kind: 'process' }, text: 'Source evidence',
      }] } },
    }));
    const handoff = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => ({
      ok: true, result: { kind: 'composed', destination: { kind: 'newSessionDraft' } },
    }));
    const actionControl = createPluginUiActionControlTestHost(handoff);
    const nativeRead = daemon(statements);
    const delayedOpen = Promise.withResolvers<{ digest: string }>();
    let deferred = false;
    const sourceWatches = vi.fn<NonNullable<NonNullable<Parameters<typeof createPluginUiTestkit>[0]['handlers']>['watchResource']>>(async ({ resource }) => {
      if (typeof resource === 'object' && 'pluginId' in resource && resource.pluginId === contributorPluginId && (watchKind === 'delayed' || watchKind === 'withdrawn') && !deferred) {
        deferred = true;
        return delayedOpen.promise;
      }
      if (typeof resource === 'object' && 'pluginId' in resource && resource.pluginId === contributorPluginId && (watchKind === 'unsupported' || watchKind === 'transient')) {
        throw new PluginError({ code: watchKind === 'unsupported' ? 'unsupported_method' : 'plugin_resource_transport_unavailable' });
      }
      return { digest: `sha256:${'a'.repeat(64)}` };
    });
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'insight-source', mountNonce: 'insight-source' },
      authorPlugin: { id: pluginId, version: '0.0.0' }, surface: renderPage, subPath: 'insights',
      surfaceContext: presentSource('source-a'), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      handlers: { ...resourceHandlers(), selectActionInput: pick, actionControl: actionControl.handler,
        watchResource: sourceWatches,
        replacePageLocation: async ({ subPath }) => subPath,
        executeAction: call => typeof call.action === 'object' && call.action.pluginId === pluginId && call.action.localId === 'insights/sources/read'
          ? sourceRead(call) : call.action === databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1)
            ? prepare(call) : nativeRead(call) },
    });
    try {
      await settle();
      expect(pick).not.toHaveBeenCalled();
      await page.press(await page.getByRole('tab', { name: 'Insight sources' }));
      expect(pick).not.toHaveBeenCalled();
      expect(await page.queryByRole('button', { name: 'MySQL observations' })).toBeUndefined();
      await page.press(await page.getByRole('button', { name: 'Database observations' }));
      await settle();
      const selectedList = pick.mock.results.at(-1)?.value;
      expect(selectedList).toBeDefined();
      expect(sourceRead.mock.calls[0]?.[0].input).toEqual({
        target: descriptor.target, role: 'list', sourceSelection: (await selectedList)?.selection,
      });
      expect(sourceWatches.mock.calls.some(([call]) => typeof call.resource === 'object'
        && 'pluginId' in call.resource && call.resource.pluginId === contributorPluginId && call.resource.localId === 'changes')).toBe(true);
      expect(sourceWatches.mock.calls.find(([call]) => typeof call.resource === 'object'
        && 'pluginId' in call.resource && call.resource.pluginId === contributorPluginId && call.resource.localId === 'changes')?.[0]).toMatchObject({
          input: { target: descriptor.target }, selectedActionInput: sourceRead.mock.calls[0]?.[0].selectedActionInput,
        });
      if (watchKind === 'withdrawn') {
        expect(await page.getByRole('button', { name: findingTitle })).toBeTruthy();
        delayedOpen.reject(new PluginError({ code: 'unavailable',
          diagnostics: [{ code: 'plugin_generation_stale', severity: 'error' }] }));
        await settle();
        expect(await page.getByText('The source could not be read')).toBeTruthy();
        expect(await page.queryByRole('button', { name: findingTitle })).toBeUndefined();
        expect(await page.queryByRole('button', { name: 'Try again' })).toBeUndefined();
        return;
      }
      if (watchKind === 'delayed') {
        findingTitle = 'Changed before observing';
        delayedOpen.resolve({ digest: `sha256:${'b'.repeat(64)}` });
        await settle();
        expect(await page.queryByRole('button', { name: findingTitle })).toBeTruthy();
      }
      await page.press(await page.getByRole('button', { name: findingTitle }));
      await settle();
      const selectedDetail = await pick.mock.results.at(-1)?.value;
      expect(sourceRead.mock.calls.find(([call]) => call.selectedActionInput?.operation.role === 'detail')?.[0].input).toEqual({
        target: descriptor.target, role: 'detail', recordKey: 'n-plus-one-17', sourceSelection: selectedDetail?.selection,
      });
      for (const [call] of sourceRead.mock.calls) expect(call.selectedActionInput?.result.input).toEqual({
        target: descriptor.target, ...(call.selectedActionInput?.operation.role === 'detail' ? { recordKey: 'n-plus-one-17' } : {}),
      });
      expect(await page.queryByText(LINES)).toBeTruthy();
      await page.press(await page.getByRole('button', { name: 'Prepare brief' }));
      await settle();
      expect(prepare.mock.lastCall?.[0].input).toEqual({ target: descriptor.target, recordKey: 'n-plus-one-17',
        sourceSelection: { target: { pluginId, sourceCustody: target.sourceCustody }, point: { pointId, protocol }, contributor: {
          pluginId: contributorPluginId, contributionId: sourceRef.localId, sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
        } } });
      expect(await page.getByText('Investigate repeated queries.')).toBeTruthy();
      await act(async () => { await actionControl.press('Ask for investigation'); });
      expect(handoff).toHaveBeenCalledWith(expect.objectContaining({ action: 'session.input.handoff',
        input: expect.objectContaining({ delivery: 'compose', input: expect.objectContaining({ forgeEvidence: {
          v: 1, items: [{ source: { kind: 'databaseFinding', label: 'Repeated query' }, author: { kind: 'process' }, text: 'Source evidence' }],
        } }) }),
      }));

      const selections = pick.mock.calls.length;
      const readsBefore = sourceRead.mock.calls.length;
      if (watchKind === 'live' || watchKind === 'delayed') {
        await act(async () => { page.invalidateResource({ pluginId: contributorPluginId, localId: 'changes' }, `sha256:${'b'.repeat(64)}`); });
      } else {
        await page.press(await page.getByRole('button', { name: 'Refresh' }));
      }
      await settle();
      const reads = readsBefore + (watchKind === 'live' || watchKind === 'delayed' ? 2 : 1);
      expect(sourceRead).toHaveBeenCalledTimes(reads);
      expect(pick).toHaveBeenCalledTimes(selections);
      await act(async () => { await page.updateSurface({ ...current, targetedContributions: { target, points: [] } }); });
      expect(await page.queryByRole('tab', { name: 'Insight sources' })).toBeUndefined();
      expect(await page.queryByText('Repeated query')).toBeUndefined();
      if (watchKind === 'live' || watchKind === 'delayed') expect(sourceWatches.mock.calls.filter(([call]) => typeof call.resource === 'object'
        && 'pluginId' in call.resource && call.resource.localId === 'changes').every(([call]) => call.signal.aborted)).toBe(true);
      await act(async () => { page.invalidateResource({ pluginId: contributorPluginId, localId: 'changes' }, `sha256:${'c'.repeat(64)}`); });
      await settle();
      expect(sourceRead).toHaveBeenCalledTimes(reads);
      expect(pick).toHaveBeenCalledTimes(selections);
      await act(async () => { await page.updateSurface(presentSource('source-b')); });
      await settle();
      expect(sourceRead).toHaveBeenCalledTimes(reads);
      await page.press(await page.getByRole('tab', { name: 'Insight sources' }));
      await page.press(await page.getByRole('button', { name: 'Database observations' }));
      await settle();
      expect(sourceRead.mock.calls.at(-1)?.[0].selectedActionInput?.operation.contributor.occurrenceId).toBe('source-b');
    } finally {
      await page.dispose();
    }
  });

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

  it('shows the latest vacuum for automatically maintained PostgreSQL tables', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1440);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    const now = Date.now();
    const snapshot: DatabaseStatsObservationV1 = {
      v: 1, observedAtMs: now, engineId: 'postgresql', scope: { database: 'billing_dev' },
      intervalBasis: basis, status: 'available', group: 'tables',
      coverage: { status: 'complete' }, completeness: { complete: true },
      data: [
        { relation: { schema: 'public', name: 'invoices' }, lastAutovacuum: new Date(now - 120_000).toISOString() },
        { relation: { schema: 'public', name: 'invoice_lines' }, lastVacuum: new Date(now - 600_000).toISOString(),
          lastAutovacuum: new Date(now - 180_000).toISOString() },
      ],
    };
    const execute = daemon(statements);
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'vacuum', mountNonce: 'vacuum' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderPage,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor }),
      subPath: 'insights',
      surfaceContext: pageContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(),
        executeAction: request => request.action === databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1)
          && (request.input as { request?: { group?: string } }).request?.group === 'tables'
          ? projectNativeJsonValueForTransport({ ok: true, operation: 'stats.read', observation: snapshot })
          : execute(request),
        replacePageLocation: async ({ subPath }) => subPath,
      },
    });
    try {
      await settle();
      await page.press(await page.getByRole('tab', { name: 'Tables and indexes' }));
      await settle();
      expect(await page.queryByText('invoices')).toBeTruthy();
      expect(await page.queryByText('2 min ago')).toBeTruthy();
      expect(await page.queryByText('3 min ago')).toBeTruthy();
    } finally {
      await page.dispose();
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('shows the one diagnosed setup state with the producer’s setting when statement statistics are off', async () => {
    const writeClipboard = vi.fn(async () => undefined);
    const handoff = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => ({
      ok: true, result: { kind: 'composed', destination: { kind: 'newSessionDraft' } },
    }));
    const actionControl = createPluginUiActionControlTestHost(handoff);
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
        actionControl: actionControl.handler,
        replacePageLocation: async ({ subPath }) => subPath,
        writeClipboard,
      },
    });
    try {
      await settle();
      expect(
        await page.queryByText('See which statements cost the most'),
      ).toBeTruthy();
      // Add telemetry is the lab's handoff row (glyph, purpose line, disclosure), not a bare title;
      // Ask an agent… carries the agent glyph (lab dbInsights/notEnabled).
      expect(actionControl.presentation('Add telemetry to this app')).toMatchObject({
        description: 'Prepares a session that sets up OpenTelemetry, so each request’s queries show here.',
        icon: 'pulse', disclosure: true,
      });
      expect(actionControl.presentation('Ask an agent…')).toMatchObject({ icon: 'generate' });
      // The setting travels by Copy (lab dbInsights/notEnabled); the page does not print it.
      await page.press(await page.getByRole('button', { name: 'Copy the setting' }));
      expect(writeClipboard).toHaveBeenCalledWith(expect.objectContaining({
        value: "shared_preload_libraries = 'pg_stat_statements'",
      }));
      for (const [title, task] of [
        ['Ask an agent…', { kind: 'enable_pg_stat_statements', target: descriptor.target, stats: { reason: 'extension_missing' } }],
        ['Add telemetry to this app', { kind: 'add_telemetry', scope }],
      ] as const) {
        await act(async () => actionControl.press(title));
        const call = handoff.mock.calls.at(-1);
        expect(call).toBeDefined();
        expect(call?.[0]).toMatchObject({ action: 'session.input.handoff', input: {
          delivery: 'compose', sessionChoice: { kind: 'new' },
          input: { forgeEvidence: { items: [{ source: { kind: 'databaseFinding' } }] } },
        } });
        const input = SessionInputHandoffInputV1Schema.parse(call?.[0].input);
        expect(input.newSession).toEqual({
          kind: 'new', seed: { placement: {
            kind: 'exactTarget', serverId: scope.workspace.serverId,
            machineId: scope.workspace.machineId, directory: scope.workspace.rootPath,
          } },
        });
        expect(JSON.parse(input.input.forgeEvidence!.items[0]!.text)).toMatchObject({ task: { ...task,
          sourceScope: { serverId: scope.workspace.serverId, machineId: scope.workspace.machineId },
        } });
      }
    } finally {
      await page.dispose();
    }
  });

  it.each(['deployment_service', 'managed_deployment', 'manual'] as const)('enables statistics on the reviewed %s and rereads once', async kind => {
    const environment = { serverId: 'home', environmentId: 'prod', projectSourceId: 'billing' };
    const selected: DatabaseDescriptorV1 = {
      ...descriptor,
      target: kind === 'deployment_service'
        ? { kind, environment, deploymentId: 'deploy', targetLinkId: 'link', serviceId: 'db', database: 'billing' }
        : kind === 'managed_deployment'
          ? { kind, environment, targetLinkId: 'link', contribution: { pluginId: 'fixture.provider', contributionId: 'postgres' },
              platformProjectId: 'billing', branchId: 'production', database: 'billing' }
          : { ...scope, kind, savedSecretId: 'fixture' },
      capabilities: [{ operation: 'stats.enable', available: true }],
      access: { canRead: true, canWrite: true },
    };
    let installed = false;
    const executeAction = daemon(() => installed ? statements() : extensionMissing);
    const enable = vi.fn(async () => {
      installed = true;
      return { ok: true as const, result: { ok: true, operation: 'stats.enable', status: 'enabled' } };
    });
    const actionControl = createPluginUiActionControlTestHost(enable);
    const resource = resourceHandlers(selected);
    const watchResource = vi.fn(resource.watchResource);
    const renderActionControl = vi.fn<NonNullable<PluginUiPresentationHost['renderActionControl']>>(() => null);
    const page = await createPluginUiTestkit({
      identity: { instanceId: 'enable', mountNonce: 'enable' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: (context: Parameters<typeof renderPage>[0]) => (
        <PluginUiHostPresentationScope
          environment={projectHappierUiEnvironment(context.surface)}
          presentationHost={{
            renderActionControl,
            renderCodeBlock: () => null,
            renderIcon: () => null,
            renderMarkdown: () => null,
            renderPopover: () => null,
          }}
        >
          {renderPage(context)}
        </PluginUiHostPresentationScope>
      ),
      launchInput: projectNativeJsonValueForTransport({
        scope: kind === 'manual' ? scope : { kind: 'environment', environment },
        descriptor: selected,
      }),
      subPath: 'insights',
      surfaceContext: pageContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...resource, watchResource, executeAction, actionControl: actionControl.handler },
    });
    const statementsReads = () => executeAction.mock.calls.filter(([call]) => call.action === databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1));
    try {
      await settle();
      expect(statementsReads()).toHaveLength(1);
      expect(watchResource).toHaveBeenCalledTimes(1);
      expect(enable).not.toHaveBeenCalled();
      expect(renderActionControl).toHaveBeenCalledWith(expect.objectContaining({
        presentation: expect.objectContaining({ title: 'Enable statistics' }),
        reviewedInput: undefined,
      }));
      await act(async () => actionControl.press('Enable statistics'));
      await settle();
      expect(enable).toHaveBeenCalledOnce();
      expect(enable).toHaveBeenCalledWith(expect.objectContaining({
        action: databaseActionLocalIdV1(DATABASE_STATS_ENABLE_ACTION_ID_V1),
        input: { operation: 'stats.enable', target: selected.target },
      }));
      expect(await page.getByText(SLOW)).toBeTruthy();
      expect(statementsReads()).toHaveLength(2);
      expect(watchResource).toHaveBeenCalledTimes(2);
    } finally { await page.dispose(); }
  });

  it('prepares a telemetry setup draft from an empty worktree Insights rail', async () => {
    const handoff = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => ({
      ok: true, result: { kind: 'composed', destination: { kind: 'newSessionDraft' } },
    }));
    const actionControl = createPluginUiActionControlTestHost(handoff);
    const rail = await createPluginUiTestkit({
      identity: { instanceId: 'empty-insights', mountNonce: 'empty-insights' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({
        mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'insights-session-rail' },
          container: 'rightSidebarTab' },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        ...resourceHandlers(),
        actionControl: actionControl.handler,
        executeAction: async () => ({ targets: [], completeness: { complete: true } }),
      },
    });
    try {
      await settle();
      await act(async () => actionControl.press('Add telemetry to this app'));
      const input = SessionInputHandoffInputV1Schema.parse(handoff.mock.calls[0]?.[0].input);
      expect(input.delivery).toBe('compose');
      expect(input.sessionChoice).toEqual({ kind: 'new' });
      expect(input.newSession).toEqual({
        kind: 'new', seed: { placement: {
          kind: 'exactTarget', serverId: scope.workspace.serverId,
          machineId: scope.workspace.machineId, directory: scope.workspace.rootPath,
        } },
      });
      expect(JSON.parse(input.input.forgeEvidence!.items[0]!.text)).toMatchObject({ task: { kind: 'add_telemetry', scope } });
    } finally {
      await rail.dispose();
    }
  });

  it('records only the shown rail statements and opens the selected details tab', async () => {
    const openSurface = vi.fn<NonNullable<PluginUiTestkitHostHandlers['openSurface']>>(async () => {});
    const observe = vi.fn<HostDatabaseLastLook['observe']>(() => ({
      comparison: { status: 'unavailable', reason: 'previous_sample_required' }, persistenceError: null,
    }));
    const presentationHost: PluginUiPresentationHost = {
      renderCodeBlock: () => null, renderIcon: () => null, renderMarkdown: () => null, renderPopover: () => null,
      databaseWorkbench: {
        activityResource: () => { throw new Error('An Insights rail must not acquire Activity'); },
        lastLook: () => ({ observe }),
      },
    };
    const sample = statements();
    if (sample.status !== 'available' || sample.group !== 'statements') throw new Error('Expected the ranked statements fixture');
    const lowerRanked = Array.from({ length: 7 }, (_, index) => ({ ...sample.data[1]!,
      key: `q-lower-${index + 1}`, shape: `select * from lower_ranked_${index + 1}` }));
    sample.data.push(...lowerRanked);
    const executeAction = daemon(() => sample);
    const rail = await createPluginUiTestkit({
      identity: { instanceId: 'rail', mountNonce: 'rail' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: context => <PluginUiHostPresentationScope environment={projectHappierUiEnvironment(context.surface)}
        presentationHost={presentationHost}>{renderRail(context)}</PluginUiHostPresentationScope>,
      launchInput: projectNativeJsonValueForTransport({ scope }),
      surfaceContext: createSurfaceContextFixture({
        accountScope: { serverId: scope.workspace.serverId, accountId: scope.accountId },
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
        executeAction,
        openSurface,
      },
    });
    try {
      await settle();
      expect(await rail.queryByText(SLOW)).toBeTruthy();
      // Controls in order: the database picker, the ranked statements (costliest first), then Refresh.
      const controls = await rail.getAllByRole('button');
      expect(controls).toHaveLength(10);
      expect(observe.mock.calls.map(([, shownKeys]) => shownKeys)).toEqual([
        ['q-slow', 'q-lines', ...lowerRanked.slice(0, -1).map(row => row.key)],
      ]);
      expect(executeAction.mock.calls.filter(([call]) => call.action === databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1)))
        .toHaveLength(1);
      await act(async () => {
        await rail.press(controls[1]!);
      });
      expect(openSurface).toHaveBeenCalledWith(
        expect.objectContaining({
          view: expect.objectContaining({
            localId: 'insights-session-details',
          }),
          input: expect.objectContaining({ place: 'q-slow' }),
          instanceKey: expect.any(String),
        }),
      );
      expect(openSurface.mock.lastCall?.[0]).not.toHaveProperty('subPath');
    } finally {
      await rail.dispose();
    }
  });

  it('reads index suggestions only on demand and retries without losing the statement detail', async () => {
    const normalStats = daemon(statements);
    let adviceReads = 0;
    const executeAction = vi.fn(async (call: PluginUiTestkitExecuteActionInput) => {
      const input = call.input;
      if (!input || typeof input !== 'object' || !('request' in input)
        || !(input.request && typeof input.request === 'object' && 'group' in input.request)
        || input.request.group !== 'indexAdvice') {
        return normalStats(call);
      }
      expect(input).toMatchObject({ target: descriptor.target,
        request: { group: 'indexAdvice', selection: { statementKey: 'q-slow' } } });
      expect(input).not.toHaveProperty('subscriptionId');
      adviceReads++;
      return projectNativeJsonValueForTransport({ ok: true, operation: 'stats.read',
        observation: { v: 1, observedAtMs: 1, engineId: 'postgresql', scope: { database: 'billing_dev' },
          intervalBasis: basis, group: 'indexAdvice', ...(adviceReads === 1
            ? { status: 'unavailable', reason: 'hypopg_missing' }
            : { status: 'available', coverage: { status: 'complete' }, completeness: { complete: true },
                data: [{ relation: { schema: 'public', name: 'invoice' }, column: 'buyer_id',
                  baselineCost: 250, candidateCost: 12.5 }] }) } });
    });
    const details = await createPluginUiTestkit({
      identity: { instanceId: 'details', mountNonce: 'details' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor, place: 'q-slow' }),
      surfaceContext: createSurfaceContextFixture({
        mount: {
          kind: 'destination',
          destination: {
            pluginId: 'happier.database',
            localId: 'insights-session-details',
          },
          container: 'detailsTab',
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
      expect(await details.queryByRole('group', {
        name: 'Read from memory: 99.2%, of the blocks it read',
      })).toBeTruthy();
      expect(adviceReads).toBe(0);
      const check = await details.queryByRole('button', { name: 'Check for index suggestions' });
      expect(check).toBeTruthy();
      await act(async () => { await details.press(check!); });
      expect(adviceReads).toBe(1);
      expect(await details.queryByRole('button', { name: 'Open in Console' })).toBeTruthy();
      const retry = await details.queryByRole('button', { name: 'Retry' });
      expect(retry).toBeTruthy();
      await act(async () => { await details.press(retry!); });
      expect(adviceReads).toBe(2);
      expect(await details.queryByRole('group', { name: 'Estimated cost before: 250' })).toBeTruthy();
      expect(await details.queryByRole('group', { name: 'Estimated cost after: 12.5' })).toBeTruthy();
      const beforeCost = document.querySelector('[role="group"][aria-label="Estimated cost before: 250"]');
      const afterCost = document.querySelector('[role="group"][aria-label="Estimated cost after: 12.5"]');
      expect(beforeCost?.textContent).toContain('Estimated cost before');
      expect(afterCost?.textContent).toContain('Estimated cost after');
    } finally {
      await details.dispose();
    }
    expect(adviceReads).toBe(2);
  });

  it('prepares the selected finding once before handing its editable brief to the Session Composer', async () => {
    const readId = databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_READ_ACTION_ID_V1);
    const buildId = databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1);
    const baseline = {
      v: 1,
      sourceRef: { pluginId: 'happier.database', localId: databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1) },
      sourceScope: { serverId: scope.workspace.serverId, machineId: scope.workspace.machineId },
      evidenceIdentity: 'statement-evidence',
      kind: 'statements',
      observedWindow: { fromMs: 1, toMs: 1 },
      coverage: { status: 'complete' },
      summary: { records: 1, calls: '18420' },
    };
    const nativeRead = daemon(statements);
    const executeAction = vi.fn(async (call: PluginUiTestkitExecuteActionInput) => {
      if (call.action === readId) {
        return projectNativeJsonValueForTransport({ ok: true, finding: {
          ...baseline, target: descriptor.target, normalizedShape: SLOW,
          verification: { read: statementByKey('q-slow'), basis },
        } });
      }
      if (call.action === buildId) {
        return projectNativeJsonValueForTransport({ ok: true, brief: {
          text: 'Investigate the selected statement',
          evidence: { v: 1, items: [{ source: { kind: 'databaseFinding', label: 'Statement' }, author: { kind: 'process' }, text: JSON.stringify(baseline) }] },
        } });
      }
      return nativeRead(call);
    });
    const handoff = vi.fn<Parameters<typeof createPluginUiActionControlTestHost>[0]>(async () => ({
      ok: true, result: { kind: 'composed', destination: { kind: 'newSessionDraft' } },
    }));
    const actionControl = createPluginUiActionControlTestHost(handoff);
    const openSurface = vi.fn(async () => {});
    const openAutomationEvent = vi.fn(async (_request: unknown) => {});
    const details = await createPluginUiTestkit({
      identity: { instanceId: 'finding', mountNonce: 'finding' },
      authorPlugin: { id: 'happier.database', version: '0.0.0' },
      surface: renderRail,
      launchInput: projectNativeJsonValueForTransport({ scope, descriptor, place: 'q-slow' }),
      surfaceContext: createSurfaceContextFixture({
        mount: { kind: 'destination', destination: { pluginId: 'happier.database', localId: 'insights-session-details' }, container: 'detailsTab' },
        target: { kind: 'session', sessionId: 'session-1' },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { ...resourceHandlers(), executeAction, actionControl: actionControl.handler, openSurface, openAutomationEvent },
    });
    function findingCalls() {
      return executeAction.mock.calls.map(([call]) => call).filter(call => call.action === readId || call.action === buildId);
    }
    try {
      await settle();
      expect(findingCalls()).toHaveLength(0);
      await act(async () => { await details.press(await details.getByRole('button', { name: 'Prepare brief' })); });
      await settle();
      expect(findingCalls()).toMatchObject([
        { action: buildId, input: { target: descriptor.target, recordKey: 'q-slow' } },
      ]);
      expect(await details.getByText('Investigate the selected statement')).toBeTruthy();
      const workflow = await details.findByRole('button', { name: 'Create workflow from finding' });
      await act(async () => { await details.press(workflow); });
      expect(findingCalls().at(-1)).toMatchObject({ action: readId, input: { target: descriptor.target, recordKey: 'q-slow' } });
      expect(openAutomationEvent.mock.lastCall?.[0]).toMatchObject({
        request: {
          eventRef: { pluginId: 'happier.database', localId: 'finding-observed' },
          monitoringMachineId: scope.workspace.machineId,
          setupInput: { sourceScope: baseline.sourceScope },
          initialFilter: { v: 1, all: [{ op: 'eq', field: '/observation/kind', value: 'statements' }] },
        },
      });
      expect(handoff).not.toHaveBeenCalled();
      await act(async () => { await actionControl.press('Send brief'); });
      expect(handoff).toHaveBeenCalledOnce();
      expect(handoff).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'session.input.handoff',
        input: expect.objectContaining({ delivery: 'compose', sessionChoice: expect.objectContaining({ kind: 'existing' }) }),
      }));
      await act(async () => { await actionControl.press('Ask for investigation'); });
      expect(handoff).toHaveBeenCalledTimes(2);
      const newDraft = SessionInputHandoffInputV1Schema.parse(handoff.mock.lastCall?.[0].input);
      expect(newDraft.newSession).toEqual({
        kind: 'new', seed: { placement: {
          kind: 'exactTarget', serverId: scope.workspace.serverId,
          machineId: scope.workspace.machineId, directory: scope.workspace.rootPath,
        } },
      });
      expect(handoff).toHaveBeenLastCalledWith(expect.objectContaining({
        action: 'session.input.handoff',
        input: expect.objectContaining({ delivery: 'compose', sessionChoice: { kind: 'new' },
          input: expect.objectContaining({ text: 'Investigate the selected statement', forgeEvidence: expect.any(Object) }) }),
      }));
      await act(async () => { await details.press(await details.getByRole('button', { name: 'Open in Console' })); });
      expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
        view: expect.objectContaining({ localId: WORKBENCH_PAGE_VIEW_ID }), subPath: expect.stringContaining('console'),
      }));
    } finally {
      await details.dispose();
    }
  });
});
