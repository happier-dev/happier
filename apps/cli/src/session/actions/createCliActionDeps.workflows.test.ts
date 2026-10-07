import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, createActionExecutor, encodePlainArtifactStoredContent, ExecutionRunGetResponseSchema, sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1, validateWorkflowDefinition, WorkflowRunRecipientCensusResponseV1Schema, type ActionId } from '@happier-dev/protocol';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const signedRootAction = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());

// Native machine RPC is an authenticated transport boundary; Workflow policy stays real.
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
  callMachineRpc: machineRpc,
}));

vi.mock('axios', () => ({
  default: { get: http.get, post: http.post, put: http.put, delete: http.delete, isAxiosError: (value: unknown) => Boolean(value && typeof value === 'object' && 'response' in value) },
}));

// The daemon control client is an authenticated HTTP boundary. Keep its
// request schema and surrounding client logic real; observe only dispatch.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonSignedRootActionExecution: signedRootAction,
}));

import { createCliActionDeps } from './createCliActionDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

describe('createCliActionDeps workflow boundary', () => {
  const enabledFeatures = {
    status: 'ready' as const,
    provenance: 'authenticated' as const,
    features: {
      features: { automations: { enabled: true }, workflows: { enabled: true } },
      capabilities: {},
    },
  };
  beforeEach(() => {
    machineRpc.mockReset();
    http.put.mockReset();
    http.delete.mockReset();
    signedRootAction.mockReset().mockResolvedValue({ ok: true, result: {} });
    http.get.mockReset().mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      throw new Error(`unexpected_get:${url}`);
    });
    http.post.mockReset().mockImplementation(async (_url: string, body: Readonly<Record<string, unknown>>) => {
      if (body.operation === 'get') throw Object.assign(new Error('not found'), { response: { status: 404 } });
      if (body.operation === 'admit') return { data: { kind: 'created', run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
        id: body.runId, origin: { kind: 'direct', originSessionId: 'session-1' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false,
           restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      } } };
      throw new Error(`unexpected_post:${String(body.operation)}`);
    });
  });

  it.each(['detached_run', 'session'] as const)('offers %s recovery from the exact current native turn and capability, never a recorded recovery choice', async (targetKind) => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const recordId = '33333333-3333-4333-8333-333333333333';
    const timestamp = '2026-01-01T00:00:00.000Z';
    const sessionId = 'c' + 'a'.repeat(24);
    const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null, id: runId, origin: { kind: 'direct' }, state: 'interrupted', revision: 2,
      machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false,
         restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: timestamp, updatedAt: timestamp };
    const definition = validateWorkflowDefinition({ version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }, blocks: ['work'] }).normalizedDefinition!;
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
      acceptedSnapshot: { definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, metadata: null, frozenChildren: {},
        materializedLeaves: [{ sourceKey: '$root', blockId: definition.blocks[0]!.id, kind: 'step',
          selection: definition.defaults ?? {}, authoredWorkspace: { kind: 'inherit' }, executionTarget: { kind: targetKind } }],
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
        executionTarget: { kind: targetKind }, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } } },
    }));
    const index = { id: recordId, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '0',
      lifecycle: 'failed', createdAt: timestamp, updatedAt: timestamp };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId: 'account-1', runId, recordId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: definition.blocks[0]!.id, scope: [] },
        attempt: '0', logicalInvocationRecordId: recordId,
        execution: targetKind === 'detached_run' ? { kind: 'detached_run', runId: 'native-run', localInputId: 'input-1', runtimeSelection: {} }
          : { kind: 'session', sessionId, localInputId: 'input-1' },
        recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
    }));
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({
      runId, ownerAccountId: 'account-1', encryptionMode: 'plain', access: 'owner',
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    });
    http.post.mockImplementation(async (_url: string, body: Readonly<Record<string, unknown>>) => {
      if (body.operation === 'get') return { data: { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus } };
      if (body.operation === 'run-key.census') return { data: keyCensus };
      if (body.operation === 'invocations.get') return { data: { invocation: { index, contentEnvelope, parentRevision: 2 } } };
      if (body.operation === 'invocations.list') return { data: { invocations: [index], parentRevision: 2, keyCensus } };
      throw new Error(`unexpected_effect:${String(body.operation)}`);
    });
    if (targetKind === 'session') {
      const baseGet = http.get.getMockImplementation()!;
      const input = { id: 'input-row', seq: 7, localId: 'input-1', createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
      http.get.mockImplementation(async (url: string) => {
        if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
        if (url.includes('/messages?')) return { status: 200, data: { messages: [input,
          { id: 'started', seq: 8, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent',
            content: { type: 'acp', data: { type: 'task_started', id: 'turn-1' } } } } },
          { id: 'settled', seq: 9, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent',
            content: { type: 'acp', data: { type: 'task_complete', id: 'turn-1' } } } } },
        ] } };
        if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
        if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
          id: sessionId, active: true, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex' }),
        }) } };
        return await baseGet(url);
      });
    }
    machineRpc.mockImplementation(async (input) => {
      if (input.method === RPC_METHODS.SESSION_CONTINUATION_INSPECT) return { type: 'available', protocolVersion: 1, sameSessionTransition: false };
      if (input.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1,
        projection: { v: 2, generation: 1, agentsById: { codex: { id: 'codex',
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } } }, familiesById: {} } };
      return { run: { runId: 'native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
      runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
      inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'failed' } },
      interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } },
      lifecycle: { v: 1, state: 'current' } } };
    });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, resolveServerFeaturesSnapshot: () => enabledFeatures as never });
    expect(await deps.workflowAction!({ actionId: 'workflow.run.invocations.get', input: { runId, invocationId: recordId }, context: {} }))
      .toMatchObject({ invocation: { recoveryAvailability: { retry: { kind: 'available' }, continueSameConversation: { kind: 'available' } } } });
    expect(machineRpc.mock.calls.every(([input]) => input.machineId === 'machine-1')).toBe(true);
    expect(await deps.workflowAction!({ actionId: 'workflow.run.invocations.list', input: { runId }, context: {} }))
      .toEqual({ invocations: [index], parentRevision: 2 });
    if (targetKind === 'detached_run') {
      index.lifecycle = 'running';
      machineRpc.mockResolvedValue({ run: { runId: 'native-run', callId: 'call', sidechainId: 'sidechain', intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'default', retentionPolicy: 'resumable',
        runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 1,
        inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'active' } } } });
      const nativeReadsBefore = machineRpc.mock.calls.length;
      expect(await deps.workflowAction!({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'reattach', invocation: { recordId } }] }, context: {} }))
        .toMatchObject({ run: { id: runId, state: 'interrupted', revision: 2 }, intent: 'recovery_required' });
      expect([...new Set(machineRpc.mock.calls.slice(nativeReadsBefore).map(([input]) => input.method))])
        .toEqual([SESSION_RPC_METHODS.EXECUTION_RUN_GET]);
      expect(http.post.mock.calls.some(([, body]) => ['invocations.admit', 'invocations.recover', 'invocations.fact', 'initialize'].includes(body.operation))).toBe(false);
      const activeNative = ExecutionRunGetResponseSchema.parse(await machineRpc.mock.results.at(-1)?.value);
      machineRpc.mockResolvedValueOnce(activeNative).mockResolvedValueOnce({ ...activeNative, run: { ...activeNative.run,
        inputTurns: { occurrenceId: 'occurrence', current: { turnId: 'turn', inputIds: ['input-1'], state: 'completed',
          result: { kind: 'text', value: 'Done' } } },
      } });
      // This index-only fixture has no structural root. A settled native result
      // must not claim reconciliation when the frozen lexical binding is absent.
      await expect(deps.workflowAction!({ actionId: 'workflow.run.resume', input: { mode: 'recover', runId, expectedRevision: 2,
        invocations: [{ kind: 'reattach', invocation: { recordId } }] }, context: {} }))
        .resolves.toMatchObject({ ok: false, errorCode: 'workflow_outcome_unresolved' });
    }
  });

  it('shares an opened plain Workflow through the credentialed Action host with a key-free storage write', async () => {
    const grants = { artifactId: 'definition-1', ownerAccountId: 'account-1', access: 'owner', grants: [], changed: true };
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/artifacts/definition-1')) return { status: 200, data: {
        id: 'definition-1', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: 'definition-1', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Shared' } }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      } };
      if (url.endsWith('/access/recipients')) return { status: 200, data: {
        artifactId: 'definition-1', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
      } };
      throw new Error(`unexpected_get:${url}`);
    });
    http.put.mockResolvedValue({ status: 200, data: grants });
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1', mode: 'plain', ctx: null });
    const input = { artifactId: 'definition-1', principal: { kind: 'team', teamId: 'team-1' }, accessLevel: 'edit' };
    await expect(createActionExecutor(deps).execute('artifact.access.grants.set' as ActionId, input, {
      surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, bypassApprovals: true,
    })).resolves.toEqual({ ok: true, result: grants });
    expect(http.put).toHaveBeenCalledWith(expect.stringContaining('/v1/artifacts/definition-1/access/grants'), input, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
    expect(http.post).not.toHaveBeenCalled();
  });

  it('normalizes a prompt-only Workflow from the trusted calling Session context', async () => {
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      mode: 'plain', ctx: null,
    });
    const result = await deps.workflowAction!({
      actionId: 'workflow.validate',
      input: { definition: { blocks: ['work'] } },
      context: { defaultSessionId: 'session-1' },
    });

    expect(result).toMatchObject({
      valid: true,
      normalizedDefinition: {
        defaults: {
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
        },
      },
    });
    // Caller authorization may read currentness and the authenticated Session
    // index; normalization never fetches saved Workflow content or starts work.
    expect(http.get.mock.calls.every(([url]) => typeof url === 'string'
      && url.endsWith('/v1/account/encryption/currentness'))).toBe(true);
    expect(http.post.mock.calls.every(([url, input]) => typeof url === 'string'
      && url.endsWith('/v2/sessions/lookup-by-tags')
      && JSON.stringify(input) === JSON.stringify({ tags: ['session-1'] }))).toBe(true);
    expect(http.put).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('records Account cancellation without resolving a local execution machine', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    http.post.mockResolvedValue({ data: { run: { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      id: runId, origin: { kind: 'direct' }, state: 'cancelled', revision: 1,
      machineId: 'offline-machine', workflowCustodyState: 'settled', originDeliveryAckRevision: null,
      availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false,
        inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
    }, intent: 'cancelled' } });
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null },
      resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      sessionId: 'cli-global',
      mode: 'plain', ctx: null,
    });
    await expect(deps.workflowAction!({
      actionId: 'workflow.run.cancel', input: { runId, expectedRevision: 0 }, context: { surface: 'cli' },
    })).resolves.toMatchObject({ run: { id: runId, state: 'cancelled' }, intent: 'cancelled' });
    expect(http.post.mock.calls[0]?.[1]).toEqual({ operation: 'cancel', runId, expectedRevision: 0 });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('does not fabricate Session ingress defaults for a non-Session caller', async () => {
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => enabledFeatures as never,
      mode: 'plain', ctx: null,
    });

    await expect(deps.workflowAction!({
      actionId: 'workflow.validate',
      input: { definition: { blocks: ['work'] } },
      context: { surface: 'cli' },
    })).resolves.toMatchObject({ valid: false });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('reports transport unavailable without promoting a session caller to signed-root authority', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      mode: 'plain',
      ctx: null,
    });
    const execute = deps.workflowAction;
    expect(execute).toBeDefined();
    if (!execute) throw new Error('expected Workflow Action boundary');

    await expect(execute({
      actionId: 'workflow.run.get',
      input: { runId: '33333333-3333-4333-8333-333333333333' },
      context: { surface: 'agent', defaultSessionId: 'session-1' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'target_unavailable',
    });
    const executor = createActionExecutor({ ...deps, isActionApprovalRequired: () => false });
    await expect(executor.execute('workflow.run.get', {
      runId: '33333333-3333-4333-8333-333333333333',
    }, {
      surface: 'agent', defaultSessionId: 'session-1',
    })).resolves.toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
    expect(signedRootAction).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { status: 'ready', provenance: 'authenticated', features: { features: { automations: { enabled: true } }, capabilities: {} } }],
    ['malformed', { status: 'ready', provenance: 'authenticated', features: { features: { automations: { enabled: true }, workflows: { enabled: 'yes' } }, capabilities: {} } }],
    ['disabled', { status: 'ready', provenance: 'authenticated', features: { features: { automations: { enabled: true }, workflows: { enabled: false } }, capabilities: {} } }],
  ])('fails %s workflow availability before any storage effect', async (_name, snapshot) => {
    const deps = createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId: 'session-1',
      rawSession: { path: process.cwd(), machineId: 'machine-1' },
      getCurrentSessionBackendTarget: () => ({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }),
      resolveServerFeaturesSnapshot: () => snapshot as never,
      mode: 'plain', ctx: null,
    });

    await expect(deps.workflowAction!({
      actionId: 'workflow.run.start',
      input: { runId: '33333333-3333-4333-8333-333333333333', source: { kind: 'inline', definition: { blocks: ['work'] } } },
      context: { surface: 'agent', defaultSessionId: 'session-1' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });
});
