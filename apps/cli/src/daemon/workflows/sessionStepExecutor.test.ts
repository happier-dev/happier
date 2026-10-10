import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

const readiness = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), callMachineRpc: vi.fn() }));
vi.mock('axios', () => ({ default: { get: readiness.get, post: readiness.post, isAxiosError: () => false } }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: readiness.callMachineRpc }));

import {
  WORKFLOW_CANCEL_REQUESTED_ABORT_REASON,
  WorkflowRuntimeInterruption,
  type WorkflowStepExecutor,
} from './coordinator';
import {
  createProductionFreshWorkflowSessionConversation,
  createProductionWorkflowConversationOwner,
  createProductionWorkflowSessionStepExecutor,
  createWorkflowSessionStepExecutor,
} from './sessionStepExecutor';


const sessionCreation = vi.hoisted(() => ({
  createSpawnedSession: vi.fn(async (_request: Parameters<typeof import('@/session/services/createSpawnedSession').createSpawnedSession>[0]) => ({ sessionId: 'new-session' })),
  prepareSessionCreationTarget: vi.fn(async () => ({
    ok: true as const,
    directory: '/repo',
    directoryCreationRequired: false,
    checkout: null,
  })),
}));
vi.mock('@/session/services/createSpawnedSession', () => sessionCreation);
vi.mock('@/session/creation/prepareSessionCreationTarget', () => ({
  prepareSessionCreationTarget: sessionCreation.prepareSessionCreationTarget,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      // Source runtime tests do not consume a remote host's ignored package-build failures.
      if (String(args[0]).replaceAll('\\', '/').endsWith('/.project/tmp/bundled-plugin-publication/failures.json')) return '[]';
      return fs.readFileSync(...args);
    },
  };
});


describe('workflow Session step executor', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    // HTTP and machine process launch are the external readiness boundaries;
    // authorization, resume normalization and conversation ownership stay real.
    let readySessionId = '';
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      const id = /\/v2\/sessions\/([^/?]+)/.exec(url)?.[1];
      if (!id) throw new Error(`Unexpected readiness read: ${url}`);
      return { status: 200, data: { session: createSessionRecordFixture({ id, active: true,
        encryptionMode: 'plain', machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1',
          path: id === 'existing-session' ? '/repo/subdir' : '/repo', claudeSessionId: 'native-session',
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
        }) }) } };
    });
    readiness.callMachineRpc.mockImplementation(async ({ method, request }: { method: string; request: { sessionId?: string } }) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        readySessionId = request.sessionId!;
        return { type: 'success', sessionId: readySessionId };
      }
      return { status: 'success', sessionId: readySessionId };
    });
    readiness.post.mockImplementation(async (url: string, body: { tags: string[] }) => {
      if (!url.endsWith('/v2/sessions/lookup-by-tags')) throw new Error(`Unexpected readiness write: ${url}`);
      const response = await readiness.get(`/v2/sessions/${body.tags[0]}`);
      return { status: 200, data: { sessions: [response.data.session] } };
    });
  });
  it('records inputless Session creation and rejoins it without fabricating an input', async () => {
    const creations: unknown[] = [];
    const createdFacts: unknown[] = [];
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(),
      createFreshConversation: async (request) => { creations.push(request); return {
        sessionId: 'created-session', machineId: 'machine-1', directory: '/repo',
      }; },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo' }),
      sessionInput: {
        enqueue: async () => { throw new Error('Inputless creation cannot enqueue'); },
        observe: async () => { throw new Error('Inputless creation has no input to observe'); },
      },
    });
    const base = {
      runId: 'run-inputless', invocationRecordId: 'inv-inputless',
      step: { kind: 'step' as const, id: 'create', inputMode: 'none' as const,
        document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } },
      invocation: { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
        invocationPath: { blockId: 'create', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: '', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' as const },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {},
      onInputAccepted: async () => { throw new Error('No input was accepted'); },
      onSessionReady: async (value: unknown) => { createdFacts.push(value); },
    };
    await expect(execute(base)).resolves.toEqual({ kind: 'completed', result: '' });
    expect(createdFacts).toEqual([{ kind: 'session_ready', sessionId: 'created-session' }]);
    await expect(execute({ ...base, invocation: { ...base.invocation,
      execution: { kind: 'session_ready', sessionId: 'created-session' } } })).resolves.toEqual({ kind: 'completed', result: '' });
    expect(creations).toHaveLength(1);
  });

  it('recovers inputless creation before its Workflow fact through observation-only Session creation custody', async () => {
    const request = { selection: { agentTarget: { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, connectedServices: { v: 2 as const, bindingsByServiceId: {} } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-inputless:inv-inputless', observationOnly: true,
    };
    sessionCreation.createSpawnedSession.mockClear();
    await createProductionFreshWorkflowSessionConversation({ credentials: { token: 'token', encryption: null },
      serverId: 'server-1', machineId: 'machine-1', workDepth: 0, originRunId: 'run-inputless', machineAdmissionTransport: vi.fn() })(request);
    expect(sessionCreation.createSpawnedSession.mock.calls[0]?.[0]).toMatchObject({ spawnNonce: request.creationKey, resumeOnly: true });
  });

  it.each([
    { incomingAt: 100, savedClear: false }, { incomingAt: 200, savedClear: false },
    { incomingAt: 300, savedClear: false }, { incomingAt: null, savedClear: false },
    { incomingAt: 100, savedClear: true }, { incomingAt: 200, savedClear: true },
    { incomingAt: 300, savedClear: true },
  ])('resolves existing Session controls by predecessor timestamps (%j)', async ({ incomingAt, savedClear }) => {
    const admitted: unknown[] = [];
    const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const model = (modelId: string) => ({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId });
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(), createFreshConversation: async () => { throw new Error('Existing target'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo', agentTarget: target,
        runtimeSnapshot: { permissionMode: { value: 'read-only' as const, updatedAt: 200 }, modelSelection: { value: savedClear ? null : model('saved-model'), updatedAt: 200 } },
      }),
      sessionInput: { enqueue: async (request) => { admitted.push(request); return { status: 'accepted', localId: 'input' }; },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({ runId: 'run',
      step: { kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'existing_session', sessionId: 'retained', machineId: 'machine-1' }, agentTarget: target,
        permissionMode: incomingAt === null ? null : 'default', permissionModeUpdatedAt: incomingAt ?? undefined,
        modelSelection: incomingAt === null ? null : { v: 1, ref: model('incoming-model'), updatedAt: incomingAt } },
      executionTarget: { kind: 'session' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    });
    expect(admitted).toEqual([expect.objectContaining({ permissionMode: incomingAt === null ? null : incomingAt < 200 ? 'read-only' : 'default',
      modelSelectionInput: expect.objectContaining({ modelId: incomingAt === null || (savedClear && incomingAt < 200)
        ? null : incomingAt < 200 ? 'saved-model' : 'incoming-model' }),
      ...(incomingAt === null ? {} : { modelSelectionUpdatedAt: incomingAt < 200 ? 200 : incomingAt }),
    })]);
  });

  it('anchors an unmaterialized generation timeout to the exact host input across rejoin', async () => {
    const acceptedTimes: number[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('owned input cannot prepare'); },
      materializeConversation: async () => { throw new Error('owned input cannot materialize'); },

      sessionInput: { enqueue: async () => { throw new Error('owned input cannot enqueue'); },
        observe: async (params) => {
          expect(params.deadlineMs).toBeUndefined();
          expect(params.timeoutAfterInputMs).toBe(100);
          expect(params.onInputMaterialized).toBeTypeOf('function');
          await params.onInputMaterialized?.(123);
          return { ok: true, sessionId: 'session', localId: 'generated-input', result: { kind: 'final_text', text: 'done' } };
        },
      },
    });
    expect(await execute({ runId: 'run', step: { kind: 'step', id: 'draft', timeoutMs: 100,
      document: { text: 'Generate', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'draft', scope: [] },
        attempt: '1', logicalInvocationRecordId: 'logical', execution: { kind: 'session', sessionId: 'session', localInputId: 'generated-input' } },
      input: { text: 'Generate', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } }, workspace: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => { throw new Error('owned input cannot admit'); },
      onInputAccepted: async (_execution, acceptedAtMs) => { if (acceptedAtMs !== undefined) acceptedTimes.push(acceptedAtMs); },
    })).toEqual({ kind: 'completed', result: 'done' });
    expect(acceptedTimes).toEqual([123]);
  });
  it('binds the portable origin choice to its frozen authorized Session and refuses replacement', async () => {
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('origin cannot be replaced'); },
      resolveSharedRunConversation: async () => { throw new Error('origin has no shared pointer'); },
      resolveProducerConversation: async () => { throw new Error('origin is not a producer reference'); },
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => sessionId === 'frozen-origin'
        ? { sessionId, machineId, directory: '/origin/cwd', agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }
        : null,
    });
    const base = {
      runId: 'run-1', originSessionId: 'frozen-origin',
      invocation: { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const, invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1' },
      step: { kind: 'step' as const, id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } },
      execution: { conversation: { kind: 'origin_session' as const }, agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      onOriginInputOffered: async () => {},
    };
    await expect(conversations.prepare(base)).resolves.toMatchObject({ inputPath: 'origin_session', existing: {
      sessionId: 'frozen-origin', directory: '/origin/cwd', agentTarget: { identity: { localId: 'codex' } },
    } });
    await expect(conversations.prepare({ ...base, originSessionId: undefined })).rejects.toMatchObject({ code: 'workflow_conversation_unavailable' });
    await expect(conversations.prepare({ ...base, onOriginInputOffered: undefined })).rejects.toMatchObject({ code: 'workflow_origin_input_offer_unavailable' });
    await expect(conversations.prepare({ ...base, invocation: { ...base.invocation,
      recovery: { conversation: 'fresh_agent', input: { kind: 'original' } } } })).rejects.toMatchObject({ code: 'workflow_recovery_conversation_unsupported' });
  });

  it('commits an origin input for pull delivery and observes its exact result without Session Pending', async () => {
    const accepted: unknown[] = [];
    const offeredText: string[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      resolveRoleInstructions: () => 'Frozen workflow role',
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', inputPath: 'origin_session',
        existing: { sessionId: 'origin', machineId: 'machine-1', directory: '/repo' } }),
      materializeConversation: async () => { throw new Error('origin must not create or enqueue'); },

      sessionInput: { enqueue: async () => { throw new Error('origin must not enqueue'); },
        observe: async ({ sessionId, localId }) => {
          expect(accepted).toEqual([{ kind: 'session', sessionId, localInputId: localId }]);
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'origin result' } };
        },
      },
    });
    await expect(execute({
      runId: 'run-1', invocationRecordId: 'inv-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {},
      onOriginInputOffered: async (value, text) => { accepted.push(value); offeredText.push(text); },
      onInputAccepted: async () => { throw new Error('offered input is not yet admitted by the host'); },
    })).resolves.toEqual({ kind: 'completed', result: 'origin result' });
    expect(offeredText).toEqual(['Frozen workflow role\n\nwork']);
  });

  it.each(['withdrawn', 'dispatched'] as const)('settles an origin abort only through the input owner (%s)', async (answer) => {
    const controller = new AbortController();
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    let exactTurnStops = 0;
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('admitted input must not prepare'); },
      materializeConversation: async () => { throw new Error('admitted input must not materialize'); },

      originSessionInput: {
        withdraw: async () => answer,
        cancelDispatched: async () => { exactTurnStops += 1; },
      },
      sessionInput: { enqueue: async () => { throw new Error('admitted input must not enqueue'); },
        cancel: async () => { throw new Error('Session Pending cannot retire origin input'); },
        observe: async ({ signal }) => signal?.aborted ? { ok: false, code: 'cancelled' }
          : { ok: true, sessionId: 'origin', localId: 'exact-origin-input', result: { kind: 'final_text', text: 'settled dispatched turn' } },
      },
    });
    await expect(execute({
      runId: 'run-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1',
        execution: { kind: 'session', sessionId: 'origin', localInputId: 'exact-origin-input' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, signal: controller.signal,
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual(answer === 'withdrawn'
      ? { kind: 'cancelled', code: 'workflow_origin_input_withdrawn' }
      : { kind: 'completed', result: 'settled dispatched turn' });
    expect(exactTurnStops).toBe(answer === 'dispatched' ? 1 : 0);
  });

  it('withdraws a paused origin offer through the queue owner while waiting for its host event', async () => {
    const withdrawals: unknown[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('rejoin does not prepare'); },
      materializeConversation: async () => { throw new Error('origin has no Pending'); },

      originSessionInput: { withdraw: async (input) => { withdrawals.push(input); return 'withdrawn'; }, cancelDispatched: async () => { throw new Error('Pause cannot stop a dispatched turn'); } },
      sessionInput: { enqueue: async () => { throw new Error('origin has no Pending'); },
        observe: async (params) => {
          await params.beforeInputObservation?.();
          return { ok: false, code: 'cancelled' };
        },
      },
    });
    await expect(execute({
      runId: 'run-1', originSessionId: 'origin', readOriginInputControl: async () => 'pause_requested',
      step: { kind: 'step', id: 'a', timeoutMs: 100, document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1',
        execution: { kind: 'session', sessionId: 'origin', localInputId: 'exact-origin-input' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual({ kind: 'cancelled', code: 'workflow_origin_input_withdrawn' });
    expect(withdrawals).toEqual([{ sessionId: 'origin', localInputId: 'exact-origin-input' }]);
  });

  it('settles a deleted origin as unavailable without starting a replacement', async () => {
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('admitted input cannot be replaced'); },
      materializeConversation: async () => { throw new Error('admitted input cannot be replaced'); },

      sessionInput: { enqueue: async () => { throw new Error('admitted input cannot be replaced'); },
        observe: async () => ({ ok: false, code: 'session_not_found' }),
      },
    });
    await expect(execute({
      runId: 'run-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1',
        execution: { kind: 'session', sessionId: 'origin', localInputId: 'exact-origin-input' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual({ kind: 'failed', code: 'workflow_conversation_unavailable' });
  });

  it('fences Session enqueue after asynchronous conversation preparation', async () => {
    const admissionClosed = new Error('pause_won');
    let closed = false;
    let sent = 0;
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),

      materializeConversation: async () => {
        closed = true;
        return { sessionId: 'session-1', machineAdmissionTransport: vi.fn() };
      },
      sessionInput: { enqueue: async () => { sent += 1; return { status: 'accepted', localId: 'exact' }; },
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'exact', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await expect(execute({
      runId: 'run-1', step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => { if (closed) throw admissionClosed; }, onInputAccepted: async () => {},
    })).rejects.toBe(admissionClosed);
    expect(sent).toBe(0);
  });

  it('stops a late accepted Session identity even when its durable report fails', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const reportFailed = new Error('report_failed');
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),

      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: async () => { controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON); return { status: 'accepted', localId: 'late-input' }; },
        observe: async () => { throw new Error('cannot observe through cancelled signal'); },
        cancel: async ({ sessionId, localId }) => { stopped.push(`${sessionId}:${localId}`); return { kind: 'turn_cancel_requested' }; },
      },
    });
    await expect(execute({
      runId: 'run-1', step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, signal: controller.signal,
      beforeInputAdmission: async () => {}, onInputAccepted: async () => { throw reportFailed; },
    })).rejects.toBe(reportFailed);
    expect(stopped).toEqual(['session-1:late-input']);
  });
  it('observes the exact admitted Session input before checking a new selection', async () => {
    const observed: string[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('selection must not run'); },
      materializeConversation: async () => { throw new Error('creation must not run'); },

      sessionInput: { enqueue: async () => { throw new Error('admitted input must not be sent again'); },
        observe: async ({ sessionId, localId }) => {
          observed.push(`${sessionId}:${localId}`);
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'exact result' } };
        },
      },
    });
    const params: Parameters<WorkflowStepExecutor>[0] = {
      runId: 'run-1',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: {
        kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'a', scope: [] }, attempt: '1', logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'session', sessionId: 'exact-session', localInputId: 'exact-input' },
      },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' }, permissionMode: 'yolo' },
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    };
    await expect(execute(params)).resolves.toEqual({ kind: 'completed', result: 'exact result' });
    expect(observed).toEqual(['exact-session:exact-input']);
  });

  it.each([false, true])('treats the successful Session no-text reason as empty raw text (rejoin=%s)', async (rejoin) => {
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),

      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: async () => ({ status: 'accepted', localId: 'local-1' }),
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } },
        }),
      },
    });
    const invocation: Parameters<WorkflowStepExecutor>[0]['invocation'] = {
      kind: 'happier.workflow-progress.v1', blockKind: 'step',
      invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1',
      ...(rejoin ? { execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'local-1' } } : {}),
    };
    await expect(execute({
      runId: 'run-1',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation, input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual({ kind: 'completed', result: '', usage: { inputTokens: 8 } });
  });

  it('fresh-agent recovery creates a replacement Session while same recovery retains the exact prior target', async () => {
    const workspace = { machineId: 'machine-1', directory: '/repo/dirty', checkoutRootPath: '/repo' };
    const created: string[] = [];
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1',
      createFreshConversation: async ({ workspace: target }) => {
        created.push(target.directory);
        return { sessionId: 'replacement', machineId: 'machine-1', directory: target.directory };
      },
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: workspace.directory,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }),
    });
    const base = {
      runId: 'run-1', step: { result: { kind: 'text' } },
      execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      recoveryPreviousExecution: { kind: 'session', sessionId: 'original', localInputId: 'old-input' },
      recoveryPreviousWorkspace: workspace,
      workspace,
    };
    const fresh = { ...base, invocation: { logicalInvocationRecordId: 'fresh', recovery: { conversation: 'fresh_agent' } } };
    const prepared = await conversations.prepare(fresh as never);
    await expect(conversations.materialize(prepared, fresh as never)).resolves.toMatchObject({ sessionId: 'replacement', directory: '/repo/dirty' });
    const same = { ...base, invocation: { logicalInvocationRecordId: 'same', recovery: { conversation: 'same_conversation' } } };
    await expect(conversations.materialize(await conversations.prepare(same as never), same as never)).resolves.toMatchObject({ sessionId: 'original', directory: '/repo/dirty' });
    expect(created).toEqual(['/repo/dirty']);
  });

  it('passes the selected scope and class to the shared pointer reader', async () => {
    let selectedScope: unknown;
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: async () => { throw new Error('unexpected creation'); },
      resolveSharedRunConversation: async (params) => { selectedScope = params; return null; },
      resolveProducerConversation: async () => null, resolveExistingSessionConversation: async () => null,
    });
    const conversationBinding = { kind: 'shared', scopeOwnerKey: 'item-a', targetClass: 'session' };
    await conversations.prepare({
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution: {}, conversationBinding,
    } as never);
    expect(selectedScope).toMatchObject({ conversationBinding });
  });

  it('checks the actual retained Session Agent before materialization, while an existing Session keeps its own Agent', async () => {
    const createFreshConversation = vi.fn();
    const conversations = createProductionWorkflowConversationOwner({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', createFreshConversation,
      resolveSharedRunConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({
        sessionId, machineId, directory: '/repo',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }),
    });
    const params = {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    };
    await expect(conversations.prepare(params as never)).rejects.toMatchObject({ code: 'workflow_conversation_unavailable' });
    await expect(conversations.prepare({
      ...params,
      execution: { ...params.execution, conversation: { kind: 'existing_session', sessionId: 'retained', machineId: 'machine-1' } },
    } as never)).resolves.toMatchObject({ existing: { sessionId: 'retained' } });
    expect(createFreshConversation).not.toHaveBeenCalled();
  });

  it('preserves an explicit automatic model and null permission intent at Session Pending admission', async () => {
    let accepted: unknown;
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      workDepth: 2,
      resolveRoleInstructions: () => 'Frozen reviewer instructions',
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),

      sessionInput: { enqueue: async (params) => { accepted = params; return { status: 'accepted', localId: 'new-input' }; },
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'new-input', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: null, modelSelection: null },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    } as never);
    expect(accepted).toMatchObject({ permissionMode: null, modelSelectionInput: { modelId: null }, workDepth: 3,
      text: expect.stringContaining('Frozen reviewer instructions') });
  });

  it('retains the Session creation depth for shared and from-step continuations while external Session inputs use the frozen Run depth', async () => {
    const depths: number[] = [];
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', workDepth: 2,

      machineAdmissionTransport: vi.fn(),
      createFreshConversation: async () => { throw new Error('continuations must not create'); },
      resolveSharedRunConversation: async () => ({ sessionId: 'step-session', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => ({ sessionId: 'step-session', machineId: 'machine-1', directory: '/repo' }),
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({
        sessionId, machineId, directory: '/repo', origin: { kind: 'run_step' as const, runId: 'run-1' }, workDepth: 3,
      }),
      sessionInput: { enqueue: async ({ workDepth }) => {
          depths.push(workDepth!);
          return { status: 'accepted', localId: `input-${depths.length}` };
        },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      },
    });
    const base = {
      runId: 'run-1',
      step: { kind: 'step', id: 'work', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'Implement', references: [], attachments: [], values: [] },
      execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    } satisfies Parameters<WorkflowStepExecutor>[0];
    await execute({ ...base, execution: { conversation: { kind: 'shared_run' } } });
    await execute({ ...base, execution: { conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } } });
    await execute({ ...base, execution: { conversation: { kind: 'existing_session', sessionId: 'step-session', machineId: 'machine-1' } } });
    await execute({ ...base, recoveryPreviousExecution: { kind: 'session', sessionId: 'step-session', localInputId: 'prior-input' },
      invocation: { ...base.invocation, recovery: { conversation: 'same_conversation', input: { kind: 'original' } } } });
    expect(depths).toEqual([3, 3, 2, 3]);
  });

  it('titles only freshly created named step Sessions with the authored name and frozen sibling ordinal', async () => {
    // Session/process creation is the external boundary; conversation binding
    // and title selection remain the production owner's real internal path.
    const createFreshConversation = vi.fn(async (_input: Parameters<Parameters<typeof createProductionWorkflowConversationOwner>[0]['createFreshConversation']>[0]) => ({
      sessionId: 'fresh', machineId: 'machine-1', directory: '/repo',
    }));
    const personallyRenamed = { sessionId: 'shared', machineId: 'machine-1', directory: '/repo', title: 'My own title',
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      runtimeSelection: { connectedServices: { v: 2 as const, bindingsByServiceId: {} } } };
    const conversations = createProductionWorkflowConversationOwner({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', createFreshConversation,
      resolveSharedRunConversation: async () => ({ sessionId: 'shared', machineId: 'machine-1', directory: '/repo',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        runtimeSelection: { connectedServices: { v: 2, bindingsByServiceId: {} } } }),
      resolveProducerConversation: async () => ({ sessionId: 'shared', machineId: 'machine-1', directory: '/repo',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        runtimeSelection: { connectedServices: { v: 2, bindingsByServiceId: {} } } }),
      resolveExistingSessionConversation: async () => personallyRenamed,
    });
    const base = {
      runId: 'run-1', stepOrdinal: '3',
      step: { kind: 'step', id: 'work', name: 'Implement', document: { text: 'A different prompt', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'Implement', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, connectedServices: { v: 2, bindingsByServiceId: {} } },
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    } satisfies Parameters<WorkflowStepExecutor>[0];
    const fresh = base;
    await conversations.materialize(await conversations.prepare(fresh), fresh);
    expect(createFreshConversation).toHaveBeenLastCalledWith(expect.objectContaining({ initialTitle: '3 · Implement' }));
    const scalarItem = { ...fresh, item: { value: 'parser.ts', index: 3, position: 4, count: 8 } };
    await conversations.materialize(await conversations.prepare(scalarItem), scalarItem);
    expect(createFreshConversation).toHaveBeenLastCalledWith(expect.objectContaining({ initialTitle: '3 · Implement · parser.ts' }));
    const structuredItem = { ...fresh, item: { value: { name: 'Not a label' }, index: 3, position: 4, count: 8 } };
    await conversations.materialize(await conversations.prepare(structuredItem), structuredItem);
    expect(createFreshConversation).toHaveBeenLastCalledWith(expect.objectContaining({ initialTitle: '3 · Implement · 4' }));
    const { name: _name, ...unnamedStep } = fresh.step;
    const empty = { ...scalarItem, step: unnamedStep };
    await conversations.materialize(await conversations.prepare(empty), empty);
    expect(createFreshConversation).toHaveBeenLastCalledWith(expect.not.objectContaining({ initialTitle: expect.any(String) }));
    const shared = { ...fresh, execution: { ...fresh.execution, conversation: { kind: 'shared_run' as const } } };
    createFreshConversation.mockClear();
    await conversations.materialize(await conversations.prepare(shared), shared);
    const fromStep = { ...fresh, execution: { ...fresh.execution,
      conversation: { kind: 'from_step' as const, producer: { blockId: 'prior', scope: { kind: 'current' as const } } } } };
    await conversations.materialize(await conversations.prepare(fromStep), fromStep);
    const existing = { ...fresh, execution: { ...fresh.execution,
      conversation: { kind: 'existing_session' as const, sessionId: 'shared', machineId: 'machine-1' } } };
    expect(await conversations.materialize(await conversations.prepare(existing), existing)).toBe(personallyRenamed);
    const retained = { ...fresh,
      recoveryPreviousExecution: { kind: 'session' as const, sessionId: 'shared', localInputId: 'prior-input' },
      invocation: { ...fresh.invocation, recovery: { conversation: 'same_conversation' as const, input: { kind: 'original' as const } } } };
    expect(await conversations.materialize(await conversations.prepare(retained), retained)).toBe(personallyRenamed);
    expect(personallyRenamed.title).toBe('My own title');
    expect(createFreshConversation).not.toHaveBeenCalled();
  });





  it('preserves the provider failure message and owner-reported usage when the exact Session input fails', async () => {
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),

      materializeConversation: async () => ({
        sessionId: 'session-1', machineAdmissionTransport: vi.fn(),
      }),
      sessionInput: { enqueue: async () => ({ status: 'accepted', localId: 'local-1' }),
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: {
            kind: 'failed', message: 'provider failed',
            usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
          },
        }),
      },
    } as Parameters<typeof createWorkflowSessionStepExecutor>[0]);

    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({
      kind: 'failed', code: 'session_input_failed',
      message: 'provider failed',
      usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
    });
  });

  it('preserves terminal cancellation and usage instead of replacing them with a stop acknowledgement', async () => {
    const cancel = vi.fn(async () => ({ kind: 'pending_retired' as const }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),

      materializeConversation: async () => ({
        sessionId: 'session-1', machineAdmissionTransport: vi.fn(),
      }),
      sessionInput: { enqueue: async () => ({ status: 'accepted', localId: 'local-1' }),
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: {
            kind: 'cancelled', message: 'provider cancelled',
            usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
          },
        }),
        cancel,
      },
    } as Parameters<typeof createWorkflowSessionStepExecutor>[0]);

    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({
      kind: 'cancelled', code: 'session_input_cancelled',
      usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('admits the current Session path without a protocol capability read', async () => {
    const materializeConversation = vi.fn(async () => ({
      sessionId: 'session-1', machineAdmissionTransport: vi.fn(),
    }));
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({
        kind: 'workflow_session_conversation',
        existing: null,
      }),

      materializeConversation,
      sessionInput: { enqueue,
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: { kind: 'final_text', text: 'done' },
        }),
      },
    } as Parameters<typeof createWorkflowSessionStepExecutor>[0]);

    await expect(execute({
      runId: 'run-1', stepOrdinal: '5', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'completed', result: 'done' });
    expect(materializeConversation).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    // The step's visible number is stamped on its input's provenance at write time.
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ workflow: expect.objectContaining({ stepOrdinal: '5' }) }));
  });

  it('persists exact input correspondence after admission and before observation', async () => {
    const events: string[] = [];
    const enqueueWorkflowSessionInput = vi.fn();
    const observeWorkflowSessionInputResult = vi.fn();
    enqueueWorkflowSessionInput.mockResolvedValue({ status: 'accepted', localId: 'local-1' });
    observeWorkflowSessionInputResult.mockImplementation(async () => {
      events.push('observe');
      return { ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: 'done' } };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async (params) => {
        expect(params.workspace).toEqual({ machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' });
        return { kind: 'workflow_session_conversation', existing: null };
      },
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: enqueueWorkflowSessionInput,
        observe: observeWorkflowSessionInputResult,
      },
    });
    await expect(execute({
      runId: 'run-1', step: { timeoutMs: 100 }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async (value: Parameters<WorkflowStepExecutor>[0]['invocation']['execution']) => {
        events.push('commit');
        expect(value).toEqual({ kind: 'session', sessionId: 'session-1', localInputId: 'local-1' });
      },
    } as never)).resolves.toEqual({ kind: 'completed', result: 'done' });
    expect(events).toEqual(['commit', 'observe']);
  });

  it('reobserves durable Session correspondence without preparing or enqueueing a second input', async () => {
    const prepareConversation = vi.fn();
    const enqueue = vi.fn();
    const observe = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'local-1',
      result: { kind: 'final_text' as const, text: 'rejoined' },
    }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation,
      materializeConversation: vi.fn(),
      sessionInput: { enqueue, observe },
    });
    await expect(execute({
      runId: 'run-1', step: {},
      invocation: {
        logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' },
      },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'completed', result: 'rejoined' });
    expect(prepareConversation).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', localId: 'local-1' }));
  });

  it('propagates the coordinator currentness signal to an in-flight Session observation without a default deadline', async () => {
    const controller = new AbortController();
    const observe = vi.fn(async (input: { signal?: AbortSignal; deadlineMs?: number }) => {
      expect(input.signal).toBe(controller.signal);
      expect(input).not.toHaveProperty('deadlineMs');
      controller.abort();
      return {
        ok: true as const,
        sessionId: 'session-1',
        localId: 'local-1',
        result: { kind: 'cancelled' as const, message: 'cancelled' },
      };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(),
      materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), observe,
        cancel: async () => ({ kind: 'turn_cancel_requested' }),
      },
    });
    await expect(execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'cancelled', code: 'session_input_cancelled' });
  });

  it('reports an aborted exact observation as cancellation rather than attention', async () => {
    const controller = new AbortController();
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(), materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(),
        observe: async () => ({ ok: false, code: 'cancelled' }),
        cancel: async () => ({ kind: 'pending_retired' }),
      },
    });
    await expect(execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'cancelled', code: 'session_input_pending_retired' });
  });

  it('refuses to reinterpret detached Run correspondence as Session correspondence', async () => {
    const prepareConversation = vi.fn();
    const observe = vi.fn();
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation,
      materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), observe },
    });
    await expect(execute({
      runId: 'run-1', step: {},
      invocation: {
        logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'detached_run', runId: 'execution-run-1', localInputId: 'local-1' },
      },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'failed', code: 'workflow_execution_target_mismatch' });
    expect(prepareConversation).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('adds the canonical per-turn result instruction before exact Session admission', async () => {
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue,
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: '"continue"' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'decision', decisions: ['continue', 'stop'] } },
      invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'Judge', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Return only one strict JSON string'),
    }));
  });

  it('refuses a step broader than the immutable admitted Run ceiling before Session mutation', async () => {
    const prepareConversation = vi.fn();
    const enqueue = vi.fn();
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, prepareConversation,

      materializeConversation: vi.fn(),
      sessionInput: { enqueue, observe: vi.fn(), cancel: vi.fn() },
    });
    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: 'safe-yolo' },
      authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'failed', code: 'workflow_permission_escalation_denied' });
    expect(prepareConversation).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('leaves live Session permission revalidation with canonical input admission', async () => {
    const enqueue = vi.fn(async () => ({
      status: 'rejected' as const,
      code: 'session_input_permission_ceiling_rejected' as const,
    }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue, observe: vi.fn() },
    });
    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: 'safe-yolo' },
      authorization: {
        admittedPermissionCeiling: 'safe-yolo',
        principal: { kind: 'host' },
        sourceAuthority: {
          mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:binding-1',
          sourceRevisionOrEpoch: '4:7',
          remoteApprovalMaxScope: 'session',
        },
      },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({
      kind: 'failed',
      code: 'session_input_permission_ceiling_rejected',
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'safe-yolo',
      sourceAuthority: {
        mediatorPluginId: 'happier.channels',
        sourceRef: 'channels:binding:binding-1',
        sourceRevisionOrEpoch: '4:7',
        remoteApprovalMaxScope: 'session',
      },
    }));
  });

  it('uses the contextual default rather than widening an omitted Session step to the Run ceiling', async () => {
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue,
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'default' }));
  });

  it.each([
    { kind: 'turn_cancel_requested' as const },
    { kind: 'turn_cancel_refused' as const, status: 'notRunning' as const, code: 'notRunning' },
  ])('observes the exact accepted Session input after cancellation ($kind) and preserves its real terminal result', async (cancellation) => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => cancellation);
    const observe = vi.fn(async (input: { signal?: AbortSignal }) => {
      if (!input.signal) return { ok: true as const, sessionId: 'session-1', localId: 'local-1',
        result: { kind: 'final_text' as const, text: 'finished before cancellation', usage: { inputTokens: 2, outputTokens: 3 } } };
      expect(input.signal).toBe(controller.signal);
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false as const, code: 'cancelled' as const };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(), materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), cancel,
        observe,
      },
    });
    const execution = execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);

    await expect(execution).resolves.toEqual({ kind: 'completed', result: 'finished before cancellation', usage: { inputTokens: 2, outputTokens: 3 } });
    expect(cancel).toHaveBeenCalledWith({
      credentials: { token: 'token', encryption: null },
      sessionId: 'session-1', localId: 'local-1',
    });
  });

  it('leaves the accepted Session input running when the claim is interrupted without a cancellation reason', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const observe = vi.fn(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false as const, code: 'cancelled' as const };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(), materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), cancel, observe },
    });
    const execution = execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    // Daemon shutdown / lease loss: this attempt only stops observing.
    controller.abort();

    await expect(execution).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('carries portable Composer attachments into canonical Session structured-input admission', async () => {
    const attachment = {
      v: 1 as const,
      instanceId: 'workflow-attachment-1',
      attachment: { pluginId: 'acme.review', localId: 'review-context' },
      key: 'review-42',
      value: { reviewId: 42 },
      presentation: { label: 'Review 42', typeLabel: 'Review' },
    };
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue,
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'Review', references: [], attachments: [attachment], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ attachments: [attachment] }));
  });

  it('materializes shared, fresh, from-step, and existing conversations without a workflow-owned Session registry', async () => {
    const createFreshConversation = vi.fn(async () => ({ sessionId: 'new-session', machineId: 'machine-1', directory: '/repo/subdir' }));
    const resolveSharedRunConversation = vi.fn(async () => ({ sessionId: 'shared-session', machineId: 'machine-1', directory: '/repo/subdir' }));
    const resolveProducerConversation = vi.fn(async () => ({ sessionId: 'producer-session', machineId: 'machine-1', directory: '/repo/subdir' }));
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',

      machineAdmissionTransport: vi.fn(), createFreshConversation,
      resolveSharedRunConversation, resolveProducerConversation,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo/subdir' }),
      sessionInput: { enqueue: async ({ sessionId }) => ({ status: 'accepted', localId: `local-${sessionId}` }),
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: sessionId } }),
      },
    });
    const base = {
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1', invocationPath: { blockId: 'work', scope: [] } },
      input: { text: 'work', references: [], attachments: [], values: [] },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo/subdir', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    };
    await expect(execute({ ...base, execution: { conversation: { kind: 'shared_run' } } } as never)).resolves.toMatchObject({ result: 'shared-session' });
    await expect(execute({ ...base, invocation: { ...base.invocation, logicalInvocationRecordId: 'inv-2' }, execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } } as never)).resolves.toMatchObject({ result: 'new-session' });
    await expect(execute({ ...base, invocation: { ...base.invocation, logicalInvocationRecordId: 'inv-3' }, execution: { conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } } } as never)).resolves.toMatchObject({ result: 'producer-session' });
    await expect(execute({ ...base, invocation: { ...base.invocation, logicalInvocationRecordId: 'inv-4' }, execution: { conversation: { kind: 'existing_session', sessionId: 'existing-session', machineId: 'machine-1' } } } as never)).resolves.toMatchObject({ result: 'existing-session' });
    expect(createFreshConversation).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'workflow:run-1:inv-2',
      workspace: { machineId: 'machine-1', directory: '/repo/subdir', checkoutRootPath: '/repo' },
      selection: expect.objectContaining({
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      }),
    }));
  });

  it('compares retained Session workspace paths through the canonical cross-platform path owner', async () => {
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1',
      createFreshConversation: vi.fn(),
      resolveSharedRunConversation: async () => ({
        sessionId: 'shared-session',
        machineId: 'machine-1',
        directory: 'C:\\Users\\Alice\\repo\\packages\\app',
      }),
      resolveProducerConversation: vi.fn(),
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId,
        directory: 'C:\\Users\\Alice\\repo\\packages\\app' }),
    });

    const prepared = await conversations.prepare({
      runId: 'run-1',
      invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { conversation: { kind: 'shared_run' } },
    } as never);
    expect(prepared).toMatchObject({ existing: { sessionId: 'shared-session' } });
    await expect(conversations.materialize(prepared, {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      step: { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      execution: { conversation: { kind: 'shared_run' } },
      workspace: {
        machineId: 'machine-1',
        directory: 'c:/users/alice/repo/packages/app',
        checkoutRootPath: 'c:/users/alice/repo',
      },
    } as never)).resolves.toMatchObject({ sessionId: 'shared-session' });

    const sibling = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: vi.fn(),
      resolveSharedRunConversation: async () => ({
        sessionId: 'shared-session', machineId: 'machine-1',
        directory: 'C:\\Users\\Alice2\\repo\\packages\\app',
      }),
      resolveProducerConversation: vi.fn(), resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({
        sessionId, machineId, directory: 'C:\\Users\\Alice2\\repo\\packages\\app',
      }),
    });
    const siblingPrepared = await sibling.prepare({
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { conversation: { kind: 'shared_run' } },
    } as never);
    await expect(sibling.materialize(siblingPrepared, {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { conversation: { kind: 'shared_run' } },
      workspace: {
        machineId: 'machine-1', directory: 'c:/users/alice/repo/packages/app',
        checkoutRootPath: 'c:/users/alice/repo',
      },
    } as never)).rejects.toMatchObject({ code: 'conversation_workspace_mismatch' });
  });

  it('rejects an existing Session with a new worktree during conversation preflight', async () => {
    const resolveExistingSessionConversation = vi.fn();
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: vi.fn(),
      resolveSharedRunConversation: vi.fn(), resolveProducerConversation: vi.fn(),
      resolveExistingSessionConversation,
    });

    await expect(conversations.prepare({
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: {
        conversation: { kind: 'existing_session', sessionId: 'session-1', machineId: 'machine-1' },
        workspace: { kind: 'new_worktree', source: { kind: 'original' } },
      },
    } as never)).rejects.toMatchObject({ code: 'conversation_workspace_mismatch' });
    expect(resolveExistingSessionConversation).not.toHaveBeenCalled();
  });

  it('creates fresh conversations through canonical target preparation and Session creation owners', async () => {
    sessionCreation.createSpawnedSession.mockClear();
    sessionCreation.prepareSessionCreationTarget.mockClear();
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null },
      serverId: 'server-1',
      machineId: 'machine-1',
      workDepth: 2,
      originRunId: 'run-1',
      machineAdmissionTransport: vi.fn(),
    });
    const agentTarget = {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    };
    await expect(create({
      selection: {
        agentTarget,
        connectedServices: { v: 2, bindingsByServiceId: {} },
        permissionMode: 'read_only',
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: {} },
      },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-1:inv-1',
    })).resolves.toEqual({ sessionId: 'new-session', machineId: 'machine-1', directory: '/repo',
      origin: { kind: 'run_step', runId: 'run-1' }, workDepth: 3 });
    expect(sessionCreation.prepareSessionCreationTarget).toHaveBeenCalledWith({
      request: {
        directory: { kind: 'path', path: '/repo' },
      },
    });
    expect(sessionCreation.createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      originKind: 'run_step',
      originRunId: 'run-1',
      workDepth: 3,
      directory: '/repo',
      approvedNewDirectoryCreation: false,
      spawnNonce: 'workflow:run-1:inv-1',
      agentTarget,
      permissionMode: 'read-only',
      sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: {} },
    }));
  });

  it('resolves fresh Team resource defaults through the injected current Home catalog', async () => {
    sessionCreation.createSpawnedSession.mockClear();
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`, encryption: null };
    // Account identity/currentness and catalog opening stay real; only persisted
    // credentials and Home HTTP responses are supplied at their boundaries.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const readinessRead = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
      if (url.endsWith('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: {
          v: 1, bindings: [], teamResourceSelections: [{
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
            teamId: 'team-1', selection: { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered' },
          }],
        } } },
      } };
      return readinessRead(url);
    });
    const resolveTeamCredentialResourceCatalog = vi.fn(async () => ({
      serverId: 'server-1', accountId: 'account-1',
      resources: [{
        id: 'resource-1', teamId: 'team-1', displayName: 'Shared Codex account',
        resourceRevision: 4, readiness: { kind: 'available' as const }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
        sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
        connectedServiceSelections: [{
          source: 'team_resource' as const, resourceId: 'resource-1', deliveryMode: 'brokered' as const,
        }],
        sourcePresentation: {
          kind: 'connected_service' as const,
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
    }));
    const create = createProductionFreshWorkflowSessionConversation({
      credentials,
      serverId: 'server-1',
      machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(),
      resolveTeamCredentialResourceCatalog,
      workDepth: 0,
      originRunId: 'run-1',
    });

    await create({
      selection: {
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-1:inv-team',
    });

    expect(resolveTeamCredentialResourceCatalog).toHaveBeenCalledWith({ teamIds: ['team-1'] });
    expect(sessionCreation.createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered',
          },
        },
      },
      // The defaulted Team target is admitted only through the Session's own
      // Team slot binding, created with the Session.
      teamCredentialBindings: [{
        v: 1,
        slot: {
          kind: 'connected_service_purpose',
          purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        },
        resourceId: 'resource-1',
        expectedResourceRevision: 4,
        deliveryMode: 'brokered',
        teamId: 'team-1',
      }],
    }));
  });
});
