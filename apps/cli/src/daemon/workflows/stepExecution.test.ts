import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const machineRpc = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('axios', () => ({ default: { ...http, isAxiosError: () => false } }));
vi.mock('@/session/transport/rpc/machineRpc', () => machineRpc);

const sessionId = 'c123456789012345678901234';

import {
  enqueueWorkflowSessionInput,
  observeWorkflowDetachedExecutionRunInput,

  sendWorkflowDetachedExecutionRunInput,
} from './stepExecution';
import { createProductionWorkflowSessionStepExecutor } from './sessionStepExecutor';

describe('Workflow Session step execution', () => {
  beforeEach(() => {
    machineRpc.callMachineRpc.mockReset();
    http.get.mockReset();
    http.post.mockReset();
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return {
        status: 200,
        data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
          updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } },
      };
      if (url.includes(`/v2/sessions/${sessionId}`)) return {
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

  it('resumes an offline Workflow target with frozen native launch intent through Session input admission', async () => {
    const model = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'incoming-model' };
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
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
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
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
        launchEnvironment: { values: { PREDECESSOR_RUN: 'literal value' }, unset: [] }, providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'incoming-native' },
        profileId: 'incoming-profile', acpSessionModeId: 'incoming-mode', transcriptStorage: 'persisted',
        terminal: { mode: 'plain' }, windowsRemoteSessionLaunchMode: 'windows_terminal', windowsTerminalWindowName: 'Incoming window',
        mcpSelection: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] },
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
      mcpSelection: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] },
      connectedServices: { v: 2, bindingsByServiceId: {} },
    });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('rejects failed explicit existing Session readiness before Pending admission or an input receipt', async () => {
    const previousGet = http.get.getMockImplementation()!;
    http.get.mockImplementation(async (url: string) => url.includes(`/v2/sessions/${sessionId}`)
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
        launchEnvironment: { values: { PREDECESSOR_RUN: 'literal value' }, unset: [] } },
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

  it('admits the current Workflow input without an older-daemon capability declaration', async () => {
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
    }));
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

  it('carries the accepted workflow step depth in both protected request and provenance', async () => {
    const machineAdmissionTransport = vi.fn(async (request) => ({
      status: 'accepted' as const, localId: request.localId,
    }));
    await expect(enqueueWorkflowSessionInput({
      credentials: { token: 'token', encryption: null }, sessionId,

      workflow: { purpose: 'invocation', runId: 'run-1', invocationRecordId: 'inv-1' },
      workDepth: 3,
      text: 'Work', machineAdmissionTransport,
    })).resolves.toMatchObject({ status: 'accepted' });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      content: { t: 'plain', v: expect.objectContaining({ meta: expect.objectContaining({
        happierProvenanceV1: expect.objectContaining({ kind: 'workflow_invocation', workDepth: 3 }),
        happierInputRequestV1: expect.objectContaining({ workflow: expect.objectContaining({ workDepth: 3 }) }),
      }) }) },
    }));
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
    }));
  });
});

describe('Workflow detached Execution Run step execution', () => {
  it('sends the exact workflow input identity and execution-owned result contract', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    await expect(sendWorkflowDetachedExecutionRunInput({
      runId: 'run-1',
      text: 'Do the work',
      localInputId: 'workflow-input-1',
      resultContract: { kind: 'decision', decisions: ['continue', 'stop'] },
      send,
    })).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith({
      runId: 'run-1',
      message: 'Do the work',
      delivery: 'prompt',
      localInputId: 'workflow-input-1',
      resultContract: { kind: 'decision', decisions: ['continue', 'stop'] },
    });
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

  it('returns the recoverable Workflow interaction capacity code from the exact failed Run input', async () => {
    const get = vi.fn(async () => ({
      run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', status: 'failed', startedAtMs: 1, finishedAtMs: 2,
        error: {
          code: 'workflow_interaction_capacity_exceeded',
          message: 'Workflow interaction exceeds durable capacity',
        },
        inputTurns: {
          occurrenceId: 'occurrence-1',
          last: { turnId: 'turn-1', inputIds: ['workflow-input-1'], state: 'failed' },
        },
      },
    }));

    await expect(observeWorkflowDetachedExecutionRunInput({
      runId: 'run-1', localInputId: 'workflow-input-1', get,
    })).resolves.toEqual({ kind: 'failed', code: 'workflow_interaction_capacity_exceeded' });
  });

  it('does not treat another turn or terminal run status as exact completion proof', async () => {
    const get = vi.fn(async () => ({
      run: {
        runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1', intent: 'agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
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
