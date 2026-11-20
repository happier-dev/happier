import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createSocketTransportAdapter, socketRpcCodec } from '@happier-dev/sync-client';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import type { ExecutionRunController, ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit/runtime';
import { sendBackendLongLivedRun } from '@/agent/runtime/bridges/executionRun/send/backendLongLivedPrompt';
import { finishExecutionRun } from '@/agent/runtime/bridges/executionRun/finishExecutionRun';
import { createExecutionRunCodedError } from '@/agent/runtime/bridges/executionRun/errors';
import { projectExecutionRunPublicState } from '@/agent/runtime/bridges/executionRun/publicState';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { createWorkflowInvocationRecoveryObserver } from './invocationRecoveryObserver';
import { createWorkflowInvocationRecoveryFactWriter } from './recovery';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { readSessionMessageModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const machineRpc = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
const machineSockets = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, ...http } };
});
vi.mock('@/api/session/sockets', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createUserScopedSocketConnection: machineSockets.connect,
  createSessionScopedSocketConnection: () => {
    const socket = createApiSessionSocketStub({ connected: true });
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));

const sessionId = 'c123456789012345678901234';

import {
  enqueueWorkflowSessionInput,
  observeWorkflowSessionInputResult,
  classifyWorkflowSessionInputResult,
  observeWorkflowDetachedExecutionRunInput,
} from './stepExecution';
import { createProductionWorkflowSessionStepExecutor } from './sessionStepExecutor';

describe('Workflow Session step execution', () => {
  it('CC1 carries a fulfilled quota failure into the Workflow reason', () => {
    const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 1, failureCause: { phase: 'client_start', failureReason: 'usage_limit', retryable: false } } as const;
    const outcome = { kind: 'failed' as const, runtimeIssueV1 };
    expect(classifyWorkflowSessionInputResult({ kind: 'fulfilled', outcome })).toMatchObject({ kind: 'needs_attention', runtimeIssueV1 });
  });
  it.each([
    { outcome: { kind: 'pass' as const }, expected: { kind: 'completed', result: '' } },
    { outcome: { kind: 'terminal_no_result' as const }, expected: { kind: 'needs_attention', code: 'session_input_result_unavailable' } },
    { outcome: { kind: 'cancelled' as const }, expected: { kind: 'cancelled' } },
    { outcome: { kind: 'failed' as const }, expected: { kind: 'failed', code: 'session_input_failed' } },
  ])('classifies the original Workflow reply $outcome.kind without waiting for another final', ({ outcome, expected }) => {
    expect(classifyWorkflowSessionInputResult({ kind: 'fulfilled', outcome })).toMatchObject({ ...expected, replyOutcome: outcome });
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    machineRpc.callMachineRpc.mockReset();
    http.get.mockReset();
    http.post.mockReset();
    machineSockets.connect.mockImplementation(() => {
      const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        // Preserve the real exact-Machine policy and codec beneath Socket.IO.
        const call = payload as { method: string; params: unknown };
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
        const result = await machineRpc.callMachineRpc({
          method: call.method.slice('machine-1:'.length), request: decoded.params,
        });
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) };
      } });
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'none' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200,
        data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
          updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } },
      };
      if (url.endsWith('/v1/machines/machine-1')) return { status: 200, data: {
        machine: { ...createAvailableSessionSpawnMachineSnapshot('machine-1'), storageMode: 'plain' },
      } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return {
        status: 200,
        data: { session: createSessionRecordFixture({
          id: sessionId, active: true, encryptionMode: 'plain',
          machineId: 'machine-1',
          metadata: JSON.stringify({ machineId: 'machine-1' }),
        }) },
      };
      throw new Error(`Unexpected read: ${url}`);
    });
  });

  it.each([
    { outcome: { kind: 'pass' as const }, acceptedTurnId: 'accepted-turn', classified: { kind: 'completed', result: '' } },
    { outcome: { kind: 'answer' as const, publicationRef: { kind: 'session' as const,
      session: { serverId: 'home', sessionId: 'other-session' }, messageId: 'explicit-publication' } },
      acceptedTurnId: 'accepted-turn',
      classified: { kind: 'needs_attention', code: 'session_input_result_unavailable' } },
    { outcome: { kind: 'failed' as const }, acceptedTurnId: undefined, classified: { kind: 'failed', code: 'session_input_failed' } },
  ])('admits a Workflow reply under its existing V2 local id and rejoins explicit $outcome.kind', async ({ outcome, acceptedTurnId, classified }) => {
    const previousGet = http.get.getMockImplementation()!;
    const workflow = { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'reply-invocation' } as const;
    let originalLocalId = '';
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (url.endsWith(`/by-local-id/${encodeURIComponent(originalLocalId)}/reply`)) return { status: 200, data: { v: 1, status: 'available',
        progress: { v: 1, mode: 'wait', disposition: 'observing', workflow, ...(acceptedTurnId ? { acceptedTurnId } : {}), outcome } } };
      if (url.endsWith(`/by-local-id/${encodeURIComponent(originalLocalId)}`)) return { status: 200, data: { message: {
        id: 'original-row', localId: originalLocalId, seq: 1, createdAt: 100, updatedAt: 100,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Review' } } },
      } } };
      return previousGet(url);
    });
    const admitted: unknown[] = [];
    const admission = await enqueueWorkflowSessionInput({ credentials: { token: 'token', encryption: null }, sessionId,
      workflow, text: 'Review',
      machineAdmissionTransport: async request => {
        originalLocalId = request.localId;
        admitted.push(request);
        return { status: 'accepted', localId: request.localId };
      } });
    expect(admission).toEqual({ status: 'accepted', localId: originalLocalId });
    expect(admitted).toEqual([expect.objectContaining({ reply: { mode: 'wait', workflow }, content: { t: 'plain', v: expect.objectContaining({
      meta: expect.objectContaining({ happierInputRequestV1: expect.objectContaining({ v: 2, producer: 'workflow',
        workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'reply-invocation' }, replyIntent: { mode: 'wait' } }) }),
    }) } })]);
    const observe = () => observeWorkflowSessionInputResult({ credentials: { token: 'token', encryption: null }, sessionId,
      localId: originalLocalId, deadlineMs: Date.now() });
    const observed = await observe();
    expect(observed).toMatchObject({ ok: true, localId: originalLocalId, replyOutcome: outcome,
      result: { kind: 'fulfilled', outcome } });
    if (!observed.ok) throw new Error('Workflow reply observation failed');
    expect(classifyWorkflowSessionInputResult(observed.result, observed.replyOutcome)).toMatchObject({ ...classified, replyOutcome: outcome });
    await expect(observe()).resolves.toMatchObject({ ok: true, localId: originalLocalId, replyOutcome: outcome });
    expect(admitted).toHaveLength(1);
  });

  it('reattaches an observing Workflow reply after the immediate recovery read', async () => {
    const previousGet = http.get.getMockImplementation()!;
    const localId = 'retained-workflow-input';
    const workflow = { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'reply-invocation' } as const;
    let replied = false;
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith(`/by-local-id/${localId}/reply`)) return { status: 200, data: { v: 1, status: 'available',
        progress: { v: 1, mode: 'wait', disposition: 'observing', workflow, acceptedTurnId: 'retained-turn',
          ...(replied ? { outcome: { kind: 'pass' } } : {}) } } };
      if (url.endsWith(`/by-local-id/${localId}`)) return { status: 200, data: { message: {
        id: 'retained-user-row', localId, seq: 1, createdAt: 100, updatedAt: 100,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Review' } } },
      } } };
      return previousGet(url);
    });
    const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      actionExecutor: { execute: async () => { throw new Error('Recovery cannot replay an Action'); } } });
    const input = { progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
      invocationPath: { blockId: 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: workflow.invocationRecordId,
      execution: { kind: 'session', sessionId, localInputId: localId } }, terminalParent: false, cancellationRequested: false } as const;

    const pending = await observe(input);
    expect(pending).toMatchObject({ kind: 'unresolved', code: 'session_input_pending', waitForCompletion: expect.any(Function) });
    if (pending.kind !== 'unresolved' || !pending.waitForCompletion) throw new Error('Missing exact reply observation');
    replied = true;
    await pending.waitForCompletion();
    await expect(observe(input)).resolves.toMatchObject({ kind: 'completed', result: '', replyOutcome: { kind: 'pass' } });
  });

  it('resumes an offline Workflow target with frozen native launch intent through Session input admission', async () => {
    const model = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'incoming-model' };
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.endsWith(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: false,
          encryptionMode: 'plain', machineId: 'machine-1', path: '/repo',
          metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo',
            runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, claudeSessionId: 'saved-native',
            permissionMode: 'read-only', permissionModeUpdatedAt: 200 }),
        }) } }
      : previousGet(url));
    machineRpc.callMachineRpc.mockResolvedValue({ type: 'success', sessionId });
    const admission = await enqueueWorkflowSessionInput({ credentials: { token: 'token', encryption: null }, sessionId,
      workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'invocation-1' }, text: 'Work',
      permissionMode: 'default', modelSelectionInput: model, modelSelectionUpdatedAt: 200,
      incomingResumeOptions: { permissionMode: 'default', permissionModeUpdatedAt: 200,
        modelSelection: { v: 1, ref: model, updatedAt: 200 },
        resume: 'incoming-native', environmentVariables: { PREDECESSOR_RUN: 'literal value' } },
      machineAdmissionTransport: async request => ({ status: 'accepted', localId: request.localId }),
    });
    expect(admission).toMatchObject({ status: 'accepted' });
    expect(machineRpc.callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      type: 'resume-session', sessionId, resume: 'incoming-native',
      environmentVariables: { PREDECESSOR_RUN: 'literal value' }, permissionMode: 'default', permissionModeUpdatedAt: 200,
      modelSelection: { v: 1, ref: model, updatedAt: 200 },
    });
  });

  it('readies an existing offline Session without inventing a Workflow input', async () => {
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.endsWith(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: false,
          encryptionMode: 'plain', machineId: 'machine-1', path: '/repo', metadata: JSON.stringify({
            machineId: 'machine-1', path: '/repo', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
            claudeSessionId: 'saved-native',
          }) }) } } : previousGet(url));
    machineRpc.callMachineRpc.mockResolvedValue({ type: 'success', sessionId });
    machineRpc.callMachineRpc.mockImplementation(async ({ method }: Readonly<{ method: string }>) => method === RPC_METHODS.SPAWN_HAPPY_SESSION
      ? { type: 'success', sessionId } : { status: 'success', sessionId });
    const ready: unknown[] = [];
    const execute = createProductionWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
      machineId: 'machine-1', machineAdmissionTransport: async () => { throw new Error('No Session input exists'); },
      createFreshConversation: async () => { throw new Error('An existing Session cannot be replaced'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId, machineId: 'machine-1', directory: '/repo' }),
    });
    await expect(execute({ runId: 'run-1', invocationRecordId: 'invocation-1',
      step: { kind: 'step', id: 'ready', inputMode: 'none', document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'ready', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: '', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'existing_session', sessionId, machineId: 'machine-1' },
        environmentVariables: { PREDECESSOR_RUN: 'literal value' }, providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'incoming-native' },
        profileId: 'incoming-profile', acpSessionModeId: 'incoming-mode', transcriptStorage: 'persisted',
        terminal: { mode: 'plain' }, windowsRemoteSessionLaunchMode: 'windows_terminal', windowsTerminalWindowName: 'Incoming window',
        capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        connectedServices: { v: 2, bindingsByServiceId: {} },
      },
      executionTarget: { kind: 'session' }, workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, beforeInputAdmission: async () => {},
      onInputAccepted: async () => { throw new Error('No input receipt exists'); }, onSessionReady: async value => { ready.push(value); },
    })).resolves.toEqual({ kind: 'completed', result: '' });
    expect(ready).toEqual([{ kind: 'session_ready', sessionId }]);
    expect(machineRpc.callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session', sessionId,
      resume: 'incoming-native', environmentVariables: { PREDECESSOR_RUN: 'literal value' }, profileId: 'incoming-profile',
      agentModeId: 'incoming-mode', transcriptStorage: 'persisted', terminal: { mode: 'plain' },
      windowsRemoteSessionLaunchMode: 'windows_terminal', windowsTerminalWindowName: 'Incoming window',
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      connectedServices: { v: 2, bindingsByServiceId: {} },
    });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('rejects failed explicit existing Session readiness before Pending admission or an input receipt', async () => {
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.endsWith(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: false,
          encryptionMode: 'plain', machineId: 'machine-1', path: '/repo', metadata: JSON.stringify({
            machineId: 'machine-1', path: '/repo', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
            claudeSessionId: 'saved-native',
          }) }) } } : previousGet(url));
    machineRpc.callMachineRpc.mockResolvedValue({ type: 'error', errorCode: 'UNEXPECTED', errorMessage: 'Runner launch rejected' });
    const pending: unknown[] = [];
    const receipts: unknown[] = [];
    const interruption = new AbortController();
    const execute = createProductionWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
      machineId: 'machine-1', machineAdmissionTransport: async request => {
        pending.push(request); return { status: 'accepted', localId: request.localId };
      },
      createFreshConversation: async () => { throw new Error('An existing Session cannot be replaced'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId, machineId: 'machine-1', directory: '/repo' }),
    });
    const outcome = await execute({ runId: 'run-1', invocationRecordId: 'invocation-1',
      step: { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'Work', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'existing_session', sessionId, machineId: 'machine-1' },
        environmentVariables: { PREDECESSOR_RUN: 'literal value' } },
      executionTarget: { kind: 'session' }, workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, beforeInputAdmission: async () => {},
      signal: interruption.signal,
      onInputAccepted: async receipt => {
        receipts.push(receipt);
        // Interrupt only an incorrect queue-first implementation after its real
        // accepted receipt so the test never waits on an offline Agent turn.
        interruption.abort('test_claim_interrupted');
      },
    }).catch(error => error);
    expect(pending).toEqual([]);
    expect(receipts).toEqual([]);
    expect(outcome).toEqual({ kind: 'failed', code: 'resume_failed' });
  });

  it('admits the current Workflow input with the canonical Session admission budget', async () => {
    vi.stubEnv('HAPPIER_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS', '90000');
    vi.stubEnv('HAPPIER_SESSION_STOP_TIMEOUT_MS', '1');
    const machineAdmissionTransport = vi.fn(async (request) => ({
      status: 'accepted' as const, localId: request.localId,
    }));
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null },
      sessionId,

      workflow: {
        purpose: 'invocation',
        runId: 'run-1',
        invocationRecordId: 'invocation-1',
      },
      text: 'Do the work',
      machineAdmissionTransport,
    })).resolves.toEqual({ status: 'accepted', localId: expect.any(String) });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({ sessionId }), {
      timeoutMs: resolveSessionMessageAdmissionTimeoutMs(),
    });
  });

  it.each([
    { modelId: 'default', providerConnectionId: undefined, reset: true },
    { modelId: null, providerConnectionId: undefined, reset: true },
    { modelId: 'default', providerConnectionId: null, reset: true },
    { modelId: 'default', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), reset: false },
    { modelId: 'native-model', providerConnectionId: null, reset: false },
  ])('normalizes Action and Workflow model sends together: $modelId / $providerConnectionId', async ({ modelId, providerConnectionId, reset }) => {
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.endsWith(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: true,
          encryptionMode: 'plain', machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex',
            modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: {
              agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_pending', modelId: 'pending-model',
            } },
          }),
        }) } } : previousGet(url));
    type Request = Parameters<NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>>[0];
    const contents: Request['content'][] = [];
    http.post.mockImplementation(async (_url: string, body: { content: Request['content'] }) => {
      contents.push(body.content);
      return { status: 200, data: { didWrite: true, terminal: false, suppressed: false } };
    });
    const machineAdmissionTransport = async (request: Request) => {
      contents.push(request.content);
      return { status: 'accepted' as const, localId: request.localId };
    };
    const credentials = { token: 'token', encryption: null };
    const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
      machineAdmissionTransport });
    await expect(deps.sessionSendMessage!({ sessionId, message: 'Work', callerSurface: 'cli',
      actionCaller: { kind: 'host' }, context: { surface: 'cli', authority: 'present_user' },
      localId: 'ordinary-model-input', wait: false, requestedAction: { v: 1, kind: 'enqueue' },
      modelOverride: modelId, ...(providerConnectionId === undefined ? {} : { providerConnectionId }),
    })).resolves.toMatchObject({ status: 'accepted' });
    await expect(enqueueWorkflowSessionInput({ credentials, sessionId, text: 'Work',
      workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'model-input' },
      modelSelectionInput: { modelId, ...(providerConnectionId === undefined ? {} : { providerConnectionId }) },
      modelSelectionUpdatedAt: 0, machineAdmissionTransport,
    })).resolves.toMatchObject({ status: 'accepted' });
    const selections = contents.map(content => {
      if (content.t !== 'plain') throw new Error('Expected plain Account input');
      const message = content.v;
      if (!message || typeof message !== 'object' || Array.isArray(message) || !('meta' in message)) {
        throw new Error('Expected serialized Session message metadata');
      }
      const selection = readSessionMessageModelSelectionV1(message.meta);
      expect(selection.status).toBe(reset ? 'absent' : 'valid');
      if (selection.status === 'valid') expect(selection.selection.ref).toMatchObject({ providerConnectionId, modelId });
      if (reset || providerConnectionId !== null) expect(message.meta).not.toHaveProperty('model');
      else expect(message.meta).toMatchObject({ model: modelId });
      return selection;
    });
    expect(selections).toHaveLength(2);
    expect(selections[1]).toEqual(selections[0]);
  });



  it('carries an explicit current Team V2 choice into the active Session raw input', async () => {
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.endsWith(`/v2/sessions/${sessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, active: true,
          encryptionMode: 'plain', machineId: 'machine-1',
          metadata: JSON.stringify({ machineId: 'machine-1', flavor: 'codex' }),
        }) } } : previousGet(url));
    const ref = { source: 'team_resource' as const, teamId: 'team-1', resourceId: 'resource-1',
      expectedResourceRevision: 2, deliveryMode: 'brokered' as const,
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'muse-current' };
    let admitted = false;
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null }, sessionId, text: 'Work',
      workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'team-current' },
      modelSelectionInput: ref, modelSelectionUpdatedAt: 42,
      machineAdmissionTransport: async request => {
        expect(request.content.t).toBe('plain');
        if (request.content.t !== 'plain') throw new Error('Expected plain Account input');
        const message = request.content.v;
        if (!message || typeof message !== 'object' || !('meta' in message)) throw new Error('Expected raw message');
        expect(readSessionMessageModelSelectionV1(message.meta)).toEqual({ status: 'valid',
          selection: { v: 2, updatedAt: 42, ref } });
        expect(message.meta).not.toHaveProperty('model');
        admitted = true;
        return { status: 'accepted', localId: request.localId };
      },
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(admitted).toBe(true);
  });

  it('authors portable attachments in the canonical raw Session structured-input envelope', async () => {
    const attachment = {
      v: 1 as const, instanceId: 'workflow-attachment-1',
      attachment: { pluginId: 'acme.review', localId: 'review-context' }, key: 'review-42',
      value: { reviewId: 42 }, presentation: { label: 'Review 42', typeLabel: 'Review' },
    };
    const machineAdmissionTransport = vi.fn(async (request) => ({
      status: 'accepted' as const,
      localId: request.localId,
    }));
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null }, sessionId,

      workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'inv-1' },
      text: 'Review', attachments: [attachment], machineAdmissionTransport,
    })).resolves.toEqual({ status: 'accepted', localId: expect.any(String) });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      content: { t: 'plain', v: expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
        }),
      }) },
    }), { timeoutMs: resolveSessionMessageAdmissionTimeoutMs() });
  });

  it('rejects a frozen invocation identity that does not match the canonical Session identity', async () => {
    const machineAdmissionTransport = vi.fn();
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null }, sessionId,

      workflow: { purpose: 'invocation', runId: 'workflow-run-1', invocationRecordId: 'invocation-1' },
      localInputId: 'wrong-frozen-id',
      text: 'Done',
      machineAdmissionTransport,
    })).resolves.toEqual({ status: 'rejected', code: 'session_input_invalid' });
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
  });

  it('carries accepted workflow depth and request attribution through protected Session admission', async () => {
    const attribution = { requestRef: 'accepted-input', requester: { serverId: 'home', accountId: 'bob' },
      persona: { serverId: 'home', sessionId: 'release-bot' }, origin: null };
    const machineAdmissionTransport = vi.fn(async (request) => ({
      status: 'accepted' as const, localId: request.localId,
    }));
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null }, sessionId,

      workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'inv-1' },
      workDepth: 3,
      actionRequestAttributionV1: attribution,
      text: 'Work', machineAdmissionTransport,
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
        happierProvenanceV1: expect.objectContaining({ kind: 'workflow_invocation', workDepth: 3 }),
        happierInputRequestV1: expect.objectContaining({ workflow: expect.objectContaining({ workDepth: 3 }), actionRequestAttributionV1: attribution }),
      }) }) },
    }), { timeoutMs: resolveSessionMessageAdmissionTimeoutMs() });
  });

  it('keeps Workflow V2 provenance on the exact attached Execution Run target', async () => {
    const machineAdmissionTransport = vi.fn(async (request) => ({
      status: 'accepted' as const,
      localId: request.localId,
    }));
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null }, sessionId,

      workflow: { purpose: 'invocation', runId: 'workflow-run-1', invocationRecordId: 'inv-1' },
      executionRunTarget: { runId: 'execution-run-1', resultContract: { kind: 'text' } },
      text: 'Continue the attached run',
      machineAdmissionTransport,
    })).resolves.toEqual({ status: 'accepted', localId: expect.any(String) });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      recipient: { kind: 'execution_run', runId: 'execution-run-1' },
      content: { t: 'plain', v: expect.objectContaining({
        meta: expect.objectContaining({
          happier: {
            kind: 'participant_message.v1',
            payload: { recipient: { kind: 'execution_run', runId: 'execution-run-1' } },
          },
          happierProvenanceV1: {
            v: 2,
            kind: 'workflow_invocation',
            runId: 'workflow-run-1',
            invocationRecordId: 'inv-1',
          },
        }),
      }) },
    }), { timeoutMs: resolveSessionMessageAdmissionTimeoutMs() });
  });
});

describe('Workflow detached Execution Run step execution', () => {
  it('keeps an unmatched failed Run uncertain without evidence of its initial input', async () => {
    expect(await observeWorkflowDetachedExecutionRunInput({ runId: 'run-1', localInputId: 'workflow-input-1',
      get: async () => ({ run: { runId: 'run-1', callId: 'call', sidechainId: 'side', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'default',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
        status: 'failed', startedAtMs: 1, finishedAtMs: 2,
        error: { code: 'execution_run_failed', message: 'Launch failed before native input admission' } } }),
    })).toEqual({ kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' });
  });
  it('retires terminal-parent custody without attributing a later input failure to completed A', async () => {
    let nativeInput: string | undefined;
    const { runtime } = createTestExecutionRunHostRuntime({
      deliverInput: async (_runtimeId, _input, meta) => { nativeInput = meta?.localId ?? undefined; return { status: 'admitted' }; },
      waitForTurnCompletion: async () => {
        if (nativeInput === 'B') throw createExecutionRunCodedError('claude_authentication_failed', 'OAuth token revoked');
      },
    });
    const run: ExecutionRunState = {
      runId: 'exact-input-run', callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
      intent: 'agent', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
      ioMode: 'request_response', status: 'running', startedAtMs: 1,
    };
    const controller: ExecutionRunBackendController = {
      kind: 'backend', controllerOccurrenceId: 'exact-input-occurrence', backend: runtime, backendSupportsResume: true,
      runtimeId: 'native', buffer: '', sidechainStreamBuffer: '', sidechainStreamKey: '', streamWriter: null,
      cancelled: false, turnCount: 0, turnEpoch: 0, turnInFlight: false, turnCancelReason: null, turnCancelEpoch: null,
      admittedLiveInterventions: [], admittedLiveInterventionsSignal: null, lastMarkerWriteAtMs: 0,
      pendingHostBarrier: Promise.resolve(), terminalPromise: Promise.resolve(), resolveTerminal: () => {},
    };
    const runs = new Map([[run.runId, run]]);
    const controllers = new Map<string, ExecutionRunController>([[run.runId, controller]]);
    const get = async () => ({ run: projectExecutionRunPublicState(runs.get(run.runId)!, controllers.get(run.runId) ?? null) });
    let firstFailureObservation: ReturnType<typeof observeWorkflowDetachedExecutionRunInput> | undefined;
    // Native execution, transcript/marker I/O and Home storage are the only substituted boundaries.
    // Admission, turn replacement, terminalization, projection, observation and recovery stay real.
    const send = (localInputId: string) => sendBackendLongLivedRun({
      runId: run.runId, params: { message: `Work on ${localInputId}`, delivery: 'prompt',
        localInputId, resultContract: { kind: 'text' } }, runs, controllers,
      budgetRegistry: null, createRuntime: () => runtime, maxTurns: null, getNowMs: () => 2,
      finishRun: async (runId, next, toolResult) => { await finishExecutionRun({ runId, next, toolResult,
        runs, controllers, budgetRegistry: null, parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
        enqueueMarkerWrite: async () => {}, terminalMarkerWritePromises: new Map() }); },
      sendAcp: async () => {}, parentProvider: 'daemon.executionRuns', streamedTranscriptSession: null,
      writeActivityMarker: async () => {},
      onPublicStateUpdated: () => {
        if (runs.get(run.runId)?.inputTurns?.last?.state === 'failed') {
          firstFailureObservation ??= observeWorkflowDetachedExecutionRunInput({ runId: run.runId, localInputId: 'B', get });
        }
      },
    });
    try {
      expect(await send('A')).toEqual({ ok: true });
      await vi.waitFor(() => expect(runs.get(run.runId)?.inputTurns?.last?.state).toBe('completed'));
      expect(await observeWorkflowDetachedExecutionRunInput({ runId: run.runId, localInputId: 'A', get }))
        .toEqual({ kind: 'completed', result: '' });
      expect(await send('B')).toEqual({ ok: true });
      await vi.waitFor(() => expect(runs.get(run.runId)?.status).toBe('failed'));
      expect(await firstFailureObservation)
        .toEqual({ kind: 'failed', code: 'claude_authentication_failed', message: 'OAuth token revoked' });
      expect((await get()).run.inputTurns?.last).toMatchObject({ inputIds: ['B'], state: 'failed' });
      expect(await observeWorkflowDetachedExecutionRunInput({ runId: run.runId, localInputId: 'B', get }))
        .toEqual({ kind: 'failed', code: 'claude_authentication_failed', message: 'OAuth token revoked' });
      expect(await observeWorkflowDetachedExecutionRunInput({ runId: run.runId, localInputId: 'A', get }))
        .toEqual({ kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' });

      const workflowRunId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
      const rootId = '33333333-3333-4333-8333-333333333333';
      const childId = '44444444-4444-4444-8444-444444444444';
      const accountId = 'account-1';
      const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'step',
        document: { text: 'Work on A', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
      const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: workflowRunId },
        acceptedSnapshot: { startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {},
          materializedLeaves: [{ sourceKey: '$root', blockId: 'step', kind: 'step', authoredWorkspace: { kind: 'inherit' },
            selection: {}, executionTarget: { kind: 'detached_run' } }], source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
          executionTarget: { kind: 'detached_run' },
          workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo', workspaceRefId: 'workspace-1' },
            originalCommittedRevision: 'a'.repeat(40) }, origin: { kind: 'direct', originSessionId: 'session-origin' },
          authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
          resultDelivery: { kind: 'originating_session', originSessionId: 'session-origin' },
        },
      }));
      const kit = createWorkflowRunStorageTestkit({ runId: workflowRunId, machineId: 'machine-1', origin: { kind: 'direct' }, acceptedEnvelope });
      const seal = (id: string, root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId: workflowRunId, recordId: id,
          sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
          invocationPath: { blockId: root ? '$root' : 'step', scope: [] }, attempt: '0', logicalInvocationRecordId: id,
          ...(root ? {} : { execution: { kind: 'detached_run' as const, runId: run.runId, localInputId: 'A', runtimeSelection: {} } }) },
      }));
      const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'checkpoint', accountId, runId: workflowRunId },
        checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2',
          frontier: { nextBlockOrdinal: 1, paused: false } },
      }));
      await kit.execute({ operation: 'initialize', runId: workflowRunId, expectedRevision: 0, checkpointEnvelope,
        rootInvocation: { id: rootId, contentEnvelope: seal(rootId, true) } });
      await kit.execute({ operation: 'invocations.admit', runId: workflowRunId, expectedRevision: 1, checkpointEnvelope,
        invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0',
          lifecycle: 'outcome_uncertain', contentEnvelope: seal(childId, false) }] });
      kit.requestControl('cancelled');
      const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: kit.run(), parentAttempt: 0, storage: kit,
        encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
      const invocation = await writer.readInvocation(childId);
      if (!invocation) throw new Error('Missing retained A');
      const observe = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
        actionExecutor: { execute: async actionId => {
          if (actionId === 'execution.run.get') return { ok: true, result: await get() };
          throw new Error('An unmatched input cannot authorize Stop or new work');
        } },
      });
      const lateA = await observe({ progress: WorkflowProgressEnvelopeV1Schema.parse(invocation.progress),
        terminalParent: true, cancellationRequested: true });
      expect.soft(lateA).toEqual({ kind: 'stopped', code: 'execution_run_input_not_observed' });
      const interruptedWriter = createWorkflowInvocationRecoveryFactWriter({ accountId, run: { ...kit.run(), state: 'interrupted' },
        parentAttempt: 0, storage: kit,
        encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
      expect(await interruptedWriter.commitObservation(invocation, lateA)).toBeNull();
      expect(kit.rowById(childId)?.index.lifecycle).toBe('outcome_uncertain');
      await writer.commitObservation(invocation, lateA);
      const retired = await writer.readInvocation(childId);
      expect.soft(retired?.index.lifecycle).toBe('cancelled');
      expect.soft(retired?.progress).toMatchObject({ uncertainPriorEffects: { activity: 'stopped' },
        reason: { code: 'execution_run_input_not_observed' } });
      expect.soft(retired?.progress.result).toBeUndefined();
      expect(retired?.progress.reason).not.toHaveProperty('message');
    } finally { await runtime.dispose(); }
  });
  it('rejoins only the exact input turn and returns its typed result', async () => {
    const get = vi.fn(async () => ({
      run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', status: 'running', startedAtMs: 1,
        inputTurns: {
          occurrenceId: 'occurrence-1',
          last: {
            turnId: 'turn-2', inputIds: ['workflow-input-1'], state: 'completed',
            result: { kind: 'json', value: { changed: true } },
          },
        },
      },
    }));
    await expect(observeWorkflowDetachedExecutionRunInput({
      runId: 'run-1',
      localInputId: 'workflow-input-1',
      get,
    })).resolves.toEqual({ kind: 'completed', result: { changed: true } });
  });

  it.each([
    { code: 'workflow_interaction_capacity_exceeded', message: 'Workflow interaction exceeds durable capacity' },
    { code: 'ERR_BAD_REQUEST', message: 'Request failed with status code 409' },
  ])('returns $code from the exact failed Run input instead of leaving it pending', async error => {
    const get = vi.fn(async () => ({
      run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', status: 'failed', startedAtMs: 1, finishedAtMs: 2,
        error,
        inputTurns: {
          occurrenceId: 'occurrence-1',
          last: { turnId: 'turn-1', inputIds: ['workflow-input-1'], state: 'failed' },
        },
      },
    }));

    await expect(observeWorkflowDetachedExecutionRunInput({
      runId: 'run-1', localInputId: 'workflow-input-1', get,
    })).resolves.toEqual({ kind: 'failed', ...error });
  });

  it.each(['running', 'succeeded', 'failed'] as const)('does not treat another turn or %s Run status as exact input proof', async status => {
    const get = vi.fn(async () => ({
      run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', status, startedAtMs: 1, ...(status === 'running' ? {} : { finishedAtMs: 2 }),
        inputTurns: {
          occurrenceId: 'occurrence-1',
          last: { turnId: 'turn-other', inputIds: ['other-input'], state: 'completed' },
        },
      },
    }));
    await expect(observeWorkflowDetachedExecutionRunInput({
      runId: 'run-1', localInputId: 'workflow-input-1', get,
    })).resolves.toEqual({ kind: 'outcome_uncertain', code: 'execution_run_input_not_observed' });
  });

  it('keeps observing an admitted attached input until Session Pending reaches the Run', async () => {
    const get = vi.fn(async () => ({
      run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', status: 'running', startedAtMs: 1,
      },
    }));
    await expect(observeWorkflowDetachedExecutionRunInput({
      runId: 'run-1', localInputId: 'workflow-input-1', get,
    })).resolves.toEqual({ kind: 'pending' });
  });
});
