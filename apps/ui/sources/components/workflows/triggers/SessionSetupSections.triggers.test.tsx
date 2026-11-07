import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeWorkflowIngress} from '@happier-dev/protocol/workflows/workflowValidationV1';
import {
  AutomationDefinitionCreateRequestSchema,
  AutomationDefinitionDetailSchema,
  AutomationDefinitionDetailsRequestSchema,
  AutomationDefinitionDetailsResponseSchema,
  AutomationDefinitionListResponseSchema,
  AutomationDefinitionReconcileRequestSchema,
  type AutomationDefinitionDetail} from '@happier-dev/protocol/automations/automationApiV3';
import {
  AutomationStoredWorkflowDefinitionRecipeV2Schema,
  AutomationStoredWorkflowDefinitionV2Schema} from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import {
  WorkflowTriggerSetV1Schema,
  type WorkflowTriggerSetV1,
} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import {
  WorkflowRunAutomationSummariesRequestV1Schema,
  WorkflowRunAutomationSummariesResultV1Schema} from '@happier-dev/protocol/workflows/actionsV1';

import { createDeferred, createSessionFixture, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getStorage } from '@/sync/domains/state/storage';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { ItemList } from '@/components/ui/lists/ItemList';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';
import { SessionInfoSectionSummaryProvider, useSessionInfoSectionSummaryHost } from '@/components/sessions/info/sessionInfoSectionSummaries';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { countStoreNotifications, countTransportRequests } from '@/dev/testkit/performance/counts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routeParams = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
// The route is a boundary: "When this turn finishes…" arrives as deep-link params.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock({ params: {} });
  return {
    ...mock.module,
    useLocalSearchParams: () => routeParams.current,
    useGlobalSearchParams: () => routeParams.current,
  };
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

// Account discovery observes an authenticated, connected Home; Socket.IO is the boundary.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
  .createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);

const { SessionHabitsSection, SessionSetupSections } =
  await import('@/components/sessions/work/SessionSetupSections');

/** The Session's Info host of its Setup and Habits sections (lab csinfo I2). */
function SessionInfoSetup(props: Readonly<{ sessionId: string; onHabitRender?: React.ProfilerOnRenderCallback }>) {
  const session = useSessionViewShellSession(props.sessionId, home.serverId);
  const habits = session ? <SessionHabitsSection sessionId={session.id} serverId={home.serverId} /> : null;
  return <InjectedAuthProvider credentials={workflowHttp?.credentials ?? null}><UniversalSearchRuntimeProvider value={searchRuntime}>
    <AppPaneProvider><ItemList>{session ? <SessionSetupSections session={session} serverId={home.serverId} /> : null}
      {props.onHabitRender ? <React.Profiler id="habits-arrival" onRender={props.onHabitRender}>{habits}</React.Profiler> : habits}
    </ItemList></AppPaneProvider>
  </UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}
const searchRuntime = { open: () => {}, buildCommands: () => [] };

function InfoHabitArrival(props: Readonly<{ onHabitRender?: React.ProfilerOnRenderCallback }>) {
  const scope = useActiveServerAccountScope(home.serverId);
  const summaries = useSessionInfoSectionSummaryHost({ address: { sessionId: 'session-1', serverId: home.serverId }, scope });
  return <SessionInfoSectionSummaryProvider value={summaries.host}>
    {/* Info keeps the read mounted when its complete empty summary folds it. */}
    <section hidden={summaries.facts.habits === 'empty'} data-testid="info-habits-arrival">
      <SessionInfoSetup sessionId="session-1" onHabitRender={props.onHabitRender} />
    </section>
  </SessionInfoSectionSummaryProvider>;
}

const inline = normalizeWorkflowIngress({
  version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
  blocks: ['Summarize overnight CI'],
});
if (inline.kind !== 'parsed')
  throw new Error('fixture definition must normalize');
const definition = inline.definition;

function lifecycleTrigger(id: string, enabled: boolean) {
  return {
    id,
    revision: 1,
    enabled,
    createdAt: 1,
    updatedAt: 1,
    kind: 'sessionLifecycle',
    triggerDefinitionEnvelope: null,
    sourceSessionId: 'session-1',
    events: ['parentTurnCompleted'],
    policy: { kind: 'everyMatch' },
    remainingOccurrences: null,
    status: { state: 'waiting', runId: null },
  };
}

function triggerSet(
  triggers: ReturnType<typeof lifecycleTrigger>[],
): WorkflowTriggerSetV1 {
  return WorkflowTriggerSetV1Schema.parse({
    automationId: 'set-1',
    revision: 4,
    enabled: true,
    health: 'available',
    target: {
      kind: 'inline',
      definition,
    },
    triggers,
  });
}

// HTTP is the boundary. The real Account Action owner opens this canonical
// Automation recipe and projects the trigger sets consumed by the Work host.
let rows: AutomationDefinitionDetail[] = [];
let failAutomationReads = false;
let failRunReads = false;
let holdAutomationRead: (() => Promise<void>) | undefined;
let finishRunRead: (() => Promise<void>) | undefined;
let workflowInventoryReads = 0;
const automationHttp = vi.fn(async (url: URL, init?: RequestInit): Promise<Response> => {
  await holdAutomationRead?.();
  const method = init?.method ?? 'GET';
  const detailQuery = url.pathname === '/v3/automations/query' && method === 'POST'
    ? AutomationDefinitionDetailsRequestSchema.parse(JSON.parse(String(init?.body))) : null;
  if ((method === 'GET' || detailQuery !== null) && failAutomationReads) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  if (detailQuery) {
    const selected = rows.filter(row => detailQuery.scopeSessionId ? row.scopeSessionId === detailQuery.scopeSessionId
      : detailQuery.scope === 'account_inline' ? row.scopeSessionId === null : true);
    return Response.json(AutomationDefinitionDetailsResponseSchema.parse({ automations: selected, nextCursor: null }));
  }
  if (url.pathname === '/v3/automations' && method === 'GET') {
    const scope = url.searchParams.get('scopeSessionId');
    const selected = rows.filter(row => scope ? row.scopeSessionId === scope
      : url.searchParams.get('scope') === 'account_inline' ? row.scopeSessionId === null : true);
    return Response.json(AutomationDefinitionListResponseSchema.parse({ automations: selected.map(row => {
      const { executionRecipe: _recipe, templateCiphertext: _template, ...summary } = row;
      return { ...summary, triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) };
    }), nextCursor: null }));
  }
  if (url.pathname === '/v3/automations' && method === 'POST') {
    const input = AutomationDefinitionCreateRequestSchema.parse(JSON.parse(String(init?.body)));
    const row = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name,
      description: input.description ?? null, enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? null,
      scopeSessionId: input.scopeSessionId ?? null, targetType: null, existingSessionId: null,
      templateVersion: input.executionRecipe!.templateVersion, lastRunAt: null, createdAt: 1, updatedAt: 1,
      executionRecipe: input.executionRecipe, assignments: input.assignments?.map(assignment => ({ ...assignment,
        enabled: assignment.enabled ?? true, priority: assignment.priority ?? 0, updatedAt: 1 })) ?? [],
      triggers: input.triggers.map(({ triggerId, trigger }) => ({ ...trigger, id: triggerId, revision: 1,
        enabled: true, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: null,
        remainingOccurrences: trigger.kind === 'sessionLifecycle' && trigger.policy.kind === 'currentTurn' ? 1 : null,
        status: { state: 'waiting', runId: null } })),
    });
    rows = [...rows, row];
    return Response.json(row);
  }
  const id = decodeURIComponent(url.pathname.slice('/v3/automations/'.length));
  const row = rows.find(candidate => candidate.id === id);
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
  if (method === 'PUT') {
    const input = AutomationDefinitionReconcileRequestSchema.parse(JSON.parse(String(init?.body)));
    const updated = AutomationDefinitionDetailSchema.parse({ ...row, templateVersion: row.templateVersion + 1,
      enabled: input.enabled ?? row.enabled, executionRecipe: input.executionRecipe ?? row.executionRecipe,
      triggers: row.triggers.map(trigger => {
        const patch = input.triggers.find(item => item.kind === 'existing' && item.triggerId === trigger.id);
        return patch?.kind === 'existing' ? { ...trigger, enabled: patch.enabled ?? trigger.enabled } : trigger;
      }),
    });
    rows = rows.map(candidate => candidate.id === id ? updated : candidate);
    return Response.json(updated);
  }
  return Response.json(row);
});

function answer(sets: readonly WorkflowTriggerSetV1[]) {
  failAutomationReads = false;
  rows = sets.map(set => AutomationDefinitionDetailSchema.parse({ id: set.automationId, name: 'Session habit',
    description: null, enabled: set.enabled, workflowDefinitionId: null, scopeSessionId: set.scopeSessionId ?? 'session-1',
    targetType: null, existingSessionId: null, templateVersion: set.revision, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }],
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: set.revision,
      workflow: { t: 'plain', v: AutomationStoredWorkflowDefinitionV2Schema.parse({ workspace: { directory: '/repo' },
        executionTarget: { kind: 'session' }, inlineDefinition: set.target?.kind === 'inline' ? set.target.definition : definition }) }, triggerEvidence: null }), triggers: set.triggers,
  }));
}

async function settle() {
  await flushHookEffects();
}

let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
let workflowHttp: Awaited<ReturnType<typeof installWorkflowActionHttpBoundary>>;
let machineRow: ReturnType<typeof createPlainMachineRowFixture>;
let previousState = getStorage().getState();
function resetTriggerSets() {
  const state = getStorage().getState();
  if (!('resetWorkflowTriggerSets' in state) || typeof state.resetWorkflowTriggerSets !== 'function') {
    throw new Error('The real Automation store must provide resetWorkflowTriggerSets');
  }
  state.resetWorkflowTriggerSets();
}
beforeEach(async () => {
  previousState = getStorage().getState();
  home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://server-a', accountId: 'account-a', currentAccount: true }],
    route: request => request.path === '/v1/artifacts' ? Response.json([]) : undefined });
  resetTriggerSets();
  rows = [];
  failAutomationReads = false;
  failRunReads = false;
  holdAutomationRead = undefined;
  finishRunRead = undefined;
  automationHttp.mockClear();
  machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-a' });
  workflowHttp = await installWorkflowActionHttpBoundary({ accountId: () => 'account-a', automationDefinitions: automationHttp,
    machineRows: () => [machineRow],
    fixtureResponse: async (actionId, input) => {
      if (actionId === 'workflow.definition.list') {
        workflowInventoryReads += 1;
        return { ok: true, result: { definitions: [], nextCursor: null } };
      }
      if (actionId === 'workflow.run.list') {
        await finishRunRead?.();
        if (failRunReads) return { ok: false, error: 'temporarily_unavailable', errorCode: 'target_unavailable' };
        return { ok: true, result: { runs: [], metadataByRunId: {} } };
      }
      if (actionId === 'workflow.run.summaries') {
        const request = WorkflowRunAutomationSummariesRequestV1Schema.parse(input);
        return { ok: true, result: WorkflowRunAutomationSummariesResultV1Schema.parse({
          automationSummaries: request.automationIds.map(automationId => ({ automationId, lastRun: null })),
          remainingAutomationIds: [],
        }) };
      }
      throw new Error(`Unexpected fixture Action ${actionId}`);
    } });
  workflowHttp.prime();
  await (await import('@/sync/runtime/orchestration/connectionManager')).restoreConnectionToActiveServer(workflowHttp.credentials);
  await seedSessionMachine(true);
});
afterEach(async () => {
  await standardCleanup();
  resetTriggerSets();
  await workflowHttp?.dispose();
  await home.dispose();
  getStorage().setState(previousState, true);
  routeParams.current = {};
});

async function seedSessionMachine(machineActive: boolean) {
  const previous = getStorage().getState().machines['machine-a'];
  const observedAt = Math.max(Date.now(), (previous?.activeAt ?? 0) + 1);
  machineRow = { ...createPlainMachineRowFixture({ id: 'machine-a', accountId: 'account-a' }),
    active: machineActive, activeAt: observedAt, updatedAt: observedAt };
  await act(async () => { await (await import('@/sync/sync')).sync.refreshMachines(); });
  const machine = getStorage().getState().machines['machine-a'];
  if (!machine?.metadata) throw new Error('The Home census must publish the Session Machine');
  const session = createSessionFixture({ id: 'session-1', serverId: home.serverId, active: true,
    metadata: { machineId: 'machine-a', path: '/repo', host: machine.metadata!.host } });
  act(() => {
    getStorage().getState().applySessions([session]);
  });
  return machine;
}

describe('the Session Info page Triggers section', () => {
  it('profiles an empty Session among Account Habits and publishes no work for unchanged read results', async () => {
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    // The FIN-REPLAY3 Account census has 62 sets. Keep that admission/projection
    // cardinality while all of these inline workflows belong to other Sessions.
    const unrelatedSets = Array.from({ length: 62 }, (_, index) => WorkflowTriggerSetV1Schema.parse({
      ...triggerSet([{ ...lifecycleTrigger(`unrelated-trigger-${index}`, true), sourceSessionId: `other-session-${index}` }]),
      automationId: `unrelated-set-${index}`, scopeSessionId: `other-session-${index}`,
    }));
    answer(unrelatedSets);
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const transport = countTransportRequests(workflowHttp.request, (url, init) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    setRuntimeFetch(transport.request);
    const publications = countStoreNotifications(getStorage());
    const commits: { phase: string; duration: number }[] = [];
    const screen = await renderScreen(<InfoHabitArrival onHabitRender={(_id, phase, duration) => {
      commits.push({ phase, duration });
    }} />);
    try {
      await vi.waitFor(() => expect(screen.findByTestId('info-habits-arrival')?.props.hidden).toBe(true));
      const startup = { commits: commits.length, renderMs: commits.reduce((sum, item) => sum + item.duration, 0),
        publications: publications.read().length,
        triggerPublications: publications.read().filter(keys => keys.includes('workflowTriggerSetsById') || keys.includes('workflowTriggerSetIdsByQuery')).length,
        runPublications: publications.read().filter(keys => keys.includes('workflowRunListWindows')).length };
      const known = getStorage().getState().workflowTriggerSetIdsByQuery.account_all;
      expect(known).toHaveLength(unrelatedSets.length);
      const admitted = known!.map(id => getStorage().getState().workflowTriggerSetsById[id]!);
      // HTTP decodes new objects, even when the admitted facts did not change.
      const repeatedAnswers = Array.from({ length: 10 }, () => admitted.map(set => WorkflowTriggerSetV1Schema.parse(set)));
      publications.reset();
      commits.length = 0;
      for (const sets of repeatedAnswers) {
        act(() => {
          getStorage().getState().applyWorkflowTriggerSetPage({ queryKey: 'account_all', sets });
          getStorage().getState().applyWorkflowRunListPage({ windowId: 'destination:session-1', runs: [],
            metadataByRunId: {}, nextCursor: null, mode: 'replace' });
        });
      }
      const unchanged = { commits: commits.length,
        publications: publications.read().length,
        triggerPublications: publications.read().filter(keys => keys.includes('workflowTriggerSetsById') || keys.includes('workflowTriggerSetIdsByQuery')).length,
        runPublications: publications.read().filter(keys => keys.includes('workflowRunListWindows')).length };
      console.info('FIN_HABITS_PROFILE', JSON.stringify({ startup, unchanged, transport: transport.read() }));
      expect(unchanged).toEqual({ commits: 0, publications: 0, triggerPublications: 0, runPublications: 0 });
      const set = WorkflowTriggerSetV1Schema.parse({ ...triggerSet([lifecycleTrigger('trig-1', true)]), scopeSessionId: 'session-1' });
      await act(async () => getStorage().getState().applyWorkflowTriggerSetPage({ queryKey: 'session:session-1', sets: [set] }));
      expect(screen.findHostByTestId('session-work-trigger:set-1:trig-1')).not.toBeNull();
      expect(screen.findByTestId('info-habits-arrival')?.props.hidden).toBe(false);
      expect(publications.read().filter(keys => keys.includes('workflowTriggerSetsById'))).toHaveLength(1);
    } finally {
      publications.stop();
      setRuntimeFetch(workflowHttp.request);
    }
  });

  it.each(['triggers', 'destination'] as const)('reserves no Habits body for a slow empty %s read, then proves it empty without a fold jump', async (slowRead) => {
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    answer([]);
    const held = createDeferred<void>();
    if (slowRead === 'triggers') holdAutomationRead = () => held.promise;
    else finishRunRead = () => held.promise;
    const screen = await renderScreen(<InfoHabitArrival />);
    try {
      await settle();
      expect(screen.findHostByTestId('session-work-triggers')).toBeNull();
      expect(screen.findByTestId('session-work-triggers-empty')).toBeNull();
      expect(screen.findByTestId('info-habits-arrival')?.props.hidden).toBe(false);
      await act(async () => { held.resolve(); });
      await vi.waitFor(() => expect(screen.findByTestId('info-habits-arrival')?.props.hidden).toBe(true));
      // The hidden owner remains mounted and complete; unknown was never painted as a two-row body.
      expect(screen.findByType(SessionHabitsSection)).not.toBeNull();
      expect(screen.findByTestId('session-work-writes-here')).toBeNull();
    } finally {
      held.resolve();
      holdAutomationRead = undefined;
      finishRunRead = undefined;
    }
  });

  it('presents concurrent Habit read failures once and retries the section together', async () => {
    failAutomationReads = true;
    failRunReads = true;
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    const failureIds = ['session-work-triggers-failed', 'scheduled-workflow-read', 'session-work-writes-here-failed'];
    expect(failureIds.filter(id => screen.findHostByTestId(id) !== null)).toHaveLength(1);
    expect(screen.findByTestId('session-work-triggers-failed-action')).not.toBeNull();
    answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
    failRunReads = false;
    automationHttp.mockClear();
    await screen.pressByTestIdAsync('session-work-triggers-failed-action');
    await vi.waitFor(() => expect(screen.findHostByTestId('session-work-trigger:set-1:trig-1')).not.toBeNull());
    expect(failureIds.filter(id => screen.findHostByTestId(id) !== null)).toHaveLength(0);
    const queries = automationHttp.mock.calls.flatMap(([url, init]) => url.pathname === '/v3/automations/query'
      ? [AutomationDefinitionDetailsRequestSchema.parse(JSON.parse(String(init?.body)))] : []);
    // The Account-all Action maps to an unfiltered HTTP query, not a scope enum.
    expect(queries.filter(query => query.scopeSessionId === undefined && query.scope === undefined)).toHaveLength(1);
    expect(queries.filter(query => query.scopeSessionId === 'session-1')).toHaveLength(1);
  });

  it('keeps destination-only Habit content mounted through a Machine flap and pending recovery', async () => {
    const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
    const selection = materializeWorkflowStarterExample(example, {
      session: { sessionId: 'session-1', machineId: 'machine-a' },
    });
    if (selection.status !== 'ready') throw new Error('Session-bound example required');
    answer([WorkflowTriggerSetV1Schema.parse({ ...triggerSet([]), scopeSessionId: null,
      target: { kind: 'inline', definition: selection.example.definition },
      triggers: [{ id: 'timer', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
        triggerDefinitionEnvelope: null, kind: 'schedule', nextRunAt: null,
        schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }],
    })]);
    rows = rows.map(row => ({ ...row, scopeSessionId: null }));
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    const row = screen.findHostByTestId('scheduled-workflow:set-1:timer');
    expect(row).not.toBeNull();
    const section = screen.findHostByTestId('session-work-triggers');
    const readsBeforeOffline = automationHttp.mock.calls.length;
    await seedSessionMachine(false);
    expect(automationHttp.mock.calls.length).toBe(readsBeforeOffline);
    expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row, 'offline keeps the scheduled row').toBe(true);
    failAutomationReads = true;
    const { SessionTriggersSectionView } = await import('./SessionTriggersSection');
    await act(async () => screen.findByType(SessionTriggersSectionView).props.onRetry());
    await vi.waitFor(() => expect(screen.findHostByTestId('session-work-triggers-failed')).not.toBeNull());
    expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') !== null, 'failed refresh retains the scheduled content').toBe(true);
    expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row).toBe(true);
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    holdAutomationRead = () => held;
    failAutomationReads = false;
    try {
      await seedSessionMachine(true);
      await settle();
      expect(screen.findHostByTestId('session-work-triggers') === section).toBe(true);
      expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row).toBe(true);
      expect(screen.findHostByTestId('session-work-triggers-refreshing')).not.toBeNull();
      release();
      await settle();
      await vi.waitFor(() => expect(screen.findHostByTestId('session-work-triggers-failed')).toBeNull());
      expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row).toBe(true);
    } finally {
      holdAutomationRead = undefined;
      release();
    }
  });

  it('reads workflow options only after a Habit picker opens', async () => {
    answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
    workflowInventoryReads = 0;
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    await vi.waitFor(() => expect(screen.findByTestId('session-work-trigger:set-1:trig-1')).not.toBeNull());
    expect(workflowInventoryReads).toBe(0);
    await screen.pressByTestIdAsync('session-work-trigger:set-1:trig-1');
    await vi.waitFor(() => expect(workflowInventoryReads).toBeGreaterThan(0));
  });
  it.each(['starts-and-writes', 'account-writes', 'starts-only'] as const)(
    'shows a scheduled Habit exactly once in its owning group (%s), retaining it after a read failure', async (relation) => {
      const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
      const selection = materializeWorkflowStarterExample(example, {
        session: { sessionId: relation === 'starts-only' ? 'elsewhere' : 'session-1', machineId: 'machine-a' },
      });
      if (selection.status !== 'ready') throw new Error('Session-bound example required');
      const set = WorkflowTriggerSetV1Schema.parse({ ...triggerSet([]),
        scopeSessionId: relation === 'account-writes' ? null : 'session-1',
        target: { kind: 'inline', definition: selection.example.definition },
        triggers: [{ id: 'timer', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
          triggerDefinitionEnvelope: null, kind: 'schedule', nextRunAt: null,
          schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }],
      });
      answer([set]);
      // The HTTP producer carries Account scope explicitly, rather than the
      // older helper's default Session scope. Real Actions derive destinations.
      if (relation === 'account-writes') rows = rows.map(row => ({ ...row, scopeSessionId: null }));
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      const startsId = 'session-work-trigger:set-1:timer';
      const writesId = 'scheduled-workflow:set-1:timer';
      const assertPlacement = () => {
        const starts = screen.findByTestId(startsId);
        const writes = screen.findByTestId(writesId);
        expect(Number(starts !== null) + Number(writes !== null)).toBe(1);
        expect(starts !== null).toBe(relation !== 'account-writes');
        expect(writes !== null).toBe(relation === 'account-writes');
      };
      await vi.waitFor(assertPlacement);
      // A failed refresh must not remove or duplicate last-known content.
      const { useScheduledWorkflowRows } = await import('./ScheduledWorkflowSection');
      const read = await renderHook(() => useScheduledWorkflowRows('session-1'));
      failAutomationReads = true;
      await act(async () => {
        read.getCurrent().retry();
      });
      await vi.waitFor(() => expect(read.getCurrent().status).toBe('failed'));
      assertPlacement();
    },
  );
  it('keeps ordinary rows usable while the PR-link read is unavailable, with no section-level band', async () => {
    // No Channels Data collection is installed for this Account, so the real
    // PR-link reader refuses independently of the readable Automation rows.
    answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
    const screen = await renderScreen(
      <SessionInfoSetup sessionId="session-1" />,
    );
    await settle();
    expect(
      screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props
        .value,
    ).toBe(true);
    await vi.waitFor(() => expect(screen.findByTestId('session-work-triggers-failed')).toBeNull());
    expect(
      screen.findByTestId('session-work-trigger-links-unavailable'),
    ).toBeNull();
  });
  it('turns one trigger on or off through session.trigger.update, never by pausing its Automation', async () => {
    // trig-1 is off at trigger level inside an enabled set; trig-2 shares the set.
    answer([
      triggerSet([
        lifecycleTrigger('trig-1', false),
        lifecycleTrigger('trig-2', true),
      ]),
    ]);
    const screen = await renderScreen(
      <SessionInfoSetup sessionId="session-1" />,
    );
    await settle();

    // The real Session resolver chooses its placement. Account HTTP owns the
    // trigger rows; its list must keep the Session filter and Account token.
    expect(automationHttp.mock.calls.some(([url, init]) => url.pathname === '/v3/automations/query'
      && JSON.parse(String(init?.body)).scopeSessionId === 'session-1'
      && new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '))).toBe(true);
    const offSwitch = screen.findByTestId(
      'session-work-trigger:set-1:trig-1-switch',
    );
    const automationsBefore = getStorage().getState().automations;
    expect(offSwitch?.props.value).toBe(false);
    await act(async () => {
      offSwitch?.props.onValueChange(true);
    });
    await settle();

    await vi.waitFor(() => expect(automationHttp.mock.calls.map(([url, init]) => ({ path: url.pathname, method: init?.method ?? 'GET' })))
      .toContainEqual({ path: '/v3/automations/set-1', method: 'PUT' }));
    await vi.waitFor(() => expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props.value).toBe(true));
    const mutation = automationHttp.mock.calls.find(([url, init]) => url.pathname === '/v3/automations/set-1' && init?.method === 'PUT');
    expect(mutation).toBeDefined();
    expect(AutomationDefinitionReconcileRequestSchema.parse(JSON.parse(String(mutation?.[1]?.body)))).toMatchObject({
      expectedTemplateVersion: 4,
      triggers: [{ kind: 'existing', triggerId: 'trig-1', expectedRevision: 1, enabled: true },
        { kind: 'existing', triggerId: 'trig-2', expectedRevision: 1 }],
    });
    expect(rows[0]?.assignments).toEqual([{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }]);
    expect(rows[0]?.enabled).toBe(true);
    expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')?.props.value).toBe(true);
    expect(getStorage().getState().automations).toBe(automationsBefore);
    expect(screen.findByTestId('session-work-trigger:set-1:trig-2-switch')?.props.value).toBe(true);
  });

  it('stays on the Info page with its empty state and a way to add the first trigger', async () => {
    answer([]);
    const screen = await renderScreen(
      <SessionInfoSetup sessionId="session-1" />,
    );
    await settle();

    expect(screen.findByTestId('session-work-triggers')).not.toBeNull();
    expect(screen.findByTestId('session-work-triggers-empty')).not.toBeNull();
    expect(screen.findByTestId('session-work-triggers-add')).not.toBeNull();
  });

  it('draws no "Writes here" heading while nothing writes into this session, loading or loaded', async () => {
    const { resetWorkflowLibraryReadsForTests } = await import(
      '@/components/workflows/library/workflowLibraryReads'
    );
    resetWorkflowLibraryReadsForTests();
    const runList: { finish: (() => void) | null } = { finish: null };
    answer([]);
    finishRunRead = () => new Promise<void>((resolve) => { runList.finish = resolve; });
    const screen = await renderScreen(
      <SessionInfoSetup sessionId="session-1" />,
    );
    await settle();
    // Still reading: a section that may not exist holds no skeleton that later collapses.
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();

    await act(async () => {
      runList.finish?.();
    });
    await settle();
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();
  });

  it('opens "When this turn finishes…" bound to that turn and adds it through session.trigger.add', async () => {
    answer([]);
    routeParams.current = {
      sourceSessionId: 'session-1',
      sourceTurnId: 'turn-7',
      sourceServerId: home.serverId,
      sessionLifecycleEvents: 'parentTurnCompleted',
    };
    const screen = await renderScreen(
      <SessionInfoSetup sessionId="session-1" />,
    );
    await settle();

    expect(screen.findByTestId('session-work-trigger-popover')).not.toBeNull();
    await act(async () => {
      screen.changeTextByTestId(
        'session-work-trigger-popover-prompt',
        'Review what changed',
      );
    });
    await act(async () => {
      screen.pressByTestId('session-work-trigger-popover-submit');
    });
    await settle();

    const add = automationHttp.mock.calls.find(([url, init]) => url.pathname === '/v3/automations' && init?.method === 'POST');
    expect(add).toBeDefined();
    const created = AutomationDefinitionCreateRequestSchema.parse(JSON.parse(String(add?.[1]?.body)));
    expect(created).toMatchObject({
      scopeSessionId: 'session-1',
      assignments: [{ machineId: 'machine-a' }],
      triggers: [{ trigger: {
        kind: 'sessionLifecycle',
        sourceSessionId: 'session-1',
        policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' },
      } }],
      executionRecipe: { v: 2, workflow: { t: 'plain', v: { inlineDefinition: {
        blocks: [{ document: { text: 'Review what changed' } }],
      } } } },
    });
    await vi.waitFor(() => expect(getStorage().getState().workflowTriggerSetsById[created.automationId]?.target?.kind).toBe('inline'));
  });
  describe('when the session Machine is offline', () => {
    function failReads() {
      failAutomationReads = true;
    }

    it('keeps a settled Habit read failure and its retry visible even when the Machine is offline', async () => {
      await seedSessionMachine(false);
      failReads();
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      // DIAG-HABITS: Machine reachability does not turn a settled Account read failure into loading.
      expect(screen.findByTestId('session-work-triggers-failed')).not.toBeNull();
      expect(screen.findByTestId('session-work-triggers-failed-action')).not.toBeNull();
    });

    it('still says a failed read when the Machine is reachable', async () => {
      await seedSessionMachine(true);
      failReads();
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      expect(screen.findByTestId('session-work-triggers-failed')).not.toBeNull();
    });

    it('reads again by itself when the offline Machine returns', async () => {
      await seedSessionMachine(false);
      failReads();
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')).toBeNull();
      answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
      await seedSessionMachine(true);
      await settle();
      expect(screen.findByTestId('session-work-trigger:set-1:trig-1-switch')).not.toBeNull();
    });
  });

});
