import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkflowTriggerListResultV1Schema, WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { readWorkflowChildSession, waitForWorkflowChildSession } from '../../src/testkit/workflowChildSession';
import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { createTempDirHandle, type TempDirHandle } from '../../src/testkit/fs/tempDir';
import { createWorkflowRunStorageClient } from '../../../../apps/cli/src/daemon/workflows/workflowRunStorageClient';
import { buildWorkflowActionContext } from '../../../../apps/cli/src/daemon/workflows/workflowActionContext';

let fixture: TeamSetupFFixture | undefined;
let workspace: TempDirHandle | undefined;
afterEach(async () => {
  try { await fixture?.stop(); } finally {
    fixture = undefined;
    await workspace?.cleanup();
    workspace = undefined;
  }
}, 0);

type QueryTrace = Readonly<{ requestId: string; spanId: number; parentSpanId?: number; phase: string }>;
function readQueryTraces(log: string): QueryTrace[] {
  return log.split('\n').flatMap(line => {
    let row: unknown;
    try { row = JSON.parse(line); } catch { return []; }
    if (typeof row !== 'object' || row === null || !('module' in row) || row.module !== 'web-latency'
      || !('phase' in row) || typeof row.phase !== 'string'
      || !('requestId' in row) || typeof row.requestId !== 'string'
      || !('spanId' in row) || typeof row.spanId !== 'number') return [];
    return [{ requestId: row.requestId, spanId: row.spanId, phase: row.phase,
      ...('parentSpanId' in row && typeof row.parentSpanId === 'number' ? { parentSpanId: row.parentSpanId } : {}) }];
  });
}

it('P01.F2 Session scopes and habit lifetime', async () => {
  const run = createRunDirs({ runLabel: 'automations-p01-f2' });
  // Sessions start outside any repository before the explicit folder Project is attached.
  const workspaceRoot = await createTempDirHandle({ prefix: 'automations-p01-f2-workspace-' });
  workspace = workspaceRoot;
  fixture = await startTeamSetupFFixture({ testDir: run.testDir('scopes-and-lifetime'),
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_WEB_LATENCY_TRACE: '1',
      HAPPIER_SERVER_LOG_LEVEL: 'trace', HAPPIER_SERVER_LOG_FORMAT: 'json' } });
  const actor = await fixture.createAccount('habit-owner');
  const machine = await fixture.enrollDaemon(actor, {
    workspaceDir: join(workspaceRoot.path, 'habit-owner', 'workspace'),
    env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_OHMYPI_PATH: resolve(repoRootDir(), 'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs'),
      PI_CODING_AGENT_DIR: join(workspaceRoot.path, 'ohmypi'),
      GEMINI_API_KEY: 'e2e-fake-gemini-api-key',
    } })
    .catch(cause => { throw new Error('F2 prerequisite daemon enrollment failed', { cause }); });
  const person = (actionId: ActionId, input: unknown, context: Parameters<typeof actor.execute>[2] = {}) =>
    actor.executeAsPerson(actionId, input, {
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
      presentUserConfirmation: { actionId }, ...context,
    });
  const addContinuation = (sessionId: string) =>
    person('workflow.trigger.add', { lifetimeSession: { sessionId },
      target: { kind: 'workflow', ref: 'builtin:keep-going' },
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'sessionLifecycle', enabled: true,
        subject: { kind: 'session', serverId: fixture!.serverId, sessionId },
        events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' } },
    });
  const openProject = async () => {
    const opened = await person('projects.open', { ...machine.target,
      source: { kind: 'folder', path: machine.workspaceDir }, materialization: { kind: 'attach' } },
    { presentUserConfirmation: { actionId: 'projects.open' } })
      .catch(cause => { throw new Error('F2 prerequisite projects.open failed', { cause }); });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) throw new Error(`Project fixture refused (${opened.errorCode})`);
    const project = OpenProjectResultV1Schema.parse(opened.result);
    if (project.kind !== 'opened' || !project.facts?.projectKey) {
      throw new Error(`F2 prerequisite accepted Project identity unavailable: ${JSON.stringify(project)}`);
    }
    return project.facts.projectKey;
  };
  const headers = { Authorization: `Bearer ${actor.credentials.token}`,
    ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
  const readSession = async (sessionId: string) => {
    const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v2/sessions/${encodeURIComponent(sessionId)}`, { headers });
    expect(response.status).toBe(200);
    return V2SessionByIdResponseSchema.parse(response.data).session;
  };
  const lifetime = await fixture.assertKnownGoodSessionControl(actor, machine);
  const watched = await fixture.assertKnownGoodSessionControl(actor, machine);
  const sessionSubject = { kind: 'session', serverId: fixture.serverId, sessionId: watched.sessionId } as const;
  type Scope = Readonly<{ name: string; subject?: AutomationSubjectV1;
    policy: { kind: 'firstMatch' } | { kind: 'nextMatches'; count: number } | { kind: 'everyMatch' } }>;
  const target = (name: string) => ({ kind: 'inline', definition: { version: 1,
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    blocks: [{ kind: 'step', id: 'review', document: { text: `Review the archived ${name} Session.`, references: [], attachments: [] },
      input: [], result: { kind: 'text' } }],
  } });
  const saved: ReturnType<typeof WorkflowTriggerWriteResultV1Schema.parse>[] = [];
  const addScope = async (scope: Scope) => {
    const linked = await person('workflow.trigger.add', {
      lifetimeSession: { sessionId: lifetime.sessionId },
      target: target(scope.name),
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'sessionLifecycle', enabled: true,
        ...(scope.subject ? { subject: scope.subject } : {}), events: ['sessionArchived'], policy: scope.policy },
    });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(`Habit authoring refused (${linked.errorCode})`);
    const value = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    expect(value.set.scopeSessionId).toBe(lifetime.sessionId);
    saved.push(value);
  };
  // Reach the Session contract before arranging the other resource contexts.
  const sessionScope = { name: 'Session', subject: sessionSubject, policy: { kind: 'firstMatch' } } as const;
  await addScope(sessionScope);
  const projectKey = await openProject();
  const scopes: readonly Scope[] = [sessionScope,
    { name: 'Project', subject: { kind: 'project', serverId: fixture.serverId, projectKey },
      policy: { kind: 'nextMatches', count: 2 } },
    { name: 'Machine', subject: { kind: 'machine', ...machine.target }, policy: { kind: 'everyMatch' } },
    { name: 'Any', policy: { kind: 'firstMatch' } },
  ];
  let observedProjectKey: string | null | undefined;
  await waitFor(async () => {
    observedProjectKey = (await readSession(watched.sessionId)).projectKey;
    return observedProjectKey === projectKey;
  }, { context: 'The Session owner publishes its accepted Project key before Project matching' })
    .catch(cause => { throw new Error(`F2 Session Project association unavailable: ${JSON.stringify({
      expectedProjectKey: projectKey, observedProjectKey,
    })}`, { cause }); });
  expect(await addContinuation(watched.sessionId)).toMatchObject({ ok: false, errorCode: 'native_goal_owner' });
  for (const scope of scopes.slice(1)) await addScope(scope);
  for (const scope of scopes.slice(1)) {
    const invalid = await person('workflow.trigger.add', {
      lifetimeSession: { sessionId: lifetime.sessionId }, target: target('invalid current turn'),
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'sessionLifecycle', enabled: true, ...(scope.subject ? { subject: scope.subject } : {}),
        events: ['parentTurnCompleted'], policy: { kind: 'currentTurn', sourceTurnId: 'not-an-admitted-turn' } },
    });
    expect(invalid).toMatchObject({ ok: false, errorCode: 'invalid_input',
      details: { code: 'session_trigger_current_turn_requires_session' } });
  }
  expect(await actor.execute('session.message.send', { sessionId: lifetime.sessionId,
    message: 'lsl 1 1000 1000' })).toMatchObject({ ok: true });
  let sourceTurnId: string | undefined;
  await waitFor(async () => {
    const row = await readSession(lifetime.sessionId);
    sourceTurnId = row.latestTurnStatus === 'in_progress' ? row.latestTurnId ?? undefined : undefined;
    return sourceTurnId !== undefined;
  }, { context: 'The external fake Agent keeps an admitted parent turn active for exact-turn authoring' });
  const current = await person('workflow.trigger.add', {
    lifetimeSession: { sessionId: lifetime.sessionId }, target: target('current turn'),
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'sessionLifecycle', enabled: true,
      subject: { kind: 'session', serverId: fixture.serverId, sessionId: lifetime.sessionId },
      events: ['parentTurnCancelled'], policy: { kind: 'currentTurn', sourceTurnId } },
  });
  expect(current.ok, JSON.stringify(current)).toBe(true);
  if (!current.ok) throw new Error(`Current-turn habit refused (${current.errorCode})`);
  const currentSaved = WorkflowTriggerWriteResultV1Schema.parse(current.result);
  const cleanupDefinitionId = randomUUID();
  const cleanupDefinition = await person('workflow.definition.create', {
    definitionId: cleanupDefinitionId, metadata: { title: 'Detach the firing habit' },
    definition: { version: 1, defaults: {},
      inputs: [{ name: 'automationId', valueType: 'string', required: true },
        { name: 'triggerId', valueType: 'string', required: true }],
      blocks: [{ kind: 'action', id: 'detach', actionId: 'workflow.trigger.remove', input: {
        automationId: { kind: 'input', name: 'automationId' }, triggerId: { kind: 'input', name: 'triggerId' },
      } }],
    },
  });
  expect(cleanupDefinition.ok, JSON.stringify(cleanupDefinition)).toBe(true);
  if (!cleanupDefinition.ok) throw new Error(`Cleanup definition refused (${cleanupDefinition.errorCode})`);
  // Saved Workflow registrations share their set; ordinary inline additions remain independent.
  const cleanup = await person('workflow.trigger.add', {
    lifetimeSession: { sessionId: lifetime.sessionId }, workflow: cleanupDefinitionId,
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'sessionLifecycle', enabled: true, subject: sessionSubject,
      events: ['sessionArchived'], policy: { kind: 'everyMatch' } },
  });
  expect(cleanup.ok, JSON.stringify(cleanup)).toBe(true);
  if (!cleanup.ok) throw new Error(`Self-detaching habit refused (${cleanup.errorCode})`);
  const cleanupSaved = WorkflowTriggerWriteResultV1Schema.parse(cleanup.result);
  const cleanupSibling = await person('workflow.trigger.add', {
    lifetimeSession: { sessionId: lifetime.sessionId }, workflow: cleanupDefinitionId,
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'sessionLifecycle', enabled: true,
      subject: { kind: 'session', serverId: fixture.serverId, sessionId: lifetime.sessionId },
      events: ['sessionArchived'], policy: { kind: 'everyMatch' } },
  });
  expect(cleanupSibling.ok, JSON.stringify(cleanupSibling)).toBe(true);
  if (!cleanupSibling.ok) throw new Error(`Sibling habit refused (${cleanupSibling.errorCode})`);
  const siblingSaved = WorkflowTriggerWriteResultV1Schema.parse(cleanupSibling.result);
  expect(siblingSaved.set.automationId, 'Identical habit context retains its existing saved owner')
    .toBe(cleanupSaved.set.automationId);
  // The occurrence supplies triggerId; this fixture supplies the saved owner's
  // automationId through the ordinary authored input constants.
  expect(await person('workflow.trigger.update', {
    automationId: cleanupSaved.set.automationId, expectedRevision: siblingSaved.set.revision,
    patch: { inputs: { automationId: cleanupSaved.set.automationId } },
  })).toMatchObject({ ok: true });
  const neighborLifetime = await fixture.assertKnownGoodSessionControl(actor, machine);
  const neighbor = await person('workflow.trigger.add', {
    lifetimeSession: { sessionId: neighborLifetime.sessionId }, target: target('another lifetime'),
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'sessionLifecycle', enabled: true, subject: sessionSubject,
      events: ['sessionArchived'], policy: { kind: 'everyMatch' } },
  });
  expect(neighbor.ok, JSON.stringify(neighbor)).toBe(true);
  if (!neighbor.ok) throw new Error(`Independent lifetime habit refused (${neighbor.errorCode})`);
  const neighborSaved = WorkflowTriggerWriteResultV1Schema.parse(neighbor.result);
  const listed = await actor.execute('workflow.trigger.list', { lifetimeSession: { sessionId: lifetime.sessionId } });
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  if (!listed.ok) throw new Error(`Habit list refused (${listed.errorCode})`);
  expect(WorkflowTriggerListResultV1Schema.parse(listed.result).sets.map(set => set.automationId))
    .toEqual(expect.arrayContaining(saved.map(value => value.set.automationId)));
  expect(WorkflowTriggerListResultV1Schema.parse(listed.result).sets.map(set => set.automationId))
    .not.toContain(neighborSaved.set.automationId);
  const other = await fixture.assertKnownGoodSessionControl(actor, machine);
  const secondMachine = await fixture.enrollDaemon({ ...actor, name: 'habit-second-machine' },
    { workspaceDir: join(workspaceRoot.path, 'habit-second-machine', 'workspace'),
      env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const remote = await fixture.assertKnownGoodSessionControl(actor, secondMachine);
  const outsideDirectory = join(machine.workspaceDir, '..', 'other-project');
  await mkdir(outsideDirectory, { recursive: true });
  const outside = await fixture.assertKnownGoodSessionControl(actor, { ...machine, workspaceDir: outsideDirectory });
  const readAutomationRuns = async (automationId: string) => {
    const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
      headers,
    });
    expect(response.status).toBe(200);
    return AutomationV3RunListResponseSchema.parse(response.data).runs;
  };
  const readRuns = (index: number) => readAutomationRuns(saved[index]!.set.automationId);
  expect(await actor.execute('session.turn.cancel', { sessionId: lifetime.sessionId })).toMatchObject({ ok: true });
  await waitFor(async () => (await readAutomationRuns(currentSaved.set.automationId)).length === 1,
    { context: 'The exact current parent turn consumes its one occurrence' });
  expect((await readAutomationRuns(currentSaved.set.automationId))[0]!.cause).toMatchObject({
    kind: 'trigger', triggerKind: 'sessionLifecycle', evidence: { event: 'parentTurnCancelled', sourceTurnId },
  });
  expect(await readRuns(0)).toEqual([]);
  expect(await actor.execute('session.archive', { sessionId: remote.sessionId })).toMatchObject({ ok: true });
  await waitFor(async () => (await readRuns(3)).length === 1,
    { context: 'Omitted subject matches a Session on the other Machine' });
  expect(await readRuns(0)).toEqual([]);
  expect(await readRuns(1)).toEqual([]);
  expect(await readRuns(2), 'A Machine subject cannot match a different source Machine').toEqual([]);
  expect(await actor.execute('session.archive', { sessionId: outside.sessionId })).toMatchObject({ ok: true });
  await waitFor(async () => (await readRuns(2)).length === 1,
    { context: 'Machine scope matches another directory on the same Machine' });
  expect(await readRuns(1), 'A Project subject cannot infer membership from Machine placement').toEqual([]);
  expect(await actor.execute('session.archive', { sessionId: other.sessionId })).toMatchObject({ ok: true });
  await waitFor(async () => (await readRuns(1)).length === 1 && (await readRuns(2)).length === 2 && (await readRuns(3)).length === 1,
    { context: 'Project/Machine/any scopes match the other Session' });
  expect(await readRuns(0), 'A Session subject cannot match another Session in its Project').toEqual([]);
  const traceOffset = (await readFile(fixture.server.proc.stdoutPath, 'utf8')).length;
  expect(await actor.execute('session.archive', { sessionId: watched.sessionId })).toMatchObject({ ok: true });
  let observedRuns: Awaited<ReturnType<typeof readRuns>> = [];
  try {
    await waitForWorkflowChildSession(async () => {
      const runs = await readRuns(0);
      observedRuns = runs;
      expect(runs.length).toBeLessThanOrEqual(1);
      if (runs.length !== 1) return false;
      return await readWorkflowChildSession({ execute: actor.execute, serverBaseUrl: fixture!.server.baseUrl,
        token: actor.credentials.token, runId: runs[0]!.id, blockId: 'review' }) !== null;
    }, 'A habit attached to A starts one Workflow only when B is archived');
  } catch (cause) {
    const runs = observedRuns.map(({ id, state, workflowRunState, attempt, errorCode,
      executionDispatchState, producedSessionId }) => ({ id, state, workflowRunState, attempt, errorCode,
      executionDispatchState, producedSessionId }));
    const invocations = await Promise.all(observedRuns.map(async run => {
      try {
        const listed = await actor.execute('workflow.run.invocations.list', { runId: run.id, includeContent: true });
        if (!listed.ok) return { runId: run.id, errorCode: listed.errorCode };
        const page = WorkflowInvocationListResultV1Schema.parse(listed.result);
        return { runId: run.id, nextCursor: page.nextCursor, rows: page.invocationDetails?.map(({ index, progress }) => ({
          id: index.id, lifecycle: index.lifecycle, blockId: progress.invocationPath.blockId,
          blockKind: progress.blockKind, reasonCode: progress.reason?.code,
          execution: progress.execution && { kind: progress.execution.kind,
            ...('sessionId' in progress.execution ? { sessionId: progress.execution.sessionId } : {}) },
        })) };
      } catch (error) {
        return { runId: run.id, diagnosticError: error instanceof Error ? error.name : 'unknown' };
      }
    }));
    throw new Error(`F2 exact-Session habit/child did not settle; observedRuns=${JSON.stringify(runs)}; invocations=${JSON.stringify(invocations)}`, { cause });
  }
  expect((await readRuns(0))[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: saved[0]!.triggerId,
    triggerKind: 'sessionLifecycle', evidence: { sourceSessionId: watched.sessionId, event: 'sessionArchived' } });
  await waitFor(async () => (await readRuns(1)).length === 2 && (await readRuns(2)).length === 3,
    { context: 'Next and every match policies consume matching occurrences' });
  expect(await readRuns(3), 'First-match scope stays consumed').toHaveLength(1);
  await waitFor(async () => (await readAutomationRuns(cleanupSaved.set.automationId))[0]?.state === 'succeeded',
    { context: 'Host-stamped exact-firing cleanup retains consent and finishes the ordinary Workflow Run' });
  await waitFor(async () => (await readAutomationRuns(neighborSaved.set.automationId)).length === 1,
    { context: 'A second lifetime independently retains its firing for the same source occurrence' });
  const cleanupRun = (await readAutomationRuns(cleanupSaved.set.automationId))[0]!;
  // Consume the real admitted Run, as the daemon does; a Run id alone is not a Workflow caller.
  const storedCleanup = await createWorkflowRunStorageClient({ token: actor.credentials.token,
    serverHttpBaseUrl: fixture.server.baseUrl }).execute({ operation: 'get', runId: cleanupRun.id });
  if (typeof storedCleanup !== 'object' || storedCleanup === null
    || !('keyCensus' in storedCleanup) || !('acceptedEnvelope' in storedCleanup)) {
    throw new Error('Accepted cleanup Run snapshot unavailable');
  }
  const cleanupCensus = WorkflowRunRecipientCensusResponseV1Schema.parse(storedCleanup.keyCensus);
  if (cleanupCensus.ownerAccountCurrentness.mode !== 'e2ee') throw new Error('Expected E2EE cleanup Run');
  const cleanupEncryption = actor.credentials.encryption;
  if (cleanupEncryption?.type !== 'dataKey') throw new Error('Expected the fixture cleanup Run data key');
  const cleanupMaterial = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: cleanupEncryption, dataKeyPublicKey: cleanupEncryption.publicKey });
  const cleanupKey = resolveWorkflowRunDataKeyV1({ encryption: {
    witness: { ...cleanupCensus.ownerAccountCurrentness, mode: cleanupCensus.ownerAccountCurrentness.mode },
    material: cleanupMaterial }, census: cleanupCensus });
  const cleanupEnvelope = parseWorkflowStoredContentEnvelopeV1(storedCleanup.acceptedEnvelope);
  if (cleanupKey.kind !== 'available' || !cleanupEnvelope) throw new Error('Accepted cleanup Run key unavailable');
  const acceptedCleanup = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...cleanupKey.encryption.runCrypto,
    binding: { v: 1, purpose: 'accepted_snapshot', accountId: cleanupCensus.ownerAccountId, runId: cleanupRun.id },
    envelope: cleanupEnvelope });
  if (acceptedCleanup.kind !== 'available') throw new Error('Accepted cleanup Run content unavailable');
  const cleanupContext = { ...buildWorkflowActionContext({ runId: cleanupRun.id,
    source: acceptedCleanup.content.source, authorization: acceptedCleanup.content.authorization,
    origin: acceptedCleanup.content.origin, workspace: acceptedCleanup.content.workspaceTarget.project }),
    surface: 'mcp' as const };
  const unrelatedRunRemoval = await actor.execute('workflow.trigger.remove', {
    automationId: siblingSaved.set.automationId, triggerId: siblingSaved.triggerId,
  }, cleanupContext);
  expect(unrelatedRunRemoval, JSON.stringify(unrelatedRunRemoval.ok ? { ok: true } : {
    ok: false, errorCode: unrelatedRunRemoval.errorCode, failureCause: unrelatedRunRemoval.failureCause,
  })).toMatchObject({ ok: true, result: {
    kind: 'approval_request_created', actionId: 'workflow.trigger.remove', artifactId: expect.any(String),
  } });
  // Existing Prisma tracing observes the real PostgreSQL path, including grants and reservations.
  const traces = readQueryTraces((await readFile(fixture.server.proc.stdoutPath, 'utf8')).slice(traceOffset));
  const roots = traces.filter(row => row.phase === 'automation.sessionLifecycle.admit.sessionArchived');
  expect(roots, 'One committed archive occurrence enters the Session admission owner').toHaveLength(1);
  const root = roots[0]!;
  const requestTraces = traces.filter(row => row.requestId === root.requestId);
  const spans = new Map(requestTraces.map(row => [row.spanId, row]));
  let operation = root;
  while (operation.phase !== 'db.transaction.callback' && operation.parentSpanId !== undefined) {
    const parent = spans.get(operation.parentSpanId);
    if (!parent) break;
    operation = parent;
  }
  expect(operation.phase, 'Admission belongs to the archive transaction').toBe('db.transaction.callback');
  // Publication audience discovery can prepare candidates before admission
  // reuses it. Measure the containing transaction so that shared read is counted.
  const descendantsOf = (spanId: number) => {
    const descendants = new Set([spanId]);
    let previousSize: number;
    do {
      previousSize = descendants.size;
      for (const row of requestTraces) {
        if (row.parentSpanId !== undefined && descendants.has(row.parentSpanId)) descendants.add(row.spanId);
      }
    } while (descendants.size !== previousSize);
    return descendants;
  };
  const descendants = descendantsOf(operation.spanId);
  const queries = requestTraces.filter(row => descendants.has(row.spanId) && row.phase.startsWith('db.'));
  // Scoped-lock discovery and authoritative admission also read Trigger rows.
  // Only the candidate owner's query represents cross-scope selection cost.
  const candidateSpans = new Set(requestTraces.filter(row => descendants.has(row.spanId)
    && row.phase === 'automation.sessionLifecycle.candidates').map(row => row.spanId));
  expect(queries.filter(row => row.phase === 'db.AutomationTrigger.findMany'
    && row.parentSpanId !== undefined && candidateSpans.has(row.parentSpanId)),
    'One set-oriented candidate selection serves all four scopes').toHaveLength(1);
  // Archive/activity publication and the source projection have their own
  // audience censuses. Admission must not repeat its batch census per new Run.
  const admissionDescendants = descendantsOf(root.spanId);
  expect(queries.filter(row => admissionDescendants.has(row.spanId) && row.phase === 'db.SessionGrant.findMany').length,
    'The Session audience is resolved once, never once per matching trigger').toBeLessThanOrEqual(1);
  const reservations = requestTraces.filter(row => descendants.has(row.spanId)
    && row.phase === 'automation.sessionLifecycle.reserve');
  expect(reservations, 'Only the two bounded policies reserve an occurrence').toHaveLength(2);
  const reservationSpans = new Set(reservations.map(row => row.spanId));
  expect(queries.filter(row => row.phase === 'db.AutomationTrigger.updateMany'
    && row.parentSpanId !== undefined && reservationSpans.has(row.parentSpanId)),
    'Only the two bounded policies reserve an occurrence').toHaveLength(2);
  expect(queries.filter(row => row.phase === 'db.AutomationRun.create'),
    'The Session, Project, Machine, exact cleanup and independent lifetime each admit one Run').toHaveLength(5);
  const detached = await actor.execute('workflow.trigger.list', {
    lifetimeSession: { sessionId: lifetime.sessionId },
  });
  expect(detached.ok, JSON.stringify(detached)).toBe(true);
  if (!detached.ok) throw new Error(`Detached habit list refused (${detached.errorCode})`);
  expect(WorkflowTriggerListResultV1Schema.parse(detached.result).sets.find(set =>
    set.automationId === cleanupSaved.set.automationId)?.triggers).toEqual([
    expect.objectContaining({ id: siblingSaved.triggerId, enabled: true }),
  ]);
  expect(await readAutomationRuns(cleanupSaved.set.automationId), 'Self-detach preserves authoritative history').toHaveLength(1);
  const neighborListed = await actor.execute('workflow.trigger.list', {
    lifetimeSession: { sessionId: neighborLifetime.sessionId },
  });
  expect(neighborListed.ok, JSON.stringify(neighborListed)).toBe(true);
  if (!neighborListed.ok) throw new Error(`Independent lifetime list refused (${neighborListed.errorCode})`);
  expect(WorkflowTriggerListResultV1Schema.parse(neighborListed.result).sets.find(set =>
    set.automationId === neighborSaved.set.automationId)).toMatchObject({
    scopeSessionId: neighborLifetime.sessionId,
    triggers: expect.arrayContaining([expect.objectContaining({ id: neighborSaved.triggerId, enabled: true })]),
  });
  expect((await readAutomationRuns(neighborSaved.set.automationId))[0]!.cause).toMatchObject({
    kind: 'trigger', triggerId: neighborSaved.triggerId,
    triggerKind: 'sessionLifecycle', evidence: { sourceSessionId: watched.sessionId },
  });
  const consumedSet = WorkflowTriggerListResultV1Schema.parse(detached.result).sets.find(set =>
    set.automationId === saved[1]!.set.automationId)!;
  const edited = await person('workflow.trigger.update', {
    automationId: consumedSet.automationId, triggerId: saved[1]!.triggerId, expectedRevision: consumedSet.revision,
    patch: { trigger: { kind: 'sessionLifecycle', subject: { kind: 'machine', ...machine.target },
      events: ['sessionArchived'], policy: { kind: 'nextMatches', count: 2 } } },
  });
  expect(edited.ok, JSON.stringify(edited)).toBe(true);
  if (!edited.ok) throw new Error(`Consumed habit edit refused (${edited.errorCode})`);
  let consumed = WorkflowTriggerWriteResultV1Schema.parse(edited.result);
  expect(consumed.set.triggers.find(trigger => trigger.id === saved[1]!.triggerId))
    .toMatchObject({ kind: 'sessionLifecycle', remainingOccurrences: 0 });
  for (const enabled of [false, true]) {
    const toggled = await person('workflow.trigger.update', { automationId: consumed.set.automationId,
      expectedRevision: consumed.set.revision, patch: { enabled } });
    expect(toggled.ok, JSON.stringify(toggled)).toBe(true);
    if (!toggled.ok) throw new Error(`Consumed habit toggle refused (${toggled.errorCode})`);
    consumed = WorkflowTriggerWriteResultV1Schema.parse(toggled.result);
    expect(consumed.set.triggers.find(trigger => trigger.id === saved[1]!.triggerId))
      .toMatchObject({ kind: 'sessionLifecycle', remainingOccurrences: 0 });
  }
  const afterEdit = await fixture.assertKnownGoodSessionControl(actor, machine);
  expect(await actor.execute('session.archive', { sessionId: afterEdit.sessionId })).toMatchObject({ ok: true });
  expect(await readRuns(1), 'Editing the subject and re-enabling preserve consumed match counts').toHaveLength(2);
  expect(await readRuns(3), 'An exhausted omitted-subject habit remains consumed').toHaveLength(1);
  expect(await actor.execute('session.archive', { sessionId: watched.sessionId })).toMatchObject({ ok: true });
  expect(await readRuns(0), 'Replayed archive does not create a duplicate occurrence').toHaveLength(1);
  const publicRemoval = await actor.execute('workflow.trigger.remove', {
    automationId: saved[0]!.set.automationId, triggerId: saved[0]!.triggerId,
  }, { surface: 'mcp' });
  expect(publicRemoval).toMatchObject({ ok: true, result: {
    kind: 'approval_request_created', actionId: 'workflow.trigger.remove', artifactId: expect.any(String),
  } });
  expect(await actor.executeAsPerson('actions.policy.set', { actionId: 'workflow.trigger.remove',
    audience: 'mcp', mode: 'ask_first' })).toMatchObject({ ok: true });
  // The person client and retained Workflow caller are separate hosts. Read the
  // persisted choice through the caller's policy owner before exercising it.
  expect(await actor.execute('actions.policy.get', { actionId: 'workflow.trigger.remove',
    audience: 'mcp' })).toMatchObject({ ok: true, result: { mode: 'ask_first' } });
  const requiredCleanup = await actor.execute('workflow.trigger.remove', {
    automationId: cleanupSaved.set.automationId, triggerId: cleanupSaved.triggerId,
  }, cleanupContext);
  expect(requiredCleanup, JSON.stringify(requiredCleanup.ok ? { ok: true } : {
    ok: false, errorCode: requiredCleanup.errorCode, failureCause: requiredCleanup.failureCause,
  })).toMatchObject({ ok: true, result: {
    kind: 'approval_request_created', actionId: 'workflow.trigger.remove', artifactId: expect.any(String),
  } });
  expect(await actor.executeAsPerson('actions.policy.set', { actionId: 'workflow.trigger.remove',
    audience: 'mcp', mode: 'allowed' })).toMatchObject({ ok: true });
  expect(await actor.execute('actions.policy.get', { actionId: 'workflow.trigger.remove',
    audience: 'mcp' })).toMatchObject({ ok: true, result: { mode: 'allowed' } });
  expect(await actor.execute('workflow.trigger.remove', { automationId: saved[0]!.set.automationId,
    triggerId: saved[0]!.triggerId }, { surface: 'mcp' })).toMatchObject({ ok: true });
  expect(await actor.executeAsPerson('actions.policy.reset', { actionId: 'workflow.trigger.remove',
    audience: 'mcp' })).toMatchObject({ ok: true });
  expect(await actor.execute('workflow.trigger.remove', { automationId: saved[0]!.set.automationId,
    triggerId: saved[0]!.triggerId }, { presentUserConfirmation: { actionId: 'workflow.trigger.remove' } })).toMatchObject({ ok: true });
  expect(await readRuns(0), 'Removing a habit retains its authoritative Run history').toHaveLength(1);
  // Keep going is intentionally unavailable on native Goal owners. Its two
  // lifetimes use a real ACP runtime independently of the cancellation journey.
  const continuationAgent = {
    target: { kind: 'agent', identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' } },
    prompt: 'ACP_STUB_USAGE_UPDATE=f2-continuation',
    assistantSubstring: 'ACP_STUB_USAGE_UPDATE_DONE f2-continuation',
  } as const;
  const goalLifetime = await fixture.assertKnownGoodSessionControl(actor, machine, continuationAgent);
  const goalNeighborLifetime = await fixture.assertKnownGoodSessionControl(actor, machine, continuationAgent);
  const ordinaryGoalHabit = await person('workflow.trigger.add', {
    lifetimeSession: { sessionId: goalLifetime.sessionId }, target: target('ordinary Goal-clear habit'),
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'sessionLifecycle', enabled: true,
      subject: { kind: 'session', serverId: fixture.serverId, sessionId: goalLifetime.sessionId },
      events: ['sessionArchived'], policy: { kind: 'everyMatch' } },
  });
  expect(ordinaryGoalHabit.ok, JSON.stringify(ordinaryGoalHabit)).toBe(true);
  if (!ordinaryGoalHabit.ok) throw new Error(`Ordinary Goal-clear habit refused (${ordinaryGoalHabit.errorCode})`);
  const ordinaryGoalSaved = WorkflowTriggerWriteResultV1Schema.parse(ordinaryGoalHabit.result);
  const attachContinuation = async (sessionId: string) => {
    const added = await addContinuation(sessionId);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    if (!added.ok) throw new Error(`Continuation habit refused (${added.errorCode})`);
    return WorkflowTriggerWriteResultV1Schema.parse(added.result);
  };
  const continuation = await attachContinuation(goalLifetime.sessionId);
  const neighborContinuation = await attachContinuation(goalNeighborLifetime.sessionId);
  expect(await actor.execute('session.goal.clear', { sessionId: goalLifetime.sessionId },
    { presentUserConfirmation: { actionId: 'session.goal.clear' } })).toMatchObject({ ok: true });
  const readLifetimeSets = async (sessionId: string) => {
    const result = await actor.execute('workflow.trigger.list', { lifetimeSession: { sessionId } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(`Goal-clear habit list refused (${result.errorCode})`);
    return WorkflowTriggerListResultV1Schema.parse(result.result).sets;
  };
  const afterGoalClear = await readLifetimeSets(goalLifetime.sessionId);
  expect(afterGoalClear.find(set => set.automationId === continuation.set.automationId)?.triggers).toEqual([]);
  expect(afterGoalClear.find(set => set.automationId === ordinaryGoalSaved.set.automationId)?.triggers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: ordinaryGoalSaved.triggerId, enabled: true })]));
  expect((await readLifetimeSets(lifetime.sessionId)).find(set => set.automationId === saved[2]!.set.automationId)?.triggers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: saved[2]!.triggerId, enabled: true })]));
  expect((await readLifetimeSets(goalNeighborLifetime.sessionId)).find(set =>
    set.automationId === neighborContinuation.set.automationId)?.triggers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: neighborContinuation.triggerId, enabled: true })]));
}, 0);
