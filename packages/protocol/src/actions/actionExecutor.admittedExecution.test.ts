import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import type { ActionExecutorContext } from './executor/types.js';
import { SessionSpawnNewActionResultV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { createHostReviewedChildPortV1 } from './executor/deploymentRoleChild.js';
import { DeploymentReceiptAcceptedResultV1Schema } from '../deployments/deploymentReceiptResultV1.js';
import { buildBackendTargetKeyV2 } from '../backends/targets/backendTargetRefV2.js';
import { ExecutionRunStartRequestSchema } from '../execution/runs/startRequest.js';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';

const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
  serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'original',
  externalActionTarget: { kind: 'machine', machineId: 'guest' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
const wake = { action: 'machines.managed.power.set' as const, role: 'managed-wake',
  input: { homeId: 'home', managedId: 'managed', when: 'now', expectedRevision: 1, intent: 'start' } };

const profileStartCases = [
  { actionId: 'execution.run.start', surface: 'agent' },
  { actionId: 'subagents.delegate.start', surface: 'mcp' },
] as const;

function createProfiledRunStartFixture(surface: 'agent' | 'mcp', overrides: Partial<ActionExecutorDeps> = {}) {
  const profileId = 'danger-requires-review';
  const requests: ReturnType<typeof ExecutionRunStartRequestSchema.parse>[] = [];
  let deploymentEffects = 0;
  const deployment = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
    targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const executor = createActionExecutor({
    // Owning Session metadata, Run persistence and the deployment provider are process boundaries.
    readActionApprovalProfileId: async admission => admission.defaultSessionId === 'parent-session' ? profileId : null,
    executionRunStart: async (_sessionId, input) => {
      requests.push(ExecutionRunStartRequestSchema.parse(input));
      return { runId: 'child-run', callId: 'call', sidechainId: 'call' };
    },
    resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
    prepareDeploymentAction: async () => ({ input: deployment, preview: { sourceMethod: 'gitIntegration' } }),
    deploymentAction: async () => {
      deploymentEffects++;
      return DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true, environmentId: 'environment',
        revision: 4, kind: 'pending', actionOperationId: 'operation' });
    },
    ...overrides,
  });
  const parent: ActionExecutorContext = { ...context, surface, authority: 'account_automation',
    actionCaller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
    defaultSessionId: 'parent-session', externalActionTarget: { kind: 'session', sessionId: 'parent-session' },
    interactivePresentation: 'unavailable', callerPermissionMode: 'read_only',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
      'execution.run.start': ['agent', 'mcp'], 'subagents.delegate.start': ['agent', 'mcp'],
      'deployments.deploy': ['agent', 'mcp'],
    }, approvalProfiles: [{ id: profileId, name: 'Review dangerous work', actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent', 'mcp'] } } }] }),
    agentStartContext: {
      caller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'guest', directory: '/workspace' }, ledSubtreeSessionIds: [],
      workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only',
    },
  };
  const inputFor = (actionId: typeof profileStartCases[number]['actionId']) => actionId === 'execution.run.start'
    ? { sessionId: 'parent-session', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Do the work', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
      runClass: 'bounded', ioMode: 'request_response' }
    : { sessionId: 'parent-session', instructions: 'Do the work', backendTargetKeys: [buildBackendTargetKeyV2({
      kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    })] };
  return { executor, parent, profileId, requests, deployment, inputFor, deploymentEffects: () => deploymentEffects };
}

it.each(profileStartCases.flatMap(start => ['builtin:full-trust', null].map(approvalProfileId => ({ ...start, approvalProfileId }))))(
  'requires review when $surface changes a child profile to $approvalProfileId through $actionId despite its start waiver',
  async ({ actionId, surface, approvalProfileId }) => {
    const fixture = createProfiledRunStartFixture(surface);
    expect(await fixture.executor.execute(actionId, { ...fixture.inputFor(actionId), approvalProfileId }, fixture.parent))
      .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(fixture.requests).toEqual([]);
  });

it.each(profileStartCases)('retains the parent danger requirement after omitted or same-profile $actionId on $surface',
  async ({ actionId, surface }) => {
    const fixture = createProfiledRunStartFixture(surface);
    for (const approvalProfileId of [undefined, fixture.profileId]) {
      expect(await fixture.executor.execute(actionId, { ...fixture.inputFor(actionId),
        ...(approvalProfileId === undefined ? {} : { approvalProfileId }) }, fixture.parent)).toMatchObject({ ok: true });
      const storedRun = fixture.requests.at(-1);
      expect(storedRun?.approvalProfileId).toBe(fixture.profileId);
      expect(await fixture.executor.execute('deployments.deploy', fixture.deployment, {
        ...fixture.parent, agentStartContext: undefined, approvalProfileId: storedRun?.approvalProfileId,
        defaultSessionId: 'child-session', actionRequestId: 'child-danger',
      })).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    }
    expect(fixture.deploymentEffects()).toBe(0);
  });

it.each(profileStartCases)('retains the admitted profile through deferred approval and replay of $actionId',
  async ({ actionId, surface }) => {
    let stored: ApprovalRequest | null = null;
    let currentProfileId: string | null = 'danger-requires-review';
    let replayStartContext: ActionExecutorContext['agentStartContext'];
    const fixture = createProfiledRunStartFixture(surface, {
      // Only authenticated Artifact storage and host Session reads are replaced.
      readActionApprovalProfileId: async () => currentProfileId,
      isApprovalExecutionOriginCurrent: async () => true,
      resolveAgentStartContext: async () => replayStartContext ?? null,
      approvalsCreate: async ({ request }) => {
        stored = ApprovalRequestV2Schema.parse(request);
        return { artifactId: 'run-start-approval' };
      },
      approvalsGet: async () => stored && structuredClone(stored),
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('Missing Run start approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = structuredClone(next);
        return { ok: true };
      },
    });
    replayStartContext = fixture.parent.agentStartContext;
    const parent: ActionExecutorContext = { ...fixture.parent, serverIdentityId: 'home-identity',
      defaultSessionMachineId: 'guest', interactivePresentation: undefined,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalProfiles: [{ id: fixture.profileId,
        name: 'Review all work', actions: {
        'execution.run.start': { approvalRequiredSurfaces: ['agent', 'mcp'] },
        'subagents.delegate.start': { approvalRequiredSurfaces: ['agent', 'mcp'] } } }] }),
    };
    expect(await fixture.executor.execute(actionId, fixture.inputFor(actionId), parent)).toMatchObject({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'run-start-approval' },
    });
    expect(fixture.requests).toEqual([]);
    // Later Session preferences do not rewrite the child selection that was reviewed.
    currentProfileId = null;
    expect(await fixture.executor.execute('approval.request.decide', {
      artifactId: 'run-start-approval', decision: 'approve',
    }, { ...context, serverIdentityId: 'home-identity', actionRequestId: 'approve-run' })).toMatchObject({
      ok: true, result: { execution: { ok: true } },
    });
    expect(fixture.requests).toMatchObject([{ approvalProfileId: fixture.profileId }]);
    expect(await fixture.executor.execute('deployments.deploy', fixture.deployment, {
      ...fixture.parent, defaultSessionId: 'child-session', agentStartContext: undefined,
      approvalProfileId: fixture.requests[0]?.approvalProfileId,
    })).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    expect(fixture.deploymentEffects()).toBe(0);
  });

it('runs the admitted host continuation with the original child port before an operation dispatches its effect', async () => {
  const order: string[] = [];
  const operationAcceptance = { operationId: 'spawn-operation', actionId: 'session.spawn_new' as const, accept() {} };
  const child = { action: 'daemon.filesystem.readFile' as const, role: 'inspect', input: { rootPath: '/workspace', path: 'README.md' } };
  let childAcceptance: ActionExecutorContext['operationAcceptance'];
  let preparations = 0;
  let originalPort: ActionExecutorContext['hostReviewedChild'];
  const ports: ActionExecutorContext['hostReviewedChild'][] = [];
  let demanded: unknown;
  const executor = createActionExecutor({
    prepareHostReviewedChildren: async request => {
      if (!request.machineRuntimeDemand) return null;
      preparations++;
      demanded = request.machineRuntimeDemand;
      // The private producer closure captures its exact selection; only children enter review storage.
      return { children: [wake, child], executeAdmittedAction: async execution => {
        originalPort = execution.context.hostReviewedChild;
        order.push('continuation');
        return execution.execute(execution.context);
      } };
    },
    runActionOperation: async request => {
      ports.push(request.context.hostReviewedChild);
      order.push('operation'); return request.execute({ ...request.context, operationAcceptance });
    },
    filesystemActionExecute: async args => {
      childAcceptance = args.context.operationAcceptance;
      return { success: true, content: '' };
    },
    sessionSpawnNew: async args => {
      ports.push(args.context?.hostReviewedChild);
      expect(await args.context?.hostReviewedChild?.invoke(child)).toMatchObject({ ok: true });
      order.push('effect'); return SessionSpawnNewActionResultV1Schema.parse({
      type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
    }); },
  });
  const prepared = await executor.prepare('session.spawn_new', {
    executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'path', path: '/workspace' },
    organizationPlacement: { sectionId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  }, context);
  expect(prepared.kind).toBe('ready');
  expect(order).toEqual([]);
  if (prepared.kind !== 'ready') throw new Error('The legitimate original must prepare');
  expect(await prepared.invocation.run()).toEqual({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } });
  expect(order).toEqual(['continuation', 'operation', 'effect']);
  expect(demanded).toEqual({ target: { kind: 'machine', machineId: 'guest' }, serverId: 'home' });
  expect(originalPort).toBeDefined();
  expect(ports[0]).toBe(originalPort);
  expect(ports[1]?.preparedChildren).toEqual(originalPort?.preparedChildren);
  expect(childAcceptance).toBe(operationAcceptance);
  expect(preparations).toBe(1);
});

it('does not discover fresh runtime demand when the existing private port dispatches an already-admitted child', async () => {
  const effects: string[] = [];
  const child = { action: 'daemon.filesystem.readFile' as const, role: 'inspect', input: { rootPath: '/workspace', path: 'README.md' } };
  const executor = createActionExecutor({
    prepareHostReviewedChildren: async request => {
      if (!request.machineRuntimeDemand) return null;
      effects.push('fresh-demand');
      return { children: [], executeAdmittedAction: async execution => { effects.push('continuation'); return execution.execute(execution.context); } };
    },
    filesystemActionExecute: async () => { effects.push('read'); return { success: true, content: '' }; },
  });
  const port = createHostReviewedChildPortV1({ actionId: 'machines.reboot',
    input: { serverId: 'home', machineId: 'guest', expectedInstallationId: 'installation' }, context,
    plan: { children: [child] }, policies: [{ action: child.action, role: child.role, surface: 'ui', requiredActionIds: [] }],
    reviewAdmitted: true, execute: (input, childContext, actionId) => executor.execute(actionId, input, childContext) });
  expect(await port.invoke(child)).toMatchObject({ ok: true });
  expect(effects).toEqual(['read']);
});

it('does not enter the effect continuation before agent approval or for passive reads', async () => {
  const effects: string[] = [];
  const executor = createActionExecutor({
    prepareHostReviewedChildren: async request => request.machineRuntimeDemand ? { children: [wake],
      executeAdmittedAction: async execution => { effects.push('continuation'); return execution.execute(execution.context); } } : null,
    approvalsCreate: async () => ({ artifactId: 'review' }),
    filesystemActionExecute: async () => { effects.push('file'); return { success: true, entries: [] }; },
  });
  expect(await executor.prepare('daemon.filesystem.readFile', { rootPath: '/workspace', path: 'README.md' }, {
    ...context, surface: 'agent', authority: 'account_automation',
  })).toMatchObject({ kind: 'settled', result: { ok: true, result: { kind: 'approval_request_created' } } });
  const passive = await executor.prepare('daemon.filesystem.listDirectory', { rootPath: '/workspace', path: '.' }, context);
  expect(passive.kind).toBe('ready');
  if (passive.kind !== 'ready') throw new Error('Passive discovery must remain available');
  expect(await passive.invocation.run()).toMatchObject({ ok: true });
  expect(effects).toEqual(['file']);
});

it('retains the prepared original Machine across a Session placement change without rewriting its signed Session target', async () => {
  let machineId = 'machine-a';
  const effects: string[] = [];
  let preparations = 0;
  const sessionTarget = { kind: 'session' as const, sessionId: 'selected' };
  const executor = createActionExecutor({
    prepareHostReviewedChildren: async request => {
      if (!request.machineRuntimeDemand) return null;
      preparations++;
      const target = { machineId, serverId: 'home' };
      return { children: [], executeAdmittedAction: execution => execution.execute(execution.context, target) };
    },
    // The host effect boundary would otherwise resolve the Session's newly selected Machine.
    sessionOpen: async (_input, effectContext) => {
      expect(effectContext?.externalActionTarget).toEqual(sessionTarget);
      expect(effectContext?.defaultSessionMachineId).toBe('caller-machine');
      effects.push(effectContext?.admittedMachineTarget?.machineId ?? machineId);
      return { ok: true, status: 'opened' };
    },
  });
  const prepared = await executor.prepare('session.open', { sessionId: 'selected', intent: 'resume' }, {
    ...context, externalActionTarget: sessionTarget, defaultSessionMachineId: 'caller-machine',
  });
  expect(prepared.kind).toBe('ready');
  if (prepared.kind !== 'ready') throw new Error('The exact Session original must prepare');
  machineId = 'machine-b';
  expect(await prepared.invocation.run()).toMatchObject({ ok: true });
  expect(effects).toEqual(['machine-a']);
  expect(preparations).toBe(1);
});

it('passes the prepared Session Run Machine to its existing exact-target transport owner', async () => {
  let machineId = 'machine-a';
  const effects: string[] = [];
  const sessionTarget = { kind: 'session' as const, sessionId: 'selected' };
  const executor = createActionExecutor({
    prepareHostReviewedChildren: async request => {
      if (!request.machineRuntimeDemand) return null;
      const target = { machineId, serverId: 'home' };
      return { children: [], executeAdmittedAction: execution => execution.execute(execution.context, target) };
    },
    executionRunStart: async (_sessionId, _input, options) => {
      expect(options?.externalActionTarget).toEqual(sessionTarget);
      effects.push(options?.targetMachineId ?? machineId);
      return { runId: 'run', callId: 'call', sidechainId: 'call' };
    },
  });
  const prepared = await executor.prepare('execution.run.start', {
    sessionId: 'selected', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    instructions: 'Do the work', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
    runClass: 'bounded', ioMode: 'request_response',
  }, { ...context, externalActionTarget: sessionTarget, agentStartContext: {
    caller: { kind: 'session', sessionId: 'selected', starterDepth: 0, turnDepth: 0 },
    baseline: { machineId: 'machine-a', directory: '/workspace' }, ledSubtreeSessionIds: [],
    workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'read-only',
  } });
  expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
  if (prepared.kind !== 'ready') throw new Error('The original Run must prepare');
  machineId = 'machine-b';
  expect(await prepared.invocation.run()).toMatchObject({ ok: true });
  expect(effects).toEqual(['machine-a']);
});

it.each([
  { profileId: 'builtin:apply-safe', waiveDanger: false },
  { profileId: 'danger-requires-review', waiveDanger: true },
])('inherits $profileId at Session birth so the child still asks before a danger Action', async ({ profileId, waiveDanger }) => {
  const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
    approvalWaivedSurfaces: waiveDanger ? { 'deployments.deploy': ['agent'] } : {},
    approvalProfiles: [{ id: 'danger-requires-review', name: 'Review dangerous work', actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent', 'mcp'] } } }],
  });
  const profiles = new Map<string, string | null>([['parent-session', profileId]]);
  let effects = 0;
  const deployment = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
    targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const receipt = DeploymentReceiptAcceptedResultV1Schema.parse({ ok: true, environmentId: 'environment',
    revision: 4, kind: 'pending', actionOperationId: 'operation' });
  const executor = createActionExecutor({
    // Session persistence and the deployment provider are process boundaries.
    readActionApprovalProfileId: async admission => profiles.get(admission.defaultSessionId ?? '') ?? null,
    sessionSpawnNew: async args => {
      profiles.set('child-session', args.approvalProfileId ?? null);
      return { type: 'success', disposition: 'created', sessionId: 'child-session',
        executionTarget: { serverId: 'home', machineId: 'guest' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
    },
    resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
    prepareDeploymentAction: async () => ({ input: deployment, preview: { sourceMethod: 'gitIntegration' } }),
    deploymentAction: async () => { effects++; return receipt; },
  });
  const parent: ActionExecutorContext = { ...context, surface: 'agent', authority: 'account_automation',
    actionCaller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
    defaultSessionId: 'parent-session', actionsSettings, interactivePresentation: 'unavailable',
    agentStartContext: {
      caller: { kind: 'session', sessionId: 'parent-session', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'guest', directory: '/workspace', configuration: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        permissionMode: 'read-only',
      } },
      ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: 'read-only',
    },
  };
  const spawnInput = {
    executionTarget: { serverId: 'home', machineId: 'guest' }, directory: { kind: 'path', path: '/workspace' },
    organizationPlacement: { sectionId: null, tagIds: [] },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  };
  expect(await executor.execute('session.spawn_new', spawnInput, parent)).toMatchObject({
    ok: true, result: { type: 'success', sessionId: 'child-session' },
  });
  const child: ActionExecutorContext = { ...parent, defaultSessionId: 'child-session', agentStartContext: undefined,
    actionCaller: { kind: 'session', sessionId: 'child-session', starterDepth: 1, turnDepth: 1 },
  };
  expect(await executor.execute('deployments.deploy', deployment, child)).toMatchObject({
    ok: false, errorCode: 'action_interactive_review_required',
  });
  expect(effects).toBe(0);
  expect(profiles.get('child-session')).toBe(profileId);
  // An explicitly detached Session follows the person's saved base policy.
  expect(await executor.execute('session.spawn_new', { ...spawnInput, approvalProfileId: null }, {
    ...parent, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionRequestId: 'detach',
  })).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'child-session' } });
  expect(profiles.get('child-session')).toBeNull();
  expect(await executor.execute('deployments.deploy', deployment, child)).toMatchObject(waiveDanger
    ? { ok: true, result: receipt }
    : { ok: false, errorCode: 'action_interactive_review_required' });
  expect(effects).toBe(waiveDanger ? 1 : 0);
});

it.each([
  { actionId: 'session.fork', surface: 'agent', input: { sessionId: 'caller-session', forkPoint: { type: 'latest' } } },
  { actionId: 'session.continue_with_replay', surface: 'rpc', input: { directory: '/workspace',
    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, replay: { previousSessionId: 'source-session' } } },
] as const)('inherits the caller profile when $actionId copies a differently profiled source', async ({ actionId, surface, input }) => {
  const profileId = 'danger-requires-review';
  let childProfileId: string | null = null;
  let effects = 0;
  const deployment = { serverId: 'home', environmentId: 'environment', expectedRevision: 3, requestKey: 'deploy-request',
    targetLinkId: 'link', expectedTargetLinkRevision: 4, contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
  const persistChild = async (args: Readonly<{ approvalProfileId?: string | null }>) => {
    // The source and the child's persisted metadata are Session service boundaries.
    childProfileId = args.approvalProfileId === undefined ? 'builtin:full-trust' : args.approvalProfileId;
    return { ok: true, childSessionId: 'child-session' };
  };
  const executor = createActionExecutor({
    readActionApprovalProfileId: async admission => admission.defaultSessionId === 'child-session' ? childProfileId : profileId,
    sessionFork: persistChild,
    sessionContinueWithReplay: async args => { await persistChild(args); return { type: 'success', sessionId: 'child-session' }; },
    resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: 'environment' } }),
    prepareDeploymentAction: async () => ({ input: deployment, preview: { sourceMethod: 'gitIntegration' } }),
    deploymentAction: async () => { effects++; return DeploymentReceiptAcceptedResultV1Schema.parse({
      ok: true, environmentId: 'environment', revision: 4, kind: 'pending', actionOperationId: 'operation' }); },
  });
  const parent: ActionExecutorContext = { ...context, surface, authority: 'account_automation',
    defaultSessionId: 'caller-session', externalActionTarget: undefined,
    actionCaller: surface === 'rpc' ? { kind: 'host' } : { kind: 'session', sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
    ...(surface === 'rpc' ? { approvalProfileId: profileId } : {}),
    interactivePresentation: 'unavailable', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { [actionId]: [surface], 'deployments.deploy': ['agent'] },
      approvalProfiles: [{ id: profileId, name: 'Review dangerous work', actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent', 'mcp'] } } }],
    }),
  };
  expect(await executor.execute(actionId, input, parent)).toEqual({ ok: true, result: actionId === 'session.fork'
    ? { ok: true, childSessionId: 'child-session' } : { type: 'success', sessionId: 'child-session' } });
  expect(childProfileId).toBe(profileId);
  expect(await executor.execute('deployments.deploy', deployment, { ...parent, surface: 'agent',
    defaultSessionId: 'child-session', approvalProfileId: undefined,
    actionCaller: { kind: 'session', sessionId: 'child-session', starterDepth: 1, turnDepth: 1 },
  })).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
  expect(effects).toBe(0);
  if (surface === 'agent') {
    for (const approvalProfileId of [null, 'builtin:full-trust']) {
      expect(await executor.execute(actionId, { ...input, approvalProfileId }, parent))
        .toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
    }
  }
});
