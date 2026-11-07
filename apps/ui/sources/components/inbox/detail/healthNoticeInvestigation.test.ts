import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { MachineServiceIdentityV1Schema } from '@happier-dev/protocol';
import { TriageSessionHandoffResultV1Schema } from '@happier-dev/triage-protocol/v1';

import { renderHook } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountNoticeArtifactFixture, createServiceHealthNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { readNoticeInvestigationSubject, readHealthNoticeInvestigationOutcome, useHealthNoticeInvestigate } from './healthNoticeInvestigation';

const scope = { serverId: 'server-a', accountId: 'account-a' };
const investigate = {
  configuredActionId: 'investigate',
  sessionChoice: { kind: 'configured' },
  agentChoice: { kind: 'configured' },
  delivery: 'configured',
} as const;

// The contributed plugin invocation is the realm transport boundary: UI front door, Action
// parsing/admission and the notice investigation owner stay real beneath it.
async function press(input: Readonly<{ choices: unknown; run?: unknown }>) {
  const calls: string[] = [];
  const executor = createActionExecutor(
    createActionExecutorBoundaryFixture({
      invokeContributedAction: async (request) => {
        calls.push(request.action.localId);
        return {
          ok: true,
          result:
            request.action.localId === 'actions/read-v1'
              ? input.choices
              : input.run,
        };
      },
    }),
  );
  const investigation = createAccountNoticeInvestigation({
    scope,
    isCurrent: () => true,
    execute: createFrontDoorActionExecute(executor),
  });
  const artifact = createServiceHealthNoticeArtifactFixture(scope.serverId);
  const entry = {
    artifact,
    header: readAccountNoticeArtifactHeader(artifact, scope.accountId)!,
  };
  const bound = {
    readChoices: (options: Parameters<typeof investigation.readChoices>[1]) => investigation.readChoices(entry, options),
    resume: (options: { signal: AbortSignal }) => investigation.resume(entry, options),
    run: (selection: Parameters<typeof investigation.run>[1], options: Parameters<typeof investigation.run>[2]) => investigation.run(entry, selection, options),
  };
  const hook = await renderHook(() => useHealthNoticeInvestigate(bound));
  expect(calls).toEqual([]);
  await act(async () => {
    await hook.getCurrent().investigate();
  });
  const { outcome, pending } = hook.getCurrent();
  await hook.unmount();
  return { calls, outcome, pending };
}

const offered = {
  v: 1,
  kind: 'choices',
  defaultActionId: 'investigate',
  actions: [{ label: 'Investigate', selection: investigate }],
};

describe('useHealthNoticeInvestigate', () => {
  it('exposes a rejected input reason without losing the known Session handoff or retrying', async () => {
    const handoff = { kind: 'sendResult', session: { serverId: scope.serverId, sessionId: 'diagnosis' },
      result: { status: 'rejected', code: 'session_input_target_unavailable' } } as const;
    const result = await press({ choices: offered, run: { v: 1, handoff } });
    expect(result.outcome).toEqual({ kind: 'unavailable', code: 'session_input_target_unavailable', handoff });
    expect(result.pending).toBe(false);
    // One choice read and one invocation; a refused input must not trigger another send.
    expect(result.calls).toHaveLength(2);
  });

  it('retains the exact Session handoff for outcome links without calling it a finding', () => {
    const handoff = { kind: 'composed', destination: { kind: 'existing', session: { serverId: scope.serverId, sessionId: 'diagnosis' } } } as const;
    expect(readHealthNoticeInvestigationOutcome({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'started', handoff });
  });
  it('keeps a durably admitted input started while its Session is still starting', () => {
    const handoff = { kind: 'sendResult', session: { serverId: scope.serverId, sessionId: 'diagnosis' },
      result: { status: 'accepted', localId: 'receipt-input' } } as const;
    expect(readHealthNoticeInvestigationOutcome({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'started', handoff });
  });
  it.each([
    { kind: 'entryExecution', status: 'bulk' },
    { kind: 'sendResult', session: { serverId: scope.serverId, sessionId: 'diagnosis' },
      result: { kind: 'fanout', results: [{ target: { serverId: scope.serverId, sessionId: 'diagnosis' },
        result: { ok: true, result: { status: 'rejected', code: 'session_input_target_unavailable' } } }] } },
  ])('does not claim an exact notice investigation started from an unrelated result %#', value => {
    // Entry batches and selector fanout are valid shared protocol results, but the notice
    // invokes one non-entry handoff to one exact Session.
    const handoff = TriageSessionHandoffResultV1Schema.parse(value);
    expect(readHealthNoticeInvestigationOutcome({ ok: true, result: { v: 1, handoff } }))
      .toEqual({ kind: 'unavailable', code: 'invalid_result' });
  });
  it.each([{ phase: 'create', recoverable: true }, { phase: 'send', recoverable: true },
    { phase: 'create', recoverable: false }] as const)(
    'resumes the original configured operation after an uncertain $phase reply (recovery=$recoverable)', async ({ phase, recoverable }) => {
    const requests: unknown[] = [];
    let choiceReads = 0;
    let current = true;
    // Recovery is opaque to the notice caller. Only Triage interprets its custody;
    // the contributed Action transport boundary echoes it back on continuation.
    let recovery: unknown;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      invokeContributedAction: async request => {
        if (request.action.localId === 'actions/read-v1') { choiceReads++; return { ok: true, result: offered }; }
        requests.push(request.input);
        if (requests.length === 1 && request.input && typeof request.input === 'object' && 'handoff' in request.input) {
          recovery = { entries: [], state: { kind: 'handoff', handoff: request.input.handoff,
            serverId: scope.serverId, uncertainPhase: phase,
            pending: phase === 'create' ? { phase: 'creationPending' }
              : { phase: 'openPending', sessionId: 'session-a', disposition: 'created' },
            input: { workspaceMode: 'reference_only', destination: { kind: 'new', creationKey: 'original-create',
              spawn: { executionTarget: { serverId: scope.serverId, machineId: 'chosen-machine' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } } },
              materialization: { kind: 'referenceOnly', directory: { kind: 'managed' } } },
              delivery: { kind: 'send', returnResult: true, idempotencyKey: 'original-send', attachments: [] } } } };
        }
        return { ok: true, result: requests.length === 1
          ? { v: 1, handoff: { kind: 'uncertain', phase, session: phase === 'create' ? null : { serverId: scope.serverId, sessionId: 'session-a' } },
            ...(recoverable ? { recovery } : {}) }
          : { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
      },
    }));
    const model = createAccountNoticeInvestigation({ scope, isCurrent: () => current,
      execute: createFrontDoorActionExecute(executor) });
    const artifact = createServiceHealthNoticeArtifactFixture(scope.serverId);
    const entry = { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
    const bound = {
      readChoices: (options: Parameters<typeof model.readChoices>[1]) => model.readChoices(entry, options),
      resume: (options: { signal: AbortSignal }) => model.resume(entry, options),
      run: (selection: Parameters<typeof model.run>[1], options: Parameters<typeof model.run>[2]) => model.run(entry, selection, options),
    };
    let hook = await renderHook(() => useHealthNoticeInvestigate(bound));
    const placement = { machine: { serverId: scope.serverId, machineId: 'chosen-machine' } };
    try {
      await act(async () => { await hook.getCurrent().investigateWithPlacement(placement); });
      expect(hook.getCurrent().outcome).toEqual({ kind: 'uncertain' });
      expect(hook.getCurrent().pending).toBe(false);
      await hook.unmount();
      const anotherArtifact = createServiceHealthNoticeArtifactFixture(scope.serverId, { id: 'second-notice' });
      await model.run({ artifact: anotherArtifact, header: readAccountNoticeArtifactHeader(anotherArtifact, scope.accountId)! }, investigate);
      hook = await renderHook(() => useHealthNoticeInvestigate(bound));
      await act(async () => { await hook.getCurrent().investigate(); });
      if (!recoverable) {
        expect(requests).toHaveLength(2);
        expect(choiceReads).toBe(1);
        expect(hook.getCurrent().outcome).toEqual({ kind: 'unavailable', code: 'action_outcome_unknown' });
        return;
      }
      expect(requests).toHaveLength(3);
      expect(requests[2]).toEqual({ ...requests[0] as object, resumeStart: recovery });
      expect(choiceReads).toBe(1);
      expect(hook.getCurrent().outcome).toEqual({ kind: 'started', handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } });
      current = false;
      await act(async () => { await hook.getCurrent().investigate(); });
      expect(requests).toHaveLength(3);
    } finally { await hook.unmount(); }
  });

  it('retains placement selection requirements and sends only the explicit Machine/workspace on retry', async () => {
    const calls: unknown[] = [];
    const choice = { kind: 'placement_choice_required', reason: 'controller_required', candidates: [], agents: [] };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      invokeContributedAction: async request => {
        if (request.action.localId === 'actions/read-v1') return { ok: true, result: offered };
        calls.push(request.input);
        return { ok: true, result: { v: 1, handoff: calls.length === 1
          ? choice
          : { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
      },
    }));
    const model = createAccountNoticeInvestigation({ scope, isCurrent: () => true,
      execute: createFrontDoorActionExecute(executor) });
    const artifact = createAccountNoticeArtifactFixture({ header: {
      source: { kind: 'host', topic: 'service_health', subject: {
        kind: 'environment', environmentId: 'environment', targetLinkId: 'runtime', condition: 'health',
      } },
      page: { kind: 'host', page: 'environment', targetLinkId: 'runtime',
        environment: { serverId: scope.serverId, projectSourceId: 'project', environmentId: 'environment' } },
      type: 'blocked', healthPhase: 'open',
    } });
    const entry = { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
    const bound = {
      readChoices: (options: Parameters<typeof model.readChoices>[1]) => model.readChoices(entry, options),
      resume: (options: { signal: AbortSignal }) => model.resume(entry, options),
      run: (selection: Parameters<typeof model.run>[1], options: Parameters<typeof model.run>[2]) => model.run(entry, selection, options),
    };
    const hook = await renderHook(() => useHealthNoticeInvestigate(bound));
    try {
      expect(calls).toHaveLength(0);
      await act(async () => { await hook.getCurrent().investigate(); });
      expect(hook.getCurrent().outcome).toEqual(choice);
      expect(calls).toEqual([expect.objectContaining({ handoff: expect.objectContaining({ context:
        expect.not.objectContaining({ machine: expect.anything(), workspace: expect.anything() }) }) })]);
      const placement = { machine: { serverId: scope.serverId, machineId: 'chosen-machine' },
        workspace: { serverId: scope.serverId, workspaceId: 'chosen-workspace', machineId: 'chosen-machine', rootPath: '/workspaces/project' } };
      const agentTargetKey = 'agent:happier.agent.codex/codex';
      await act(async () => { await hook.getCurrent().investigateWithPlacement({ ...placement, agentTargetKey }); });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ handoff: { context: { kind: 'healthAlert', ...placement,
        target: entry.header.page }, agentChoice: { kind: 'target', targetKey: agentTargetKey },
        evidence: [{ kind: 'alert', notice: { artifactId: artifact.id } }] } });
      expect(hook.getCurrent().outcome).toEqual({ kind: 'started', handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } });
    } finally { await hook.unmount(); }
  });

  it('runs the catalog default once; a composed draft needs nothing more from the notice', async () => {
    const result = await press({
      choices: offered,
      run: {
        v: 1,
        handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } },
      },
    });
    expect(result).toEqual({
      calls: ['actions/read-v1', 'sessions/run-configured-v1'],
      outcome: { kind: 'started', handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } },
      pending: false,
    });
  });

  it('never invents a selection when the catalog offers no default', async () => {
    const result = await press({
      choices: { ...offered, defaultActionId: null },
    });
    expect(result.calls).toEqual(['actions/read-v1']);
    expect(result.outcome).toEqual({
      kind: 'unavailable',
      code: 'configuredActionUnavailable',
    });
  });

  it.each([
    [
      { v: 1, handoff: { kind: 'placement_choice_required', reason: 'agent_required', candidates: [
        { machine: { serverId: 'server-a', machineId: 'controller' }, reachable: true },
      ], agents: [] } },
      { kind: 'placement_choice_required', reason: 'agent_required', candidates: [
        { machine: { serverId: 'server-a', machineId: 'controller' }, reachable: true },
      ], agents: [] },
    ],
    [
      { v: 1, handoff: { kind: 'selectionRequired', fields: ['agentChoice'] } },
      { kind: 'selectionRequired', fields: ['agentChoice'] },
    ],
    [
      { v: 1, handoff: { kind: 'uncertain', phase: 'create', session: null } },
      { kind: 'uncertain' },
    ],
    [
      { v: 1, handoff: { kind: 'unavailable', reason: 'targetUnavailable' } },
      { kind: 'unavailable', code: 'targetUnavailable' },
    ],
    [
      { v: 1, handoff: { kind: 'unavailable', reason: 'targetUnavailable',
        detail: { reason: 'session_start_refused', cause: 'permission_denied' } } },
      { kind: 'unavailable', code: 'permission_denied',
        detail: { reason: 'session_start_refused', cause: 'permission_denied' } },
    ],
    [
      { v: 1, handoff: { kind: 'unavailable', reason: 'targetUnavailable',
        detail: { reason: 'session_start_refused', cause: 'SOURCE_RUNTIME_RELOAD_REQUIRED' } } },
      { kind: 'unavailable', code: 'SOURCE_RUNTIME_RELOAD_REQUIRED',
        detail: { reason: 'session_start_refused', cause: 'SOURCE_RUNTIME_RELOAD_REQUIRED' } },
    ],
    [
      {
        kind: 'approval_request_created',
        artifactId: 'approval-1',
        actionId: 'action.invoke',
      },
      { kind: 'approval', artifactId: 'approval-1' },
    ],
  ])(
    'keeps the notice readable with the configured owner outcome %#',
    async (run, outcome) => {
      const result = await press({ choices: offered, run });
      expect(result.outcome).toEqual(outcome);
      expect(result.pending).toBe(false);
      expect(result.calls).toEqual(['actions/read-v1', 'sessions/run-configured-v1']);
    },
  );
});

describe('readNoticeInvestigationSubject', () => {
  // The notice's own data hook decides eligibility; the drawer only asks it.
  const hook = createAccountNoticeInvestigation({ scope, isCurrent: () => true,
    execute: createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({}))) });
  const subjectOf = (artifact: ReturnType<typeof createAccountNoticeArtifactFixture>) => {
    const entry = { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
    return readNoticeInvestigationSubject(entry.header, hook.isEligible(entry));
  };
  const alertEntry = { kind: 'alertEntry', entry: {
    entryRef: { source: { pluginId: 'happier.sentry', localId: 'issues' }, kindId: 'issue', collisionScope: 'storefront', entryId: '7Q' },
    sourceInstanceId: '11111111-1111-4111-8111-111111111111',
  } } as const;
  const providerAlert = (header: Record<string, unknown>) => createAccountNoticeArtifactFixture({ header: {
    source: { kind: 'plugin', pluginId: 'happier.sentry', itemId: 'source:7Q' }, page: undefined,
    title: 'TypeError: Invalid pool size NaN', body: 'New issue in Sentry.', ...header,
  } });

  it('offers Investigate on a failing service only while it is open', () => {
    const service = MachineServiceIdentityV1Schema.parse({ kind: 'adopted', machineId: 'machine', serviceId: 'watch-a',
      watchId: 'watch-a', watchRevision: 'watch-revision-a' });
    expect(subjectOf(createServiceHealthNoticeArtifactFixture(scope.serverId, { header: {
      source: { kind: 'host', topic: 'service_health', subject: service },
      page: { kind: 'host', page: 'machine_service', machine: { serverId: scope.serverId, machineId: service.machineId }, service },
    } }))).toMatchObject({ kind: 'service', service: 'watch-a', open: true, investigable: true });
    expect(subjectOf(createServiceHealthNoticeArtifactFixture(scope.serverId))).toMatchObject({ kind: 'service', open: true, investigable: true });
    expect(subjectOf(createServiceHealthNoticeArtifactFixture(scope.serverId, { header: { healthPhase: 'recovered' } })))
      .toMatchObject({ kind: 'service', open: false, investigable: false });
  });

  it('offers Investigate on an open provider alert its data hook admits, and says why not otherwise', () => {
    expect(subjectOf(providerAlert({ healthPhase: 'open', investigation: alertEntry }))).toEqual({ kind: 'alert', open: true, investigable: true });
    // An alert stored without its evidence reference stays readable but cannot start an investigation.
    expect(subjectOf(providerAlert({ healthPhase: 'open' }))).toEqual({ kind: 'alert', open: true, investigable: false });
    expect(subjectOf(providerAlert({ healthPhase: 'recovered', investigation: alertEntry })))
      .toEqual({ kind: 'alert', open: false, investigable: false });
  });

  it('offers an Environment subject without guessing a diagnosis Machine', () => {
    const environment = { serverId: scope.serverId, projectSourceId: 'project', environmentId: 'environment' };
    const fixture = (healthPhase: 'open' | 'recovered') => createAccountNoticeArtifactFixture({ header: {
      source: { kind: 'host', topic: 'service_health', subject: {
        kind: 'environment', environmentId: environment.environmentId, targetLinkId: 'runtime', condition: 'health',
      } },
      page: { kind: 'host', page: 'environment', environment, targetLinkId: 'runtime' },
      type: healthPhase === 'open' ? 'blocked' : 'update', healthPhase,
    } });
    expect(subjectOf(fixture('open'))).toEqual({ kind: 'environment', environment, targetLinkId: 'runtime',
      open: true, investigable: true });
    expect(subjectOf(fixture('recovered'))).toEqual({ kind: 'environment', environment, targetLinkId: 'runtime',
      open: false, investigable: false });
    const dismissed = fixture('open');
    expect(subjectOf(createAccountNoticeArtifactFixture({ header: { ...dismissed.header, status: 'dismissed' } })))
      .toMatchObject({ kind: 'environment', open: false, investigable: false });
  });

  it('is silent for notices that are not alerts', () => {
    expect(subjectOf(createAccountNoticeArtifactFixture({ header: { page: undefined } }))).toBeNull();
  });
});
