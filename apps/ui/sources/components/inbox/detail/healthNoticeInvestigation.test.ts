import { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { MachineServiceIdentityV1Schema } from '@happier-dev/protocol';
import { AgentsBackendsListOutputSchema } from '@happier-dev/protocol/actions/agentBackendInventory';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { TriageSessionHandoffResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTriageRunConfiguredActionHandler } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-configured-action-native';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/plugin-sdk/ui';
import { buildAgentTargetKeyV2, type AgentExecutionTargetV1 } from '@happier-dev/plugin-sdk/agents';

import { renderHook } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createAccountNoticeArtifactFixture, createServiceHealthNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createAccountNoticeInvestigation } from '@/hooks/inbox/accountNoticeInvestigation';
import { readAccountNoticeArtifactHeader } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import { readNoticeInvestigationSubject, readHealthNoticeInvestigationOutcome, useHealthNoticeInvestigate,
  useInvestigationAgentActions } from './healthNoticeInvestigation';

installSessionActionRpcBoundary(() => { throw new Error('Unexpected Session RPC'); });
const { useBoundFailureInvestigation } = await import('@/hooks/inbox/useInvestigateFailure');

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
  it.each([
    { mode: 'start', truncated: false }, { mode: 'review', truncated: false },
    { mode: 'start', truncated: true }, { mode: 'review', truncated: true },
  ] as const)('opens a seeded composer for an unresolved repository workspace in an Inbox deployment with valid host DTOs without starting a Session ($mode, partial Projects=$truncated)', async ({ mode, truncated }) => {
    const artifact = createAccountNoticeArtifactFixture({ header: {
      title: 'odeploy-qa-env-1030: deployment failed', type: 'blocked', healthPhase: 'open',
      source: { kind: 'host', topic: 'service_health', subject: {
        kind: 'environment', environmentId: 'environment', targetLinkId: 'runtime', condition: 'deployment_failed',
      } },
      page: { kind: 'host', page: 'environment', targetLinkId: 'runtime',
        environment: { serverId: scope.serverId, projectSourceId: 'project', environmentId: 'environment' } },
    } });
    const entry = { artifact, header: readAccountNoticeArtifactHeader(artifact, scope.accountId)! };
    const seeds: PluginUiNewSessionSeedV1[] = [];
    const hostActions: string[] = [];
    const handoffCalls: unknown[] = [];
    const bundledSchemaAdmissions: Array<{ input: boolean; result: boolean }> = [];
    const configured = createTriageRunConfiguredActionHandler();
    const agentTarget: AgentExecutionTargetV1 = { kind: 'agent', identity: { pluginId: 'happier.example.agent', localId: 'example' } };
    const targetKey = buildAgentTargetKeyV2(agentTarget);
    const agents = AgentsBackendsListOutputSchema.parse({ defaultTargetKey: targetKey,
      items: [{ targetKey, label: 'Example Agent', agentTarget, enabled: true }] });
    const environment = DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: {
      v: 1, id: 'environment', serverId: scope.serverId, projectSourceId: 'project', revision: 1,
      owner: { kind: 'account', accountId: scope.accountId }, protection: 'nonProduction',
      purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'other-account-machine',
      runtimeTargetLinkId: 'runtime', contentArtifactId: 'environment-content',
      contentHeaderVersion: 1, contentBodyVersion: 1,
      capabilities: { role: 'manager', read: true, deploy: true, manage: true,
        manageBindings: true, manageTargets: true, delete: true },
      createdByAccountId: scope.accountId, createdAtMs: 1, updatedAtMs: 1,
    }, targetLinks: [] });
    const bundledManifest = JSON.parse(readFileSync(new URL('../../../../../cli/assets/bundled-plugin-manifests/triage.json', import.meta.url), 'utf8')) as {
      contributes: { actions: Array<{ id: string; inputSchema: object; resultSchema: object }> };
    };
    const bundledAction = bundledManifest.contributes.actions.find(action => action.id === 'sessions/run-configured-v1')!;
    const acceptsBundledInput = compilePluginJsonSchema(bundledAction.inputSchema);
    const acceptsBundledResult = compilePluginJsonSchema(bundledAction.resultSchema);
    // UI navigation and host Action RPC are the real process boundaries. The shared hook,
    // Account owner, front door, registered Triage handler and placement/authoring owners stay real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      invokeContributedAction: async request => {
        if (request.action.localId === 'actions/read-v1') return { ok: true, result: offered };
        expect(request.action.localId).toBe('sessions/run-configured-v1');
        const acceptsInput = acceptsBundledInput(request.input);
        handoffCalls.push(request.input);
        const context = {
          signal: new AbortController().signal,
          accountScope: scope,
          ui: {
            version: () => ({ methods: ['openNewSession'] }),
            context: async () => ({ accountScope: scope }),
            openNewSession: async (seed: PluginUiNewSessionSeedV1) => { seeds.push(seed); },
            executeAction: async (action: string | Readonly<{ localId: string }>) => {
              const id = typeof action === 'string' ? action : action.localId;
              hostActions.push(id);
              if (id === 'actions/read-v1') return { v: 1, availability: 'parsed', revision: '1', actions: [{
                actionId: 'investigate', label: 'Investigate repository workspace', enabled: true, appliesTo: ['other'],
                profileId: null, workspaceMode: 'repository', target: { kind: 'agent', promptInvocationId: null,
                  seededFallbackInstruction: 'Investigate this failed deployment.', delivery: 'send' },
              }] };
              if (id === 'artifact.get') return { artifact: {
                artifactId: artifact.id, ownerAccountId: artifact.ownerAccountId, access: artifact.access,
                publicAudience: artifact.publicAudience, header: artifact.header, body: artifact.body,
                revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
                seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
              } };
              if (id === 'deployments.environments.get') return environment;
              if (id === 'projects.list') return { items: [], truncated };
              if (id === 'agents.backends.list') return agents;
              throw new Error(`Unexpected host Action ${id}`);
            },
          },
        // Only the external host API ports exercised by this invocation are installed.
        } as unknown as PluginAccountActionContext;
        const result = await configured(request.input, context);
        bundledSchemaAdmissions.push({ input: acceptsInput, result: acceptsBundledResult(result) });
        return { ok: true, result };
      },
    }));
    const owner = createAccountNoticeInvestigation({ scope, isCurrent: () => true,
      execute: createFrontDoorActionExecute(executor) });
    const bound = {
      readChoices: (options: { signal: AbortSignal }) => owner.readChoices(entry, options),
      resume: (options: { signal: AbortSignal }) => owner.resume(entry, options),
      run: (selection: Parameters<typeof owner.run>[1], options: Parameters<typeof owner.run>[2]) => owner.run(entry, selection, options),
    };
    const hook = await renderHook(() => useBoundFailureInvestigation(bound));
    try {
      await act(async () => { await hook.getCurrent().launch(mode); });
      expect(bundledSchemaAdmissions).toEqual([{ input: true, result: true }]);
      expect(hook.getCurrent().outcome).toEqual({ kind: 'started',
        handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } });
      expect(seeds).toEqual([expect.objectContaining({ prompt: expect.any(String),
        actionDefault: expect.objectContaining({ configuredActionId: 'investigate' }) })]);
      expect(JSON.stringify(seeds[0])).toContain(artifact.id);
      expect(seeds[0]).not.toHaveProperty('directoryIntent');
      expect(hostActions).not.toContain('session.spawn_new');
      expect(hostActions).not.toContain('session.message.send');
      expect(handoffCalls).toHaveLength(1);
      expect(hook.getCurrent().pending).toBe(false);
    } finally { await hook.unmount(); owner.dispose(); }
  });

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

describe('agent actions on a native subject page', () => {
  const selection = (configuredActionId: string) => ({ configuredActionId,
    sessionChoice: { kind: 'configured' }, agentChoice: { kind: 'configured' }, delivery: 'configured' } as const);
  const subject = { kind: 'deploymentReceipt', serverId: scope.serverId, environmentId: 'environment', deploymentId: 'receipt' } as const;

  it('draws the person\'s records for this subject and launches the one pressed, in the mode chosen', async () => {
    const reads: unknown[] = [];
    const runs: unknown[] = [];
    // The contributed plugin invocation is the realm boundary; the front door and the Account owner stay real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      invokeContributedAction: async (request) => {
        if (request.action.localId === 'actions/read-v1') {
          reads.push(request.input);
          return { ok: true, result: { v: 1, kind: 'choices', defaultActionId: 'investigate', actions: [
            { label: 'Ask', selection: selection('ask'), launchMode: 'review', startable: false },
            { label: 'Debug it', selection: selection('investigate'), launchMode: 'start', startable: true },
            { label: 'Fix this deploy', selection: selection('deployments.fix-deploy'), launchMode: 'review',
              startable: false, forSubject: true },
          ] } };
        }
        runs.push(request.input);
        return { ok: true, result: { v: 1, handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } } };
      },
    }));
    const owner = createAccountNoticeInvestigation({ scope, isCurrent: () => true,
      execute: createFrontDoorActionExecute(executor) });
    const bound = {
      readChoices: (options: { signal: AbortSignal }) => owner.readChoices(subject, options),
      resume: (options: { signal: AbortSignal }) => owner.resume(subject, options),
      run: (picked: Parameters<typeof owner.run>[1], options: Parameters<typeof owner.run>[2]) => owner.run(subject, picked, options),
    };
    const hook = await renderHook(() => ({
      actions: useInvestigationAgentActions(bound, { includeDefault: true }),
      intent: useHealthNoticeInvestigate(bound),
    }));
    try {
      await act(async () => {});
      expect(reads).toEqual([expect.objectContaining({ projection: 'sessionHandoff', subject: 'deploymentReceipt' })]);
      // The task default leads, then the subject's own records; a record offered everywhere is not this page's.
      expect(hook.getCurrent().actions).toEqual([
        { actionId: 'investigate', label: 'Debug it', launchMode: 'start', startable: true },
        { actionId: 'deployments.fix-deploy', label: 'Fix this deploy', launchMode: 'review', startable: false },
      ]);
      await act(async () => { await hook.getCurrent().intent.launch('review', 'deployments.fix-deploy'); });
      expect(runs).toEqual([expect.objectContaining({ handoff: expect.objectContaining({
        configuredActionId: 'deployments.fix-deploy', delivery: 'compose',
        context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }] }) })]);
      expect(hook.getCurrent().intent.outcome).toEqual({ kind: 'started',
        handoff: { kind: 'composed', destination: { kind: 'newSessionDraft' } } });
    } finally { await hook.unmount(); }
  });
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
