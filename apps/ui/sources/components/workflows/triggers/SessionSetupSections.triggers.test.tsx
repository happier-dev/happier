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
import { createWorkflowAutomationTriggerDetailFixture } from '@/dev/testkit/harness/workflowAutomationHttpBoundary';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWorkflowActionHttpBoundary } from '@/dev/testkit/fixtures/workflowActionHttpBoundary';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { getStorage } from '@/sync/domains/state/storage';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample } from '@happier-dev/protocol/workflows/builtins/examples';
import { SessionInfoSectionSummaryProvider, useSessionInfoSectionSummaryHost } from '@/components/sessions/info/sessionInfoSectionSummaries';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { countStoreNotifications, countTransportRequests } from '@/dev/testkit/performance/counts';
import { workflowRunListWindowStoreKey } from '@/sync/store/domains/workflowRuns';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

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
function SessionInfoSetup(props: Readonly<{ sessionId: string; onHabitRender?: React.ProfilerOnRenderCallback; offlineStatedAbove?: boolean }>) {
  const session = useSessionViewShellSession(props.sessionId, home.serverId);
  const habits = session ? <SessionHabitsSection sessionId={session.id} serverId={home.serverId}
    {...(props.offlineStatedAbove ? { offlineStatedAbove: true } : {})} /> : null;
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
    triggerDefinitionEnvelope: 'opened-definition',
    subject: { kind: 'session', serverId: 'portable-home', sessionId: 'session-1' },
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
let subjectQueries: unknown[] = [];

/** The Home returns direct Session attachments and inherited all-Session Account habits. */
function attachedTo(sessionId: string) {
  return rows.flatMap(row => row.triggers.filter(trigger => row.scopeSessionId === sessionId
    || (row.scopeSessionId === null && trigger.kind === 'sessionLifecycle' && trigger.subject === undefined)).map(trigger => ({
    automationId: row.id, triggerId: trigger.id, workflowDefinitionId: row.workflowDefinitionId,
    relation: row.scopeSessionId === sessionId ? 'direct' as const : 'context' as const,
    enabled: row.enabled && trigger.enabled, revision: trigger.revision,
    summary: trigger.kind === 'schedule'
      ? { kind: 'schedule' as const, schedule: trigger.schedule, remainingOccurrences: null }
      : { kind: 'sessionLifecycle' as const, events: ['parentTurnCompleted' as const] },
    setUpBy: { accountId: 'account-a', displayName: 'Owner' },
  })));
}
const automationHttp = vi.fn(async (url: URL, init?: RequestInit): Promise<Response> => {
  await holdAutomationRead?.();
  const method = init?.method ?? 'GET';
  const body = url.pathname === '/v3/automations/query' && method === 'POST' ? JSON.parse(String(init?.body)) : null;
  if (body !== null && 'subject' in body) {
    if (failAutomationReads) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    subjectQueries.push(body.subject);
    return Response.json(AutomationDefinitionListResponseSchema.parse({ automations: [],
      attached: attachedTo(body.subject.sessionId), nextCursor: null, skippedNotSharedCount: 0 }));
  }
  const detailQuery = body === null ? null : AutomationDefinitionDetailsRequestSchema.parse(body);
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
      triggers: input.triggers.map(row => createWorkflowAutomationTriggerDetailFixture(input.automationId, row)),
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
        executionTarget: { kind: 'session' }, inlineDefinition: set.target?.kind === 'inline' ? set.target.definition : definition }) }, triggerEvidence: null }), triggers: set.triggers.map(trigger => trigger.kind === 'sessionLifecycle'
        ? createWorkflowAutomationTriggerDetailFixture(set.automationId, { triggerId: trigger.id, trigger: {
            kind: trigger.kind, enabled: trigger.enabled, ...(trigger.subject === undefined ? {} : { subject: trigger.subject }),
            events: trigger.events, policy: trigger.policy,
        } }, trigger.revision) : trigger),
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
  home = await serveSessionActionHome({ homes: [{ key: 'session', serverUrl: 'https://server-a', serverIdentityId: 'srv_session_habit_home',
    accountId: 'account-a', currentAccount: true }],
    route: request => request.path === '/v1/artifacts' ? Response.json([]) : undefined });
  resetTriggerSets();
  rows = [];
  failAutomationReads = false;
  failRunReads = false;
  holdAutomationRead = undefined;
  finishRunRead = undefined;
  automationHttp.mockClear();
  subjectQueries = [];
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
  installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
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
    presenceProtocolVersion: 1, active: machineActive, activeAt: observedAt, updatedAt: observedAt };
  await act(async () => { await (await import('@/sync/sync')).sync.refreshMachines(); });
  const machine = getStorage().getState().machines['machine-a'];
  if (!machine?.metadata) throw new Error('The Home census must publish the Session Machine');
  expect(isMachineOnline(machine)).toBe(machineActive);
  const session = createSessionFixture({ id: 'session-1', serverId: home.serverId, active: true,
    metadata: { machineId: 'machine-a', path: '/repo', host: machine.metadata!.host } });
  act(() => {
    getStorage().getState().applySessions([session]);
  });
  return machine;
}

const ROW = 'subject-triggers:set-1:trig-1';

describe('the Session Info page Automations section', () => {
  it('profiles an empty Session among Account Habits and publishes no work for unchanged read results', async () => {
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    // The FIN-REPLAY3 Account census has 62 sets. Keep that admission/projection
    // cardinality while all of these inline workflows belong to other Sessions.
    const unrelatedSets = Array.from({ length: 62 }, (_, index) => WorkflowTriggerSetV1Schema.parse({
      ...triggerSet([{ ...lifecycleTrigger(`unrelated-trigger-${index}`, true), subject: { kind: 'session', serverId: 'portable-home', sessionId: `other-session-${index}` } }]),
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
          getStorage().getState().applyWorkflowRunListPage({ windowId: workflowRunListWindowStoreKey('destination:session-1', {
            serverId: home.serverId, accountId: 'account-a',
          }), runs: [],
            metadataByRunId: {}, nextCursor: null, mode: 'replace' });
        });
      }
      const unchanged = { commits: commits.length,
        publications: publications.read().length,
        triggerPublications: publications.read().filter(keys => keys.includes('workflowTriggerSetsById') || keys.includes('workflowTriggerSetIdsByQuery')).length,
        runPublications: publications.read().filter(keys => keys.includes('workflowRunListWindows')).length };
      console.info('FIN_HABITS_PROFILE', JSON.stringify({ startup, unchanged, transport: transport.read() }));
      expect(unchanged).toEqual({ commits: 0, publications: 0, triggerPublications: 0, runPublications: 0 });
      // The section reads this Session as its selected subject, once.
      expect(subjectQueries).toEqual([{ kind: 'session', serverId: 'srv_session_habit_home', sessionId: 'session-1' }]);
    } finally {
      publications.stop();
      setRuntimeFetch(workflowHttp.request);
    }
  });

  it.each(['triggers', 'destination'] as const)('keeps the section loading through a slow empty %s read, then folds it once proven empty', async (slowRead) => {
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    answer([]);
    const held = createDeferred<void>();
    if (slowRead === 'triggers') holdAutomationRead = () => held.promise;
    else finishRunRead = () => held.promise;
    const screen = await renderScreen(<InfoHabitArrival />);
    try {
      await settle();
      // Unknown is not empty: the section keeps its header and loading rows, and Info does not fold it yet.
      expect(screen.findHostByTestId('subject-triggers-read')).not.toBeNull();
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

  it('opens the sentence builder from outside the section through its actions (Work tab + › Add a trigger)', async () => {
    const actionsRef = React.createRef<import('@/components/workflows/triggers/SubjectTriggersSection').SubjectTriggersSectionActions>();
    const anchorRef = React.createRef<import('react-native').View>();
    const screen = await renderScreen(<InjectedAuthProvider credentials={workflowHttp?.credentials ?? null}>
      <AppPaneProvider><ItemList><SessionHabitsSection sessionId="session-1" serverId={home.serverId} actionsRef={actionsRef} /></ItemList></AppPaneProvider>
    </InjectedAuthProvider>);
    await settle();
    expect(screen.findByTestId('workflow-builder')).toBeNull();
    await act(async () => { actionsRef.current?.openNewTrigger(anchorRef); });
    await settle();
    expect(screen.findByTestId('workflow-builder')).not.toBeNull();
    // WF-ACCEPT-1118 item 3 (lab round 1116c pop-v): the editor's own sentence on a new draft. No step is preselected
    // ("Add a first step", no separate verb chip), the title names the resource, and the foot is Open in the editor.
    expect(screen.findByTestId('workflow-builder-verb')).toBeNull();
    expect(screen.findByTestId('workflow-builder-sentence-add-step')).not.toBeNull();
    expect(screen.findByTestId('workflow-builder-title')?.props.children).toContain('workflows.sentence.builder.titleFor');
    expect(screen.findByTestId('workflow-builder-open-editor')).not.toBeNull();
    expect(screen.getTextContent()).toContain('workflows.sentence.builder.openInEditor');
    expect(screen.getTextContent()).not.toContain('workflows.sentence.builder.addAnotherStep');
  });

  it('presents concurrent Habit read failures once and retries the section together', async () => {
    failAutomationReads = true;
    failRunReads = true;
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    const failureIds = ['subject-triggers-read', 'scheduled-workflow-read', 'session-work-writes-here-failed'];
    await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-read-retry')).not.toBeNull());
    expect(failureIds.filter(id => screen.findHostByTestId(id) !== null)).toHaveLength(1);
    answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
    failRunReads = false;
    automationHttp.mockClear();
    subjectQueries = [];
    await screen.pressByTestIdAsync('subject-triggers-read-retry');
    await vi.waitFor(() => expect(screen.findHostByTestId(ROW)).not.toBeNull());
    expect(failureIds.filter(id => screen.findHostByTestId(id) !== null)).toHaveLength(0);
    const queries = automationHttp.mock.calls.flatMap(([url, init]) => {
      if (url.pathname !== '/v3/automations/query') return [];
      const body = JSON.parse(String(init?.body));
      return 'subject' in body ? [] : [AutomationDefinitionDetailsRequestSchema.parse(body)];
    });
    // The Account-all Action maps to an unfiltered HTTP query, not a scope enum.
    expect(queries.filter(query => query.scopeSessionId === undefined && query.scope === undefined)).toHaveLength(1);
    expect(queries.filter(query => query.scopeSessionId === 'session-1')).toHaveLength(1);
    expect(subjectQueries).toHaveLength(1);
  });

  it('shows an all-Session Account habit as an inherited row without Session mutation controls', async () => {
    const { subject: _subject, ...allSessions } = lifecycleTrigger('account-habit', true);
    answer([WorkflowTriggerSetV1Schema.parse({ ...triggerSet([]), scopeSessionId: null,
      triggers: [allSessions] })]);
    rows = rows.map(row => ({ ...row, scopeSessionId: null }));
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-read-only:set-1:account-habit')).not.toBeNull());
    expect(screen.findByTestId('subject-triggers:set-1:account-habit-switch')).toBeNull();
    expect(screen.findByTestId('subject-triggers:set-1:account-habit')).toBeNull();
  });

  it('keeps destination-only Habit content mounted through a Machine flap and recovers when the Machine returns', async () => {
    const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
    const selection = materializeWorkflowStarterExample(example, {
      session: { serverId: 'portable-home', sessionId: 'session-1', machineId: 'machine-a' },
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
    await vi.waitFor(() => expect(screen.findHostByTestId('scheduled-workflow:set-1:timer')).not.toBeNull());
    const row = screen.findHostByTestId('scheduled-workflow:set-1:timer');
    const section = screen.findHostByTestId('subject-triggers');
    const readsBeforeOffline = automationHttp.mock.calls.length;
    await seedSessionMachine(false);
    expect(automationHttp.mock.calls.length).toBe(readsBeforeOffline);
    expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row, 'offline keeps the scheduled row').toBe(true);
    failAutomationReads = true;
    const { SubjectTriggersSectionContent } = await import('./SubjectTriggersSection');
    await act(async () => screen.findByType(SubjectTriggersSectionContent).props.automations.read.retry());
    await vi.waitFor(() => expect(screen.findHostByTestId('subject-triggers-read')).not.toBeNull());
    expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row, 'failed refresh retains the scheduled content').toBe(true);
    failAutomationReads = false;
    // The Machine's return reads again by itself, without a Retry tap.
    await seedSessionMachine(true);
    await settle();
    await vi.waitFor(() => expect(screen.findHostByTestId('subject-triggers-read')).toBeNull());
    expect(screen.findHostByTestId('subject-triggers') === section).toBe(true);
    expect(screen.findHostByTestId('scheduled-workflow:set-1:timer') === row).toBe(true);
  });

  it('reads workflow options only after a Habit editor opens', async () => {
    answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
    workflowInventoryReads = 0;
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    await vi.waitFor(() => expect(screen.findByTestId(ROW)).not.toBeNull());
    expect(workflowInventoryReads).toBe(0);
    await screen.pressByTestIdAsync(ROW);
    await vi.waitFor(() => expect(workflowInventoryReads).toBeGreaterThan(0));
  });
  it.each(['starts-and-writes', 'account-writes', 'starts-only'] as const)(
    'shows a scheduled Habit exactly once in its owning group (%s), retaining it after a read failure', async (relation) => {
      const example = WORKFLOW_STARTER_EXAMPLES_V1.find(value => value.key === 'daily-summary-in-session')!;
      const selection = materializeWorkflowStarterExample(example, {
        session: { serverId: 'portable-home', sessionId: relation === 'starts-only' ? 'elsewhere' : 'session-1', machineId: 'machine-a' },
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
      const startsId = 'subject-triggers:set-1:timer';
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
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    await vi.waitFor(() => expect(screen.findByTestId(`${ROW}-switch`)?.props.value).toBe(true));
    expect(screen.findByTestId('subject-triggers-read')).toBeNull();
  });
  it('turns one trigger on or off through workflow.trigger.update, never by pausing its Automation', async () => {
    // trig-1 is off at trigger level inside an enabled set; trig-2 shares the set.
    answer([triggerSet([lifecycleTrigger('trig-1', false), lifecycleTrigger('trig-2', true)])]);
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();

    // The real Session resolver chooses its placement. Account HTTP owns the
    // trigger rows; its list must keep the Session filter and Account token.
    expect(automationHttp.mock.calls.some(([url, init]) => url.pathname === '/v3/automations/query'
      && JSON.parse(String(init?.body)).scopeSessionId === 'session-1'
      && new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '))).toBe(true);
    await vi.waitFor(() => expect(screen.findByTestId(`${ROW}-switch`)).not.toBeNull());
    const offSwitch = screen.findByTestId(`${ROW}-switch`);
    const automationsBefore = getStorage().getState().automations;
    expect(offSwitch?.props.value).toBe(false);
    await act(async () => {
      offSwitch?.props.onValueChange(true);
    });
    await settle();

    await vi.waitFor(() => expect(automationHttp.mock.calls.map(([url, init]) => ({ path: url.pathname, method: init?.method ?? 'GET' })))
      .toContainEqual({ path: '/v3/automations/set-1', method: 'PUT' }));
    await vi.waitFor(() => expect(screen.findByTestId(`${ROW}-switch`)?.props.value).toBe(true));
    const mutation = automationHttp.mock.calls.find(([url, init]) => url.pathname === '/v3/automations/set-1' && init?.method === 'PUT');
    expect(mutation).toBeDefined();
    expect(AutomationDefinitionReconcileRequestSchema.parse(JSON.parse(String(mutation?.[1]?.body)))).toMatchObject({
      expectedTemplateVersion: 4,
      triggers: [{ kind: 'existing', triggerId: 'trig-1', expectedRevision: 1, enabled: true },
        { kind: 'existing', triggerId: 'trig-2', expectedRevision: 1 }],
    });
    expect(rows[0]?.assignments).toEqual([{ machineId: 'machine-a', enabled: true, priority: 0, updatedAt: 1 }]);
    expect(rows[0]?.enabled).toBe(true);
    expect(getStorage().getState().automations).toBe(automationsBefore);
    expect(screen.findByTestId('subject-triggers:set-1:trig-2-switch')?.props.value).toBe(true);
  });

  it('stays on the Info page with its section and a way to add the first automation', async () => {
    answer([]);
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    await vi.waitFor(() => expect(screen.findByTestId('subject-triggers')).not.toBeNull());
    expect(screen.findByTestId('subject-triggers-add')).not.toBeNull();
  });

  it('draws no "Writes here" heading while nothing writes into this session, loading or loaded', async () => {
    const { resetWorkflowLibraryReadsForTests } = await import('@/components/workflows/library/workflowLibraryReads');
    resetWorkflowLibraryReadsForTests();
    const runList: { finish: (() => void) | null } = { finish: null };
    answer([]);
    finishRunRead = () => new Promise<void>((resolve) => { runList.finish = resolve; });
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    // Still reading: a section that may not exist holds no skeleton that later collapses.
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();
    await act(async () => {
      runList.finish?.();
    });
    await settle();
    expect(screen.findByTestId('session-work-writes-here')).toBeNull();
  });

  it('opens "When this turn finishes…" in the sentence builder bound to that exact turn', async () => {
    answer([]);
    routeParams.current = {
      sourceSessionId: 'session-1',
      sourceTurnId: 'turn-7',
      sourceServerId: home.serverId,
      sessionLifecycleEvents: 'parentTurnCompleted',
    };
    const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
    await settle();
    await vi.waitFor(() => expect(screen.findByTestId('workflow-builder')).not.toBeNull());
    const { router } = await import('expo-router');
    await screen.pressByTestIdAsync('workflow-builder-open-editor');
    const entry = vi.mocked(router.push).mock.calls.at(-1)?.[0];
    if (typeof entry !== 'object' || entry === null || !('params' in entry)) throw new Error('Expected the sentence editor route');
    const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
    const seed = readWorkflowDefinitionDraftSeed(String(entry.params?.definitionDraftSeedId));
    expect(seed).toMatchObject({ lifetimeSession: { sessionId: 'session-1' }, triggers: { rows: [expect.objectContaining({
      trigger: expect.objectContaining({ kind: 'sessionLifecycle',
        subject: { kind: 'session', serverId: 'srv_session_habit_home', sessionId: 'session-1' },
        policy: { kind: 'currentTurn', sourceTurnId: 'turn-7' } }) })] } });
  });
  describe('when the session Machine is offline', () => {
    function failReads() {
      failAutomationReads = true;
    }

    it('retains Automation rows without repeating the unavailable starts notice below the Machine notice', async () => {
      const { installSessionActionRpcBoundary } = await import('@/dev/testkit/harness/sessionActionRpcBoundary');
      const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
      const { RPC_ERROR_CODES, RPC_METHODS } = await import('@happier-dev/protocol/rpc');
      await disconnectActiveServerConnection();
      installSessionActionRpcBoundary(request => {
        if (!request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
          throw new Error(`Unexpected fixture RPC ${request.method}`);
        }
        return null;
      }, { transformAcknowledgement: () => ({ ok: false, error: 'Machine unavailable', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }) });
      await restoreConnectionToActiveServer(workflowHttp.credentials);
      await seedSessionMachine(false);
      answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
      const host = (offlineStatedAbove = false) => <PluginSurfaceFocusEligibilityProvider active>
        <SessionInfoSetup sessionId="session-1" offlineStatedAbove={offlineStatedAbove} />
      </PluginSurfaceFocusEligibilityProvider>;
      const screen = await renderScreen(host());
      await settle();
      await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-starts-unavailable'), screen.getTextContent()).not.toBeNull());
      await screen.update(host(true));
      expect(screen.findByTestId(`${ROW}-switch`)?.props.value).toBe(true);
      expect(screen.findByTestId('subject-triggers-starts-unavailable')).toBeNull();
    });

    it('keeps a settled Habit read failure and its retry visible even when the Machine is offline', async () => {
      await seedSessionMachine(false);
      failReads();
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      // DIAG-HABITS: Machine reachability does not turn a settled Account read failure into loading.
      await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-read-retry')).not.toBeNull());
      expect(screen.findByTestId('subject-triggers-read')).not.toBeNull();
    });

    it('still says a failed read when the Machine is reachable', async () => {
      await seedSessionMachine(true);
      failReads();
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-read')).not.toBeNull());
    });

    it('reads again by itself when the offline Machine returns', async () => {
      await seedSessionMachine(false);
      failReads();
      const screen = await renderScreen(<SessionInfoSetup sessionId="session-1" />);
      await settle();
      await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-read-retry')).not.toBeNull());
      expect(screen.findByTestId(`${ROW}-switch`)).toBeNull();
      answer([triggerSet([lifecycleTrigger('trig-1', true)])]);
      await seedSessionMachine(true);
      await settle();
      await vi.waitFor(() => expect(screen.findByTestId(`${ROW}-switch`)).not.toBeNull());
    });
  });

});
