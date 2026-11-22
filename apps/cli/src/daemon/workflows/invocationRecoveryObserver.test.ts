import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import * as sessionRpc from '@/session/transport/rpc/sessionRpc';
import { createSessionRecordFixture } from '@/testkit';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createProductionWorkflowConversationOwner } from './sessionStepExecutor';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { createWorkflowInvocationRecoveryObserver, observeWorkflowInvocationRecoveryEvidence } from './invocationRecoveryObserver';
import { freezeActionCompletionContractV1, getActionSpec, projectCommandActionCompletionV1 } from '@happier-dev/protocol/actions';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveWorkflowSessionCreationTag } from './workflowSessionStartup';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { resolveWorkflowAcceptedStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { resolveWorkflowSessionConversation } from './daemonRuntime';

const progress: WorkflowProgressEnvelopeV1 = {
  kind: 'happier.workflow-progress.v1', blockKind: 'step',
  invocationPath: { blockId: 'step', scope: [] }, attempt: '0',
  logicalInvocationRecordId: '2aaf1a39-4c48-4904-83a4-7eae318dfc2c',
  execution: { kind: 'detached_run', runId: 'native-run', localInputId: 'input-1', runtimeSelection: {} },
};

const socketBoundary = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: socketBoundary.io }));

// Only the Session socket transport is replaced; recovery and input observation remain real.
vi.mock('@/api/session/sockets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/session/sockets')>();
  const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  const { createSocketTransportAdapter } = await import('@happier-dev/sync-client');
  return { ...actual, createSessionScopedSocketConnection: () => {
    const socket = createApiSessionSocketStub();
    return { socket, transport: createSocketTransportAdapter(socket) };
  } };
});
afterEach(() => vi.restoreAllMocks());

describe('exact Workflow recovery observation', () => {
  it.each([7, -1])('uses a retained shell exit to distinguish stopped work from a transport refusal (%s)', async exitCode => {
    const observed = await observeWorkflowInvocationRecoveryEvidence({
      runId: 'workflow-run', credentials: { token: 'token', encryption: null }, machineId: 'machine',
      progress: {
        ...progress, blockKind: 'action',
        execution: {
          kind: 'action', actionId: 'machines.command.run', actionRequestId: 'invocation',
          localInputId: 'input', input: { command: 'exit 7' },
        },
        timing: { startedAt: '2026-11-21T07:25:16.883Z', finishedAt: '2026-11-21T07:25:25.703Z' },
        result: { exitCode, stdout: '', stderr: '' }, reason: { code: 'command_failed' },
      },
      getRun: async () => { throw new Error('The shell command has no detached Agent Run'); },
    });
    expect(observed).toEqual({ activity: exitCode > 0 ? 'not_active' : 'unknown',
      canReattach: false, canContinueConversation: false });
  });

  it.each([
    { receiptRunId: 'run-1', unknown: false }, { receiptRunId: 'other-run', unknown: false },
    { receiptRunId: 'run-1', unknown: true },
  ])('binds recovered approval evidence to the original Workflow Run ($receiptRunId, unknown=$unknown)', async ({ receiptRunId, unknown }) => {
    const request = { v: 1, kind: 'plugin_target_action', status: unknown ? 'outcome_unknown' : 'executed', createdAtMs: 1, updatedAtMs: 3,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', summary: 'Update',
      qualifiedActionId: 'example.workflow/actions/update', input: {}, secretInputPaths: [],
      sourceCustody: { kind: 'development', registeredRootId: 'root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64),
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', serverId: 'home',
        serverIdentityId: 'home-identity', accountId: 'owner', machineId: 'machine', actionId: 'action.invoke',
        requestId: 'invocation', caller: { kind: 'workflowRun', runId: receiptRunId,
          authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: unknown ? { executedAtMs: 3, ok: false, effectAttempted: true, errorCode: 'approval_execution_outcome_unknown' }
        : { executedAtMs: 3, ok: true, effectAttempted: true, result: { updated: true } } };
    const observed = await observeWorkflowInvocationRecoveryEvidence({ runId: 'run-1',
      credentials: { token: 'token', encryption: null }, machineId: 'machine',
      progress: { ...progress, execution: { kind: 'action', actionId: 'example.workflow/actions/update',
        actionRequestId: 'invocation', localInputId: 'input', input: {},
        output: { kind: 'approval_request_created', artifactId: 'receipt', actionId: 'action.invoke' } } },
      getRun: async () => { throw new Error('Approval recovery does not read detached Runs'); },
      getApproval: async () => ({ artifactId: 'receipt', request }),
    });
    expect(observed).toEqual({ activity: receiptRunId === 'run-1' && !unknown ? 'not_active' : 'unknown',
      canReattach: receiptRunId === 'run-1' && !unknown, canContinueConversation: false });
  });
  it.each(['current', 'replaced', 'no-target'] as const)
  ('starts a Home-qualified input participant and readies only its accepted exact Machine (%s)', async scenario => {
    const credentials = { token: 'token', encryption: null };
    const sessionId = 'c123456789012345678901234';
    const machineId = 'participant-machine';
    const directory = '/participant-only/checkout';
    const releaseHome = publishServerHttpRuntimeOrigin('http://127.0.0.1:43187', 'https');
    onTestFinished(releaseHome);
    const retainedSession = createSessionRecordFixture({ id: sessionId, machineId, encryptionMode: 'plain', active: false,
      metadata: JSON.stringify({ machineId, path: directory, claudeSessionId: 'retained-native-session',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }) });
    const rpcMethods: string[] = [];
    const httpPaths: string[] = [];
    let spawnNonce = '';
    let replacementReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      httpPaths.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: retainedSession } };
      if (path === '/v1/machines') { replacementReads++; return { status: 200, data: { machines: [
        { id: machineId, replacedByMachineId: 'successor-machine' }, { id: 'successor-machine' },
      ] } }; }
      if (path.startsWith('/v1/machines/')) return { status: 200, data: { machine: {
        id: decodeURIComponent(path.slice('/v1/machines/'.length)), storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        ...(scenario === 'replaced' ? { replacedByMachineId: 'successor-machine' } : {}),
      } } };
      throw new Error(`Unexpected participant readiness HTTP read: ${path}`);
    });
    const socket = createApiSessionSocketStub({ async emitWithAck(event, payload) {
      if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
        || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
        throw new Error('Unexpected participant readiness RPC');
      }
      rpcMethods.push(payload.method);
      if (scenario === 'no-target') return { ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
      if (payload.method === `${machineId}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`) {
        const request = payload.params;
        if (!request || typeof request !== 'object' || !('spawnNonce' in request) || typeof request.spawnNonce !== 'string') {
          throw new Error('Missing participant readiness identity');
        }
        spawnNonce = request.spawnNonce;
        return { ok: true, result: { type: 'success', sessionId, spawnNonce } };
      }
      if (payload.method === `${machineId}:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE}`) {
        expect(payload.params).toMatchObject({ spawnNonce });
        return { ok: true, result: { status: 'success', sessionId } };
      }
      throw new Error('Readiness was routed to another Machine');
    } });
    socketBoundary.io.mockReturnValue(socket);
    const unused = async (): Promise<never> => { throw new Error('Existing participants cannot allocate a fresh Session'); };
    const runId = '53ca23a1-5c49-4353-a544-44e1e1087b22';
    let acceptedEnvelope: string | undefined;
    const publicStart = createWorkflowAccountRunActionOwner({
      resolveAccountId: async () => 'participant-account',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: path => path.startsWith('/') ? path : null,
      randomBytes: () => { throw new Error('Plain admission does not allocate encryption material'); },
      definitions: { get: unused },
      prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
        machineId: 'coordinator-machine', directory: '/coordinator', checkoutRootPath: '/coordinator',
      } } }),
      resolveMaterializationContext: async () => ({ effects: {
        resolveTargetAvailability: async () => true,
        // Authenticated Home Session read: the qualifier must survive the input
        // boundary even when another Home has the same Session identifier.
        resolveSessionTarget: async value => value && typeof value === 'object' && 'serverId' in value && 'sessionId' in value
          && value.serverId === 'home-b' && value.sessionId === sessionId
          ? { address: { serverId: 'home-b', sessionId }, machineId } : null,
      } }),
      storage: { execute: async operation => {
        if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        if (operation.operation !== 'admit') throw new Error('Unexpected participant admission storage request');
        acceptedEnvelope = String(operation.acceptedEnvelope);
        return { kind: 'created', run: WorkflowRunSummaryV1Schema.parse({
          attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
          id: runId, sourceArtifactId: null, ownerAccountId: 'participant-account', visibleTeamId: null,
          origin: { kind: 'direct' }, state: 'queued', revision: 0, machineId: 'coordinator-machine',
          workflowCustodyState: 'pending', originDeliveryAckRevision: null,
          availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true,
            inspectExecution: false, disabledReasons: [] },
          createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
        }) };
      } },
    });
    await expect(publicStart.execute({ actionId: 'workflow.run.start',
      input: WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition: {
        version: 1, defaults: {}, inputs: [{ name: 'participant', valueType: 'json', required: true,
          inputType: { hostType: 'agentParticipant' } }], blocks: [{ kind: 'step', id: 'participant',
          document: { text: 'Give an opinion', references: [], attachments: [] }, input: [], result: { kind: 'text' },
          execution: { participant: { kind: 'input', name: 'participant' } },
        }],
      } }, inputs: { participant: { kind: 'session', session: { serverId: 'home-b', sessionId } } } }),
      context: { surface: 'ui', authority: 'present_user', serverId: 'home-b', callerPermissionMode: 'default',
        externalActionTarget: { kind: 'machine', machineId: 'coordinator-machine',
          project: { machineId: 'coordinator-machine', directory: '/coordinator' } } },
    })).resolves.toMatchObject({ admission: 'created' });
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope!)!,
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'participant-account', runId } });
    if (opened.kind !== 'available') throw new Error('Accepted participant snapshot unavailable');
    const selected = resolveWorkflowAcceptedStepSelectionV1(opened.content.materializedLeaves[0]!, undefined, opened.content.inputs);
    expect(selected.selection.conversation).toEqual({ kind: 'existing_session', sessionId, machineId });
    const owner = createProductionWorkflowConversationOwner({ credentials, machineId: 'coordinator-machine',
      createFreshConversation: unused, resolveSharedRunConversation: unused, resolveProducerConversation: unused,
      resolveExistingSessionConversation: params => resolveWorkflowSessionConversation({ credentials, ...params }) });
    const request: Parameters<typeof owner.prepare>[0] = { runId: 'run-1',
      step: { kind: 'step', id: 'participant', document: { text: 'Give an opinion', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'participant', scope: [] },
        logicalInvocationRecordId: 'current', attempt: '0' },
      execution: selected.selection, executionTarget: selected.executionTarget,
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } };
    {
      // Canonical accepted selection and authenticated Session metadata feed the
      // real conversation, resume, nonce and exact RPC owners without a local
      // Session/Machine projection replacing the producer under test.
      const prepared = await owner.prepare(request);
      expect(prepared.existing).toMatchObject({ sessionId, machineId, directory });
      const ready = owner.materialize(prepared, { ...request, input: { text: 'Give an opinion', references: [], attachments: [], values: [] },
        beforeInputAdmission: async () => {}, onInputAccepted: async () => { throw new Error('Materialization must not accept input'); },
        workspace: { machineId, directory, checkoutRootPath: directory } });
      if (scenario === 'current') {
        const result = await ready.catch(error => ({ error }));
        expect(result, JSON.stringify({ httpPaths, rpcMethods })).toMatchObject({ sessionId, machineId });
        expect(rpcMethods).toEqual([`${machineId}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`, `${machineId}:${RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE}`]);
      } else {
        await expect(ready).rejects.toMatchObject({ code: scenario === 'replaced' ? 'machine_target_not_current' : 'unsupported' });
        expect(rpcMethods).toEqual(scenario === 'replaced' ? [] : [`${machineId}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`]);
      }
      expect(replacementReads).toBe(0);
    }
  });
  it.each(['terminal', 'active', 'wrong_run', 'read_failed'] as const)('reconciles the existing post-stop Run read without another recovery trigger (%s)', async outcome => {
    let stopped = false;
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null },
      machineId: 'machine-1', actionExecutor: { execute: async actionId => {
        if (actionId === 'execution.run.stop') { stopped = true; return { ok: true, result: {} }; }
        if (actionId !== 'execution.run.get') throw new Error('No other action is involved');
        if (stopped && outcome === 'read_failed') return { ok: false, errorCode: 'execution_run_read_unavailable' };
        return { ok: true, result: { run: { runId: stopped && outcome === 'wrong_run' ? 'another-run' : 'native-run',
          callId: 'call', sidechainId: 'side', intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
          status: stopped && outcome !== 'active' ? 'cancelled' : 'running', startedAtMs: 1,
          ...(stopped && outcome !== 'active' ? { finishedAtMs: 2 } : {}), inputTurns: { occurrenceId: 'retained' } } } };
      } } });
    expect(await observe({ progress, terminalParent: true, cancellationRequested: true })).toEqual(outcome === 'terminal'
      ? { kind: 'stopped', code: 'execution_run_input_not_observed' }
      : { kind: 'unresolved', code: 'workflow_outcome_unresolved' });
  });
  it.each(['failed', 'succeeded', 'cancelled'] as const)('retires only terminal-parent custody for a historical %s Run with unknown input effects', async status => {
    const run = { runId: 'native-run', callId: 'call', sidechainId: 'side', intent: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
      status, startedAtMs: 1, finishedAtMs: 2, inputTurns: { occurrenceId: 'retained-occurrence' },
      error: { code: 'connected_service_run_materialization_blocked', message: 'Unattributed historical failure' } };
    let observedRun: unknown = run;
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null },
      machineId: 'machine-1', actionExecutor: { execute: async actionId => {
        if (actionId !== 'execution.run.get') throw new Error('Stopped custody must not issue Stop');
        return { ok: true, result: { run: observedRun } };
      } } });
    const uncertain = { kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' };
    const request = { progress, terminalParent: true, cancellationRequested: true };
    expect(await observe({ ...request, terminalParent: false })).toEqual(uncertain);
    expect(await observe({ ...request, observationOnly: true })).toEqual(uncertain);
    observedRun = { ...run, status: 'running', finishedAtMs: undefined };
    expect(await observe(request)).toMatchObject({ kind: 'unresolved' });
    observedRun = { ...run, status: 'outcome_uncertain' };
    expect(await observe(request)).not.toMatchObject({ kind: 'stopped' });
    observedRun = { ...run, inputTurns: { occurrenceId: 'retained-occurrence', current: {
      turnId: 'another-input', inputIds: ['another-input'], state: 'active' } } };
    expect(await observe(request)).toEqual(uncertain);
    // A terminal native Run cannot still be executing its own exact input.
    // Older Stop producers could retain this active witness after retirement.
    observedRun = { ...run, inputTurns: { occurrenceId: 'retained-occurrence', current: {
      turnId: 'input-1', inputIds: ['input-1'], state: 'active' } } };
    expect(await observe(request)).toEqual({ kind: 'stopped', code: uncertain.code });
    observedRun = { ...run, runId: 'another-run', inputTurns: { occurrenceId: 'retained-occurrence', current: {
      turnId: 'input-1', inputIds: ['input-1'], state: 'active' } } };
    expect(await observe(request)).not.toMatchObject({ kind: 'stopped' });
    observedRun = run;
    expect(await observe(request)).toEqual({ kind: 'stopped', code: uncertain.code });
  });
  it.each([true, false])('keeps a concealed missing Session unresolved even during cancellation (cancelled=%s)', async (cancelled) => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/sessions/c111111111111111111111111') return { status: 404, data: { error: 'Session not found' } };
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: { sessions: [], hasNext: false, nextCursor: null } };
      throw new Error(`Unexpected HTTP boundary: ${path}`);
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { sessions: [] } });
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null },
      machineId: 'machine-1', actionExecutor: { execute: async () => { throw new Error('No detached Run'); } } });
    expect(await observe({ progress: { ...progress, execution: { kind: 'session',
      sessionId: 'c111111111111111111111111', localInputId: 'input-1' } },
      terminalParent: cancelled, cancellationRequested: cancelled })).toEqual({ kind: 'unresolved', code: 'session_not_found' });
  });
  it.each(['local', 'remote', 'mapped', 'wrong-machine', 'missing-machine', 'missing-witness'] as const)
  ('recovers Session continuation only from its retained Machine and selected Agent projection (%s)', async scenario => {
    const sessionId = 'c111111111111111111111111';
    const selectedMachineId = scenario === 'local' ? 'machine-1' : 'participant-machine';
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
      metadata: JSON.stringify({ ...(scenario === 'missing-machine' ? {} : {
        machineId: scenario === 'wrong-machine' ? 'machine-1' : selectedMachineId,
      }), path: scenario === 'mapped' ? 'stack-state/agent-qa-fin2/workspace' : '/repo',
        ...(scenario === 'mapped' ? { sessionWorkspaceLocationV1: { v: 1, machineId: selectedMachineId,
          agentPath: 'stack-state/agent-qa-fin2/workspace', machinePath: '/repo' } } : {}), flavor: 'codex' }) });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
      if (path.includes('/messages/by-local-id/')) throw Object.assign(new Error('Message not found'), {
        isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
      });
      if (path.endsWith('/pending')) return { status: 200, data: { pending: [], version: 0 } };
      throw new Error(`Unexpected HTTP boundary: ${path}`);
    });
    if (scenario === 'mapped') expect(await resolveWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, sessionId, machineId: selectedMachineId,
    })).toMatchObject({ directory: '/repo' });
    const roster = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projection: { v: 2, generation: 1, agentsById: { codex: { id: 'codex', capabilities: {
        sessions: { open: ['resume'], delivery: ['newTurn'], cancel: true },
      } } } } });
    const replacementAware = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('An accepted participant cannot follow a replacement'));
    const exact = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async (request) => {
      expect(request.machineId).toBe(selectedMachineId);
      expect(request.requireCurrentMachine).toBe(true);
      if (request.method === RPC_METHODS.SESSION_CONTINUATION_INSPECT) return { type: 'available', protocolVersion: 1, sameSessionTransition: true };
      if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        // An Agent-only daemon reply is available even when unrelated contribution work cannot finish.
        if (!request.request || typeof request.request !== 'object' || !('selection' in request.request)
          || request.request.selection !== 'agents') throw new Error('Unrelated contribution projection unavailable');
        return roster;
      }
      throw new Error('Unexpected machine RPC');
    });
    expect(await observeWorkflowInvocationRecoveryEvidence({ runId: 'run-1', credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      progress: { ...progress, ...(scenario === 'missing-witness' ? {} : { workspace: { descriptor: {
        machineId: selectedMachineId, directory: '/repo', checkoutRootPath: '/repo',
      } } }), execution: { kind: 'session', sessionId, localInputId: 'input-1' } },
      getRun: async () => { throw new Error('No invented Run'); },
    })).toEqual({ activity: 'unknown', canReattach: scenario === 'local' || scenario === 'remote' || scenario === 'mapped',
      canContinueConversation: scenario === 'local' || scenario === 'remote' || scenario === 'mapped' });
    expect(replacementAware).not.toHaveBeenCalled();
    if (scenario !== 'local' && scenario !== 'remote' && scenario !== 'mapped') expect(exact).not.toHaveBeenCalled();
  });
  it.each(['remote', 'refused', 'wrong-machine', 'missing-witness'] as const)
  ('cancels a retained remote Session input only after verifying its frozen Machine (%s)', async scenario => {
    const sessionId = 'c111111111111111111111111';
    const localId = 'retained-input';
    const machineId = 'participant-machine';
    const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
      metadata: JSON.stringify({ machineId: scenario === 'wrong-machine' ? 'coordinator-machine' : machineId, path: '/repo' }) });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
      if (path.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'question', seq: 1, localId, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } },
      } } };
      if (path.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 2,
        turns: [{ turnId: 'participant-turn', status: 'running', startedAt: 1, updatedAt: 2,
          transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1 } }] } };
      if (path.endsWith('/pending')) return { status: 200, data: { pending: [], version: 0 } };
      throw new Error(`Unexpected HTTP boundary: ${path}`);
    });
    const retire = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (!String(url).endsWith(`/pending/${localId}/discard`)) throw new Error('Unexpected Pending mutation');
      throw Object.assign(new Error('Input already materialized'), { isAxiosError: true,
        response: { status: 404, data: { error: 'not-found' } } });
    });
    const cancel = vi.spyOn(sessionRpc, 'callSessionRpc').mockImplementation(async request => {
      expect(request.sessionId).toBe(sessionId);
      expect(request.request).toEqual({ sessionId, localId });
      return scenario === 'refused' ? { ok: false, status: 'notRunning', sessionId, localId }
        : { ok: true, status: 'cancelled', sessionId, localId };
    });
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null },
      machineId: 'coordinator-machine', actionExecutor: { execute: async () => { throw new Error('No new native work'); } } });
    const result = await observe({ progress: { ...progress,
      ...(scenario === 'missing-witness' ? {} : { workspace: { descriptor: { machineId, directory: '/repo', checkoutRootPath: '/repo' } } }),
      execution: { kind: 'session', sessionId, localInputId: localId } }, terminalParent: true, cancellationRequested: true });
    expect(result).toMatchObject({ kind: 'unresolved', code: scenario === 'remote'
      ? 'session_input_turn_cancel_requested' : scenario === 'refused' ? 'notRunning' : 'workflow_conversation_unavailable',
      waitForCompletion: expect.any(Function) });
    expect(retire).toHaveBeenCalledTimes(scenario === 'remote' || scenario === 'refused' ? 1 : 0);
    expect(cancel).toHaveBeenCalledTimes(scenario === 'remote' || scenario === 'refused' ? 1 : 0);
  });
  it.each(['projects.script.run', 'session.spawn_new', 'execution.run.start'] as const)
  ('recovers strict no-effect setup review without settling or replaying the retained %s', async actionId => {
    const contract = freezeActionCompletionContractV1(projectCommandActionCompletionV1);
    const target = { key: 'command', serverId: 'home', machineId: 'worker', operationId: 'finite-op' };
    const accepted = { version: 1 as const, operationId: target.operationId, revision: 1, actionId, requestId: 'original',
      scope: { accountId: 'account', machineId: target.machineId }, title: 'Script', state: 'accepted' as const,
      cancellation: 'supported' as const, createdAt: 1, domainRef: { kind: 'projectCommand' as const,
        purpose: 'setup' as const, serverId: 'home', machineId: 'worker', workspaceRefId: 'workspace', cwd: '/workspace' } };
    const held = { ...accepted, revision: 2, setupReview: { kind: 'pendingApproval' as const,
      code: 'project_setup_consent_required' as const, reviewedEffectDigest: 'setup', reviewedEffect: { commands: [] } } };
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'controller',
      actionExecutor: { execute: async () => { throw new Error('No replay'); } },
      nativeActionOperations: { get: async () => ({ kind: 'found', operation: held }),
        cancel: async () => { throw new Error('Observation is not Stop'); },
        wait: async () => { throw new Error('Known human review must not start a terminal wait'); } },
    });
    expect(await observe({ progress: { ...progress, blockKind: actionId === 'projects.script.run' ? 'action' : 'step', execution: { kind: 'action',
      actionId: accepted.actionId, actionRequestId: 'original', localInputId: 'original', input: {},
      output: { operation: accepted }, awaitedOperations: [target] } },
      ...(actionId === 'projects.script.run' ? { frozenActionContract: { inputSchema: {}, outputSchema: contract.terminalOutputSchema, completion: contract } } : {}),
      terminalParent: false, cancellationRequested: false,
    })).toMatchObject({ kind: 'unresolved', code: held.setupReview.code, setupConsentOutput: { operation: held } });
  });
  it('retains finite cancellation custody until the exact operation has a terminal outcome', async () => {
    const contract = freezeActionCompletionContractV1(projectCommandActionCompletionV1);
    const target = { key: 'command', serverId: 'home', machineId: 'worker', operationId: 'finite-op' };
    const accepted = { version: 1 as const, operationId: target.operationId, revision: 2, actionId: 'projects.script.run',
      scope: { accountId: 'account', machineId: target.machineId }, title: 'Script', state: 'accepted' as const,
      cancellation: 'supported' as const, createdAt: 1,
      domainRef: { kind: 'projectCommand' as const, purpose: 'script' as const, serverId: 'output-home',
        machineId: 'output-worker', workspaceRefId: 'workspace', cwd: '/workspace' } };
    let terminal = false;
    let stops = 0;
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'controller',
      actionExecutor: { execute: async () => { throw new Error('No replay'); } },
      nativeActionOperations: {
        get: async (address) => { expect(address).toEqual(target); return { kind: 'found', operation: terminal
          ? { ...accepted, revision: 3, state: 'cancelled', startedAt: 1, settledAt: 2 } : accepted }; },
        cancel: async () => { stops++; return { kind: 'requested' }; },
        wait: async () => { terminal = true; return { kind: 'found', operation: { ...accepted, revision: 3,
          state: 'cancelled', startedAt: 1, settledAt: 2 } }; },
      },
    });
    const request = { progress: { ...progress, blockKind: 'action' as const, execution: { kind: 'action' as const,
      actionId: accepted.actionId, actionRequestId: 'request', localInputId: 'request', input: {},
      output: { operation: accepted }, awaitedOperations: [target] } },
      frozenActionContract: { inputSchema: {}, outputSchema: contract.terminalOutputSchema, completion: contract },
      terminalParent: false, cancellationRequested: true };
    expect(await observeWorkflowInvocationRecoveryEvidence({ runId: 'run-1', credentials: { token: 'token', encryption: null },
      machineId: 'controller', progress: request.progress, getRun: async () => { throw new Error('No invented Execution Run'); },
      getOperation: async (address) => { expect(address).toEqual(target); return { kind: 'found', operation: accepted }; } }))
      .toEqual({ activity: 'unknown', canReattach: true, canContinueConversation: false });
    const observing = await observe({ ...request, observationOnly: true });
    expect(observing).toMatchObject({ kind: 'unresolved' });
    expect(stops).toBe(0);
    const pending = await observe(request);
    expect(pending).toMatchObject({ kind: 'unresolved' });
    expect(stops).toBe(1);
    if (pending.kind !== 'unresolved' || !pending.waitForCompletion) throw new Error('Missing exact terminal observation');
    await pending.waitForCompletion();
    expect(await observe(request)).toEqual({ kind: 'cancelled', code: 'cancelled' });
    expect(stops).toBe(1);
  });

  it('does not turn a recovered cold Session startup into a completed Workflow input', async () => {
    const operation = { version: 1, operationId: 'startup', revision: 3, actionId: 'session.spawn_new', requestId: 'original',
      scope: { accountId: 'account', machineId: 'worker' }, title: 'Create', state: 'succeeded',
      cancellation: 'supported', createdAt: 1, startedAt: 1, settledAt: 2, result: { sessionId: 'session' } };
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'worker',
      actionExecutor: { execute: async () => { throw new Error('Startup recovery cannot admit input'); } },
      nativeActionOperations: { get: async () => ({ kind: 'found', operation }),
        cancel: async () => { throw new Error('Terminal startup cannot be stopped again'); },
        wait: async () => { throw new Error('Terminal startup is already observed'); } },
    });
    expect(await observe({ progress: { ...progress, execution: { kind: 'action', actionId: operation.actionId,
      actionRequestId: 'original', localInputId: 'original', input: { creationKey: 'original' }, output: { operation },
      awaitedOperations: [{ key: 'startup', serverId: 'home', machineId: 'worker', operationId: operation.operationId }] } },
      terminalParent: false, cancellationRequested: false,
    })).toEqual({ kind: 'unresolved', code: 'workflow_native_startup_ready' });
  });

  it.each(['completed', 'pending', 'wrong_birth', 'wrong_request'] as const)(
    'observes the exact input after retained startup succeeds (%s)', async scenario => {
      const runId = 'workflow-run';
      const invocationId = progress.logicalInvocationRecordId;
      const creationKey = `workflow:${runId}:${invocationId}`;
      const sessionId = 'created-session';
      const localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: invocationId });
      const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
        sessionCreationTag: deriveWorkflowSessionCreationTag('home', runId,
          scenario === 'wrong_birth' ? 'another-creation' : creationKey),
        recipe: { execution: { machineId: 'worker', directory: { kind: 'path', path: '/repo' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'external.agent', localId: 'agent' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
          configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
          terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
      });
      vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: {
          session: createSessionRecordFixture({ id: sessionId, machineId: 'worker', encryptionMode: 'plain',
            metadata: JSON.stringify({ machineId: 'worker', path: '/repo', sessionCreationCorrespondenceV1: correspondence }) }),
        } };
        throw new Error('Unexpected startup recovery read');
      });
      const operation = { version: 1, operationId: 'startup', revision: 3, actionId: 'session.spawn_new',
        requestId: scenario === 'wrong_request' ? 'another-request' : creationKey,
        scope: { accountId: 'account', machineId: 'worker' }, title: 'Create', state: 'succeeded',
        cancellation: 'supported', createdAt: 1, startedAt: 1, settledAt: 2, result: { sessionId } };
      const observeSession = vi.fn(async () => ({ ok: true as const, sessionId, localId,
        result: scenario === 'pending' ? { kind: 'pending' as const } : { kind: 'final_text' as const, text: 'exact output' } }));
      const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'worker',
        actionExecutor: { execute: async () => { throw new Error('Recovery cannot start an Action'); } },
        observeSession,
        nativeActionOperations: { get: async () => ({ kind: 'found', operation }),
          cancel: async () => { throw new Error('Recovery must not stop healthy startup'); },
          wait: async () => { throw new Error('Startup is terminal'); } },
      });
      const observed = await observe({ run: { id: runId }, index: { id: invocationId, lifecycle: 'running' },
        progress: { ...progress, execution: { kind: 'action', actionId: operation.actionId,
          actionRequestId: creationKey, localInputId: creationKey, input: { creationKey }, output: { operation },
          awaitedOperations: [{ key: 'startup', serverId: 'home', machineId: 'worker', operationId: operation.operationId }] } },
        terminalParent: false, cancellationRequested: false,
      });
      if (scenario === 'wrong_birth' || scenario === 'wrong_request') {
        expect(observed.kind).toBe('unresolved');
        expect(observeSession).not.toHaveBeenCalled();
      } else {
        expect(observed).toMatchObject({ kind: scenario === 'pending' ? 'unresolved' : 'completed',
          ...(scenario === 'completed' ? { result: 'exact output' } : {}),
          execution: { kind: 'session', sessionId, localInputId: localId } });
        if (observed.kind === 'unresolved') expect(observed.waitForCompletion).toBeTypeOf('function');
      }
    });
  it('settles a recorded inputless Session creation without observing or cancelling an invented turn', async () => {
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Creation has no native Run'); } },
      observeSession: async () => { throw new Error('Creation has no input'); },
      cancelSession: async () => { throw new Error('Creation has no turn to cancel'); },
    });
    await expect(observe({ progress: { ...progress, execution: { kind: 'session_ready', sessionId: 'created-session' } },
      terminalParent: false, cancellationRequested: false })).resolves.toEqual({ kind: 'completed', result: '' });
  });

  it.each(['writing', 'complete', 'failed', 'admission_unknown'] as const)('reattaches %s narration without waiting for the retained process to terminate', async (scenario) => {
    const state = scenario === 'admission_unknown' ? 'writing' : scenario;
    const descriptor = { kind: 'review_walkthrough' as const, comparisonId: 'comparison-1' };
    const contract = freezeActionCompletionContractV1(getActionSpec('review.start').completion!);
    const narration = { runId: 'native-run', comparisonId: 'comparison-1', mode: 'continued_review', state: 'collecting' };
    const output = { success: true, sourceKey: 'comparison-1', metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison-1' },
      comparison: { id: 'comparison-1', source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: { before: 'a', after: 'b' },
        inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
      outputs: { walkthrough: { state, ...(state === 'complete' ? { value: { title: 'Changes', intro: '', stops: [], otherChangeRefs: [] } } : {}) } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] },
    };
    const snapshot = { run: { runId: 'native-run', callId: 'call', sidechainId: 'side', intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      ...(scenario === 'admission_unknown' ? { error: { code: 'execution_run_send_outcome_unknown' } } : {}) },
      structuredMeta: { kind: 'scm_diff_summary.v1', payload: output } };
    let outputWaits = 0;
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('No effect during recovery'); } },
      nativeActionRuns: { get: async () => snapshot, stop: async () => { throw new Error('No stop'); },
        wait: async (_runId, _signal, selected) => { expect(selected).toEqual(descriptor); outputWaits++;
          return { ...snapshot, structuredMeta: { ...snapshot.structuredMeta,
            payload: { ...output, outputs: { walkthrough: { state: 'failed' } } } } }; },
      },
    });
    const result = await observe({ progress: { ...progress, blockKind: 'action', execution: {
      kind: 'action', actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {},
      output: { intent: 'review', sessionId: 's1', results: [{ key: 'codex', ok: true, result: { runId: 'native-run' } }], narration },
      awaitedRuns: [{ key: 'codex', runId: 'native-run', observation: descriptor }],
    } }, frozenActionContract: { inputSchema: {}, outputSchema: contract.terminalOutputSchema, completion: contract },
    terminalParent: false, cancellationRequested: false });
    if (scenario === 'admission_unknown') {
      expect(result).toMatchObject({ kind: 'outcome_uncertain' });
      expect(outputWaits).toBe(0);
    } else if (state === 'writing') {
      expect(result.kind).toBe('unresolved');
      if (result.kind !== 'unresolved' || !result.waitForCompletion) throw new Error('Expected output observation');
      await result.waitForCompletion();
      expect(outputWaits).toBe(1);
    } else expect(result).toMatchObject({ kind: 'completed', result: { narration: { outcome: 'completed', runId: 'native-run' } } });
  });
  it('preserves an observed cancelled Session terminal without requesting cancellation again', async () => {
    const cancelSession = vi.fn(async () => ({ kind: 'turn_cancel_requested' as const }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Session observation cannot invoke an Action'); } },
      observeSession: async () => ({ ok: true, sessionId: 'session-1', localId: 'input-1',
        result: { kind: 'cancelled', message: 'stopped', usage: { inputTokens: 2, outputTokens: 3 } } }),
      cancelSession,
    });
    await expect(observe({
      progress: { ...progress, execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' } },
      terminalParent: false, cancellationRequested: true,
    })).resolves.toEqual({ kind: 'cancelled', code: 'session_input_cancelled', usage: { inputTokens: 2, outputTokens: 3 } });
    expect(cancelSession).not.toHaveBeenCalled();
  });
  it.each(['running', 'succeeded'] as const)('reattaches a %s Action through exact native runs without effects or a retained wait', async (status) => {
    const contract = freezeActionCompletionContractV1(getActionSpec('review.start').completion!);
    let reads = 0;
    const execution = { kind: 'action' as const, actionId: 'review.start', actionRequestId: 'request', localInputId: 'request', input: {},
      output: { intent: 'review', sessionId: null, results: [{ key: 'codex', ok: true, result: { runId: 'native-run' } }] },
      awaitedRuns: [{ key: 'codex', runId: 'native-run' }] };
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Action observation bypass'); } },
      nativeActionRuns: { get: async (runId) => { reads++; return { run: {
        runId, callId: 'call', sidechainId: 'side', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response', status, startedAtMs: 1,
      }, latestToolResult: { findings: [], reviewedFingerprint: 'fingerprint', commentIds: ['comment'], materialization: { kind: 'complete' } } }; },
      stop: async () => { throw new Error('Observation-only stop'); },
      wait: async () => { throw new Error('Observation-only wait'); } },
    });
    const observed = await observe({ progress: { ...progress, blockKind: 'action', execution }, frozenActionContract: {
      inputSchema: {}, outputSchema: contract.terminalOutputSchema, completion: contract },
      terminalParent: false, cancellationRequested: false, observationOnly: true });
    if (status === 'running') expect(observed).toEqual({ kind: 'unresolved', code: 'execution_run_input_pending' });
    else expect(observed).toMatchObject({ kind: 'completed', result: { reviewedFingerprint: 'fingerprint', commentIds: ['comment'],
      perEngineOutcome: [{ key: 'codex', runId: 'native-run', outcome: 'completed' }] } });
    expect(reads).toBe(1);
  });
  it('never settles an invocation from another native execution run', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { run: {
      runId: 'another-native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      status: 'running', startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'completed', result: { kind: 'text', value: 'wrong result' } } },
    } } }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute } as Parameters<typeof createWorkflowInvocationRecoveryObserver>[0]['actionExecutor'],
    });
    expect(await observe({ progress, terminalParent: false, cancellationRequested: false }))
      .toEqual({ kind: 'outcome_uncertain', code: 'execution_run_correspondence_mismatch' });
  });
  it('reattaches a stop-pending input by observation without requesting another effect', async () => {
    // The native transport is the boundary; exact-turn classification remains real.
    const execute = vi.fn(async (_actionId: string, _input: unknown, _context: unknown) => ({ ok: true as const, result: { run: {
      runId: 'native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default',
      retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      status: 'running', startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'active' } },
    } } }));
    const observe = createWorkflowInvocationRecoveryObserver({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute } as Parameters<typeof createWorkflowInvocationRecoveryObserver>[0]['actionExecutor'],
    });
    const result = await observe({ progress, terminalParent: false, cancellationRequested: true,
      ...{ observationOnly: true } });
    expect(result).toEqual({ kind: 'unresolved', code: 'execution_run_input_pending' });
    expect(execute.mock.calls.map((call) => call[0])).toEqual(['execution.run.get']);
  });
});
