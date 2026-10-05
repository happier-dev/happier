import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  createActionExecutor,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  computeExternalActionRequestEnvelopeDigestV1,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  openExternalActionResponseV2,
  sealExternalActionRequestV2,
  verifyExternalActionApprovalInputV1,
  type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';
import { API_TOKEN_FULL_GRANT_V1, buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
} from './executeExternalAction';

const principal = {
  accountId: 'account-1',
  principalId: 'principal-1',
  credentialId: 'credential-1',
  grant: API_TOKEN_FULL_GRANT_V1,
  authority: 'account_automation',
} as const;

const SESSION_SPAWN_PENDING_RESULT = {
  type: 'pending',
  retryWithSameCreationKey: true,
  outcome: 'accepted',
} as const;

/**
 * The real host executor requires its complete dependency surface. Every
 * dependency a case does not deliberately provide throws, so an unexpected
 * Action dispatch fails loudly instead of resolving `undefined`.
 */
function createUnavailableHostActionDeps(): ActionExecutorDeps {
  const unavailable = (name: string) => async (): Promise<never> => {
    throw new Error(`Unexpected host Action dependency call: ${name}`);
  };
  return {
    executionRunStart: unavailable('executionRunStart'),
    executionRunList: unavailable('executionRunList'),
    executionRunGet: unavailable('executionRunGet'),
    executionRunStop: unavailable('executionRunStop'),
    executionRunAction: unavailable('executionRunAction'),
    executionRunWait: unavailable('executionRunWait'),
    detachedExecutionRunSend: unavailable('detachedExecutionRunSend'),
    sessionOpen: unavailable('sessionOpen'),
    sessionFork: unavailable('sessionFork'),
    sessionRollback: unavailable('sessionRollback'),
    sessionSpawnNew: unavailable('sessionSpawnNew'),
    sessionSendMessage: unavailable('sessionSendMessage'),
    sessionList: unavailable('sessionList'),
    sessionModeSet: unavailable('sessionModeSet'),
    sessionModesList: unavailable('sessionModesList'),
    sessionActivityGet: unavailable('sessionActivityGet'),
    sessionRecentMessagesGet: unavailable('sessionRecentMessagesGet'),
    pathsListRecent: unavailable('pathsListRecent'),
    machinesList: unavailable('machinesList'),
    serversList: unavailable('serversList'),
    reviewEnginesList: unavailable('reviewEnginesList'),
    agentsBackendsList: unavailable('agentsBackendsList'),
    agentsModelsList: unavailable('agentsModelsList'),
    daemonMemorySearch: unavailable('daemonMemorySearch'),
    daemonMemoryGetWindow: unavailable('daemonMemoryGetWindow'),
    daemonMemoryEnsureUpToDate: unavailable('daemonMemoryEnsureUpToDate'),
    resetGlobalVoiceAgent: unavailable('resetGlobalVoiceAgent'),
  };
}

function createExactLimitMultibyteResult(): string {
  const emptyResponse = {
    v: 1,
    actionId: 'session.status.get',
    requestId: 'request-limit',
    execution: { ok: true, result: '' },
  } as const;
  const fixedBytes = measureExternalActionResponseEnvelopeUtf8BytesV1(emptyResponse);
  const multibyteMarker = 'é';
  const markerBytes = new TextEncoder().encode(multibyteMarker).byteLength;
  return 'a'.repeat(
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - fixedBytes - markerBytes,
  ) + multibyteMarker;
}

describe('executeExternalAction', () => {
  it('uses the current signed grant instead of a wider cached PAT grant', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.permission_mode.set',
      requestId: 'narrowed-send', target: { kind: 'session' as const, sessionId: 'session-1' } };
    const envelope = sealExternalActionRequestV2({ binding, material,
      input: { sessionId: 'session-1', permissionMode: 'yolo' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const authorization = { v: 1 as const, token: 'current-home-proof', binding: {
      ...binding, principalId: principal.principalId, machineId: 'machine-1',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['default'] as ['default'] },
    } };
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId },
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      currentMachineId: 'machine-1', currentServerId: 'server-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: async () => binding.target,
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), sessionPermissionModeSet }),
    });
    if (result.kind !== 'response' || result.response.v !== 2) throw new Error('Expected protected response');
    expect(openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope }))
      .toMatchObject({ ok: false, errorCode: 'permission_mode_not_granted' });
    expect(sessionPermissionModeSet).not.toHaveBeenCalled();
  });

  it('checks bound creation against decrypted V2 fields before host launch', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const placement = { folderId: 'leads', tagIds: ['inbound'] };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['session.spawn_new'] },
      targets: { sessions: ['existing-only'], machines: [] },
      create: { machineId: 'machine-1', agentTargetKey: buildBackendTargetKeyV2(agentTarget), directory: 'managed' as const, placement } };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.spawn_new',
      requestId: 'bound-create', target: { kind: 'machine' as const, machineId: 'machine-1' } };
    const sessionSpawnNew = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(), sessionSpawnNew });
    const run = async (directory: unknown) => {
      const envelope = sealExternalActionRequestV2({ binding, material, input: {
        creationKey: 'create-bound',
        agentTarget, directory, organizationPlacement: placement,
      }, randomBytes: (length) => new Uint8Array(length).fill(2) });
      const result = await executeExternalAction({ actionId: binding.actionId, envelope,
        principal: { ...principal, credentialId: binding.credentialId, grant },
        currentMachineId: 'machine-1', currentServerId: 'server-1',
        resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
        resolveTarget: async () => binding.target, executor });
      if (result.kind !== 'response' || result.response.v !== 2) throw new Error('Expected protected response');
      return openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope });
    };
    expect(await run({ kind: 'path', path: '/ungranted' })).toMatchObject({
      ok: false, errorCode: 'credential_scope_denied',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(await run({ kind: 'managed' })).toMatchObject({ ok: true });
    expect(sessionSpawnNew).toHaveBeenCalledOnce();
  });

  it('admits a present-user signed-root handoff on its UI surface', async () => {
    const sessionHandoffStart = vi.fn(async () => ({
      handoffId: 'handoff-1',
      status: {
        handoffId: 'handoff-1',
        status: 'pending' as const,
        phase: 'preparing' as const,
        recoveryActions: [],
      },
      workspace: { kind: 'none' as const },
    }));
    const executor = createActionExecutor({
      ...createUnavailableHostActionDeps(),
      sessionHandoffStart,
      sessionHandoffTargetReplacementApprovalPreflight: vi.fn(async () => ({ type: 'not_required' as const })),
      resolveServerIdForSessionId: vi.fn(() => 'server-1'),
    });

    await expect(executeExternalAction({
      actionId: 'session.handoff',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-1', targetMachineId: 'machine-2' },
      },
      principal: { authority: 'present_user' },
      currentMachineId: 'machine-1',
      currentServerId: 'server-1',
      resolveTarget: async ({ target }) => target ?? null,
      executor,
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });
    expect(sessionHandoffStart).toHaveBeenCalledTimes(1);
  });

  it('admits present-user signed-root Actions while keeping them outside PAT admission', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: true,
      result: { decided: true },
    }));
    const request = {
      actionId: 'approval.request.decide',
      envelope: {
        v: 1 as const,
        input: { artifactId: 'approval-1', decision: 'approve' },
      },
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine' as const, machineId: 'machine-1' }),
      executor: { execute },
    };

    await expect(executeExternalAction({
      ...request,
      principal: { authority: 'present_user' },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true, result: { decided: true } } },
    });
    expect(execute).toHaveBeenCalledWith(
      'approval.request.decide',
      request.envelope.input,
      expect.objectContaining({ surface: 'ui', authority: 'present_user' }),
    );

    execute.mockClear();
    await expect(executeExternalAction({ ...request, principal })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_action',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves an explicitly trusted CLI surface on signed-root ingress', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: true,
      result: { installed: true },
    }));

    await executeExternalAction({
      actionId: 'plugins.install',
      envelope: { v: 1, input: { source: '/workspace/plugin' } },
      principal: { authority: 'present_user' },
      surface: 'cli',
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: { execute },
    });

    expect(execute).toHaveBeenCalledWith(
      'plugins.install',
      { source: '/workspace/plugin' },
      expect.objectContaining({ surface: 'cli', authority: 'present_user' }),
    );
  });

  it('stamps a signed workflow project target into host context only on its exact daemon', async () => {
    const target = {
      kind: 'machine' as const,
      machineId: 'machine-1',
      project: { machineId: 'machine-1', directory: '~/projects/app', workspaceRefId: 'workspace-1' },
    };
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({ ok: true, result: {} }));
    await executeExternalAction({
      actionId: 'workflow.run.start',
      envelope: { v: 1, input: { runId: '11111111-1111-4111-8111-111111111111', source: { kind: 'inline', definition: { version: 1, inputs: [], defaults: {}, blocks: [] } } }, target },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async ({ target: resolved }) => resolved ?? null,
      executor: { execute },
    });
    expect(execute).toHaveBeenCalledWith('workflow.run.start', expect.anything(), expect.objectContaining({
      externalActionTarget: target,
    }));
  });

  it('binds a V1 request without correlation to its outer Machine and signs its resolved Session approval input', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const envelope = {
      v: 1 as const,
      input: { sessionId: 'session-1', title: 'Exact title' },
    };
    const authorization = {
      v: 1 as const,
      token: 'opaque-home-authorization',
      binding: {
        serverIdentityId: 'srv-cryptographic-home',
        accountId: principal.accountId,
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        machineId: 'machine-implied',
        actionId: 'session.title.set',
        requestId: 'home-generated-request',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: { kind: 'machine' as const, machineId: 'machine-implied' },
        grant: API_TOKEN_FULL_GRANT_V1,
      },
    };
    const execute = vi.fn<ExternalActionExecutor['execute']>(async (_actionId, actionInput, context) => {
      const signature = context?.signExternalActionApprovalInput?.({
        actionId: 'session.title.set',
        input: actionInput,
        target: context.externalActionTarget!,
        authorization,
      });
      expect(verifyExternalActionApprovalInputV1({
        authorizationToken: authorization.token,
        actionId: 'session.title.set',
        target: { kind: 'session', sessionId: 'session-1' },
        input: envelope.input,
        publicKey: keyPair.publicKey,
        signature: signature ?? '',
      })).toBe(true);
      return { ok: false, errorCode: 'expected_test_stop', error: 'expected_test_stop' };
    });

    await executeExternalAction({
      actionId: 'session.title.set',
      envelope,
      principal,
      currentMachineId: 'machine-implied',
      currentServerId: 'local-profile-id',
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      resolveTarget: async () => ({ kind: 'session', sessionId: 'session-1' }),
      executor: { execute },
    });

    expect(execute).toHaveBeenCalledWith(
      'session.title.set',
      envelope.input,
      expect.objectContaining({
        actionRequestId: 'home-generated-request',
        serverId: 'local-profile-id',
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        externalActionExecutionAuthorization: authorization,
      }),
    );
  });

  it('rejects a protected Machine binding before Session reconciliation can select this daemon', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'wrong-receiver', target: { kind: 'machine' as const, machineId: 'other-machine' } };
    const envelope = sealExternalActionRequestV2({ binding, material,
      input: { sessionId: 'session-1', message: 'private-input' }, randomBytes: (length) => new Uint8Array(length).fill(2) });
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: async () => { throw new Error('Wrong receiving Machine must reject before target resolution'); },
      executor: { execute: async () => { throw new Error('Wrong receiving Machine cannot execute'); } },
    });
    expect(result).toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_encrypted_envelope',
      requestId: 'wrong-receiver',
    });
  });

  it('rejects a foreign Session target before a Session-bound receiver opens the envelope', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'foreign-session', target: { kind: 'session' as const, sessionId: 'session-other' } };
    const envelope = sealExternalActionRequestV2({ binding, material,
      input: { sessionId: 'session-other', message: 'private-input' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      currentSessionId: 'session-own',
      // This receiver's own material would open the envelope, so the refusal is
      // the bound-Session guard and not a failed open.
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget,
      executor: { execute: async () => { throw new Error('A foreign Session cannot execute'); } },
    });
    expect(result).toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_encrypted_envelope',
      requestId: 'foreign-session',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it('keeps a many-Session daemon deciding the same foreign Session at its target owner', async () => {
    // The same envelope as the case above. Without a bound Session the receiver
    // cannot answer the question before opening, so the decision stays with
    // `resolveTarget` exactly as it did before that fact existed.
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'foreign-session', target: { kind: 'session' as const, sessionId: 'session-other' } };
    const envelope = sealExternalActionRequestV2({ binding, material,
      input: { sessionId: 'session-other', message: 'private-input' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => null);
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget,
      executor: { execute: async () => { throw new Error('A foreign Session cannot execute'); } },
    });
    expect(result.kind).toBe('response');
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it('keeps admitting its own bound Session on a Session-bound receiver', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.message.send',
      requestId: 'own-session', target: { kind: 'session' as const, sessionId: 'session-own' } };
    const envelope = sealExternalActionRequestV2({ binding, material,
      input: { sessionId: 'session-own', message: 'hello' },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => binding.target);
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId }, currentMachineId: 'machine-1',
      currentSessionId: 'session-own',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget,
      executor: { execute: async () => ({ ok: true, result: { status: 'accepted', localId: 'local-1' } }) },
    });
    expect(result.kind).toBe('response');
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it('rejects a present authorization whose immutable envelope binding does not match', async () => {
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const envelope = { v: 1 as const, requestId: 'request-1', input: {} };
    await expect(executeExternalAction({
      actionId: 'action.spec.get',
      envelope,
      principal,
      currentMachineId: 'machine-1',
      currentServerId: 'server-1',
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair().secretKey,
      executionAuthorization: {
        v: 1,
        token: 'opaque-home-authorization',
        binding: {
          serverIdentityId: 'server-1',
          accountId: principal.accountId,
          principalId: principal.principalId,
          credentialId: principal.credentialId,
          grant: principal.grant,
          machineId: 'machine-1',
          actionId: 'action.spec.get',
          requestId: envelope.requestId,
          requestEnvelopeDigest: 'A'.repeat(43),
          target: { kind: 'machine', machineId: 'machine-1' },
        },
      },
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
      requestId: 'request-1',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a correlated protected transport failure when V2 omits its target', async () => {
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const execute = vi.fn<ExternalActionExecutor['execute']>();

    await expect(executeExternalAction({
      actionId: 'session.message.send',
      envelope: {
        v: 2,
        requestId: 'protected-missing-target',
        payload: { t: 'encrypted', c: 'opaque' },
      },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'target_required',
      requestId: 'protected-missing-target',
    });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('opens V2 before canonical target reconciliation and seals its complete rejection', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const binding = {
      serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001',
      actionId: 'session.message.send', requestId: 'protected-reconciliation',
      target: { kind: 'session' as const, sessionId: 'session-1' },
    };
    const request = sealExternalActionRequestV2({
      binding, material, randomBytes: (length) => new Uint8Array(length).fill(2),
      input: { sessionId: 'different-session', message: 'private-input-sentinel' },
    });
    const result = await executeExternalAction({
      actionId: binding.actionId, envelope: request,
      principal: { ...principal, credentialId: binding.credentialId },
      currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      // These are unreachable after the real reconciliation rejects conflicting targets.
      resolveTarget: async () => { throw new Error('Target lookup must not run'); },
      executor: { execute: async () => { throw new Error('Action must not execute'); } },
    });
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') throw new Error('Expected encrypted rejection');
    expect(result.response.v).toBe(2);
    expect(result.prepared.body).not.toContain('private-input-sentinel');
    expect(openExternalActionResponseV2({ envelope: result.response, binding, request, material }))
      .toMatchObject({ ok: false, errorCode: 'target_not_local' });
  });

  it('seals an executor exception after opening V2 instead of exposing a plaintext transport failure', async () => {
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(7) };
    const binding = {
      serverIdentityId: 'srv_test', accountId: principal.accountId,
      credentialId: '00000000-0000-4000-8000-000000000001',
      actionId: 'session.activity.get', requestId: 'protected-executor-failure',
      target: { kind: 'machine' as const, machineId: 'machine-1' },
    };
    const request = sealExternalActionRequestV2({
      binding,
      material,
      input: { sessionId: 'session-1' },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });

    const result = await executeExternalAction({
      actionId: binding.actionId,
      envelope: request,
      principal: { ...principal, credentialId: binding.credentialId },
      currentMachineId: 'machine-1',
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: async () => binding.target,
      executor: { execute: async () => { throw new Error('private executor failure'); } },
    });

    expect(result.kind).toBe('response');
    if (result.kind !== 'response') throw new Error('Expected encrypted failure');
    expect(result.response.v).toBe(2);
    expect(result.prepared.body).not.toContain('private executor failure');
    expect(openExternalActionResponseV2({ envelope: result.response, binding, request, material }))
      .toEqual({ ok: false, errorCode: 'internal_error', error: 'internal_error' });
  });

  it('admits client placement to the canonical executor for connected app delivery', async () => {
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => ({ kind: 'machine', machineId: 'machine-1' }));
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({ ok: false, errorCode: 'unavailable', error: 'noClient' }));

    await expect(executeExternalAction({
      actionId: 'ui.current_context.read',
      envelope: { v: 1, requestId: 'request-client-placement', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'ui.current_context.read',
        requestId: 'request-client-placement',
        execution: {
          ok: false,
          errorCode: 'unavailable',
          error: 'noClient',
        },
      },
    });
    expect(resolveTarget).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('ui.current_context.read', {}, expect.objectContaining({ authority: 'account_automation' }));
  });

  it('projects the exact public Session admission result before returning it', async () => {
    const base = {
      actionId: 'session.message.send',
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine' as const, machineId: 'machine-1' }),
    };
    const envelope = {
      v: 1 as const,
      target: { kind: 'machine' as const, machineId: 'machine-1' },
      input: { sessionId: 'session-1', message: 'continue', localId: 'caller-local-id' },
    };

    await expect(executeExternalAction({
      ...base,
      envelope,
      executor: { execute: async () => ({
        ok: true,
        result: { status: 'accepted', localId: 'caller-local-id' },
      }) },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: { ok: true, result: { status: 'accepted', localId: 'caller-local-id' } },
      },
    });

    await expect(executeExternalAction({
      ...base,
      envelope,
      executor: { execute: async () => ({
        ok: true,
        result: { status: 'accepted', localId: 'caller-local-id', privateDiagnostic: true },
      }) },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'invalid_action_output',
        },
      },
    });
  });

  it('returns the one prepared direct-HTTP response projection from the ingress owner', async () => {
    const result = await executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, requestId: 'request-prepared', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: {
        execute: async () => ({ ok: true, result: SESSION_SPAWN_PENDING_RESULT }),
      },
    });

    expect(result).toMatchObject({
      kind: 'response',
      prepared: {
        response: {
          v: 1,
          actionId: 'session.spawn_new',
          requestId: 'request-prepared',
          execution: { ok: true, result: SESSION_SPAWN_PENDING_RESULT },
        },
      },
    });
    if (result.kind !== 'response') throw new Error('expected admitted response');
    expect(result.prepared.body).toBe(JSON.stringify(result.prepared.response));
    expect(result.prepared.byteLength).toBe(new TextEncoder().encode(result.prepared.body).byteLength);
  });

  it.each([
    ['BigInt', () => ({ value: BigInt(1) })],
    ['cyclic data', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
  ])('projects reachable non-JSON failure details from %s to invalid_action_output', async (_case, details) => {
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => ({
      ok: false,
      errorCode: 'action_failed',
      error: 'action_failed',
      details: details(),
    }));

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'invalid_action_output',
          error: 'invalid_action_output',
        },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact-limit multibyte response, replaces one-byte-over after execution, and remains usable', async () => {
    const exactLimitResult = createExactLimitMultibyteResult();
    const execute = vi.fn<ExternalActionExecutor['execute']>()
      .mockResolvedValueOnce({ ok: true, result: exactLimitResult })
      .mockResolvedValueOnce({ ok: true, result: `${exactLimitResult}a` })
      .mockResolvedValueOnce({ ok: true, result: { carrier: 'usable' } });
    const request = {
      actionId: 'session.status.get',
      envelope: {
        v: 1,
        requestId: 'request-limit',
        target: { kind: 'session' as const, sessionId: 'session-1' },
        input: { sessionId: 'session-1' },
      },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget: vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null),
      executor: { execute },
    } as const;

    const exact = await executeExternalAction(request);
    expect(exact.kind).toBe('response');
    if (exact.kind !== 'response') throw new Error('expected admitted response');
    expect(measureExternalActionResponseEnvelopeUtf8BytesV1(exact.response))
      .toBe(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    if (exact.response.v !== 1) throw new Error('expected an unsealed V1 response envelope');
    expect(exact.response.execution).toEqual({ ok: true, result: exactLimitResult });

    await expect(executeExternalAction(request)).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.status.get',
        requestId: 'request-limit',
        execution: {
          ok: false,
          errorCode: 'result_too_large',
          error: 'Action execution completed, but its response exceeded the external Action response limit and could not be represented.',
          details: {
            executionCompleted: true,
            maxSerializedBytes: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
          },
        },
      },
    });

    await expect(executeExternalAction(request)).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.status.get',
        requestId: 'request-limit',
        execution: { ok: true, result: { carrier: 'usable' } },
      },
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('stamps verified PAT provenance and the local machine target before one executor call', async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: SESSION_SPAWN_PENDING_RESULT,
    }));
    const resolveTarget = vi.fn(async () => ({ kind: 'machine' as const, machineId: 'machine-1' }));

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        requestId: 'request-1',
        input: { directory: '/workspace', prompt: 'hello' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
      signal,
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-1',
        execution: { ok: true, result: SESSION_SPAWN_PENDING_RESULT },
      },
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.spawn_new',
      target: undefined,
      currentMachineId: 'machine-1',
      signal,
    });
    expect(execute).toHaveBeenCalledWith(
      'session.spawn_new',
      { directory: '/workspace', prompt: 'hello' },
      {
        surface: 'api',
        authority: 'account_automation',
        actionCaller: { kind: 'host' },
        actionRequestId: 'request-1',
        externalActionCredential: {
          accountId: 'account-1',
          principalId: 'principal-1',
          credentialId: 'credential-1',
        },
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        signal,
      },
    );
  });

  it('relays the canonical public failure projection for a contributed Action', async () => {
    const executor = {
      execute: async () => ({
        ok: false as const,
        errorCode: 'target_declined',
        error: 'Target rejected this request',
        details: { reason: 'policy' },
        retryable: true,
        data: { internalTargetState: 'declined' },
        actionHandlerInvocation: 'notStarted' as const,
      }),
    } as unknown as ExternalActionExecutor;
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    const response = await executeExternalAction({
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: {
          action: { pluginId: 'acme.notes', localId: 'save-note' },
          input: { title: 'Quarterly notes' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor,
    });

    expect(response).toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'action.invoke',
        execution: {
          ok: false,
          errorCode: 'target_declined',
          error: 'Target rejected this request',
          details: { reason: 'policy' },
        },
      },
    });
  });

  it('rejects a target for another machine without invoking the local executor', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn(async () => null);

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-2' },
        input: {},
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an explicit session target that is no longer owned by this daemon', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn(async () => null);

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-other-machine' },
        input: { sessionId: 'session-other-machine' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-other-machine' },
      currentMachineId: 'machine-1',
      signal: undefined,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('derives an unambiguous Session input as the exact target and stamps it as Action context', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { opened: true } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target, currentMachineId }) => target ?? {
      kind: 'machine' as const,
      machineId: currentMachineId,
    });

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        input: { sessionId: 'session-1' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: { ok: true, result: { opened: true } },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-1',
      signal: undefined,
    });
    expect(execute).toHaveBeenCalledWith(
      'session.open',
      { sessionId: 'session-1' },
      expect.objectContaining({
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        defaultSessionId: 'session-1',
        defaultSessionMachineId: 'machine-1',
      }),
    );
  });

  it('rejects a conventional Session selector that conflicts with the envelope target', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-2' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_not_local',
          error: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not let a title-only session.open selector escape an exact Session target', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn();

    await expect(executeExternalAction({
      actionId: 'session.open',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionTitle: 'untrusted title selector' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.open',
        execution: {
          ok: false,
          errorCode: 'target_required',
          error: 'target_required',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('stamps the admitted machine only for a detached execution run', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { runs: [] } }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'execution.run.list',
      envelope: {
        v: 1,
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { sessionId: null },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });

    expect(execute).toHaveBeenCalledWith(
      'execution.run.list',
      { sessionId: null },
      expect.objectContaining({ executionRunTargetMachineId: 'machine-1' }),
    );
  });

  it('refuses a machine-owned Action whose canonical machine input names another daemon', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn();

    await expect(executeExternalAction({
      actionId: 'memory.ensure_up_to_date',
      envelope: {
        v: 1,
        input: { machineId: 'machine-elsewhere' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        execution: {
          ok: false,
          errorCode: 'target_not_local',
        },
      },
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not mistake a Session handoff destination for an ingress target selector', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: {
        handoffId: 'handoff-1',
        status: {
          handoffId: 'handoff-1',
          status: 'completed' as const,
          phase: 'finalizing' as const,
          recoveryActions: [],
        },
        workspace: {
          kind: 'relationship' as const,
          relationshipId: 'relationship-1',
          created: true,
        },
      },
    }));
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);

    await expect(executeExternalAction({
      actionId: 'session.handoff',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: { sessionId: 'session-1', targetMachineId: 'machine-elsewhere' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: { execution: { ok: true } },
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects caller-owned authority before it reaches the Action executor', async () => {
    const execute = vi.fn();

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        input: {},
        authority: 'present_user',
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      currentMachineId: 'machine-1',
      resolveTarget: vi.fn(),
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('validates the envelope before daemon Action-id admission for a syntactically valid unknown Action', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();

    await expect(executeExternalAction({
      actionId: 'unknown.public.action',
      envelope: { v: 1, input: { nonFinite: Number.POSITIVE_INFINITY } },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_envelope',
    });

    expect(resolveTarget).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('projects target-resolution faults as target_unavailable without leaking a route exception', async () => {
    const execute = vi.fn();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => {
      throw new Error('Session ownership lookup failed');
    });

    await expect(executeExternalAction({
      actionId: 'session.spawn_new',
      envelope: { v: 1, requestId: 'target-resolution-fault', input: {} },
      principal,
      currentMachineId: 'machine-1',
      resolveTarget,
      executor: { execute },
    })).resolves.toMatchObject({
      kind: 'response',
      response: {
        requestId: 'target-resolution-fault',
        execution: {
          ok: false,
          errorCode: 'target_unavailable',
          error: 'target_unavailable',
        },
      },
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
