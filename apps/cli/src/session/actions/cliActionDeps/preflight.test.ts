import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { decodeBase64 } from '@/api/encryption';
import { createCapabilitiesService } from '@/capabilities/service';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import { createCliExecutionRunActionDeps, type CliExecutionRunHost } from './executionRuns';
import { createCliMachineActionTransport } from './machineTransport';
import type { CliActionDepsParams } from './types';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCliActionDeps } from '../createCliActionDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import axios from 'axios';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

const { callSessionRpc } = vi.hoisted(() => ({ callSessionRpc: vi.fn() }));
// Session RPC is the process/network boundary; preserve its neighboring helpers.
vi.mock('@/session/transport/rpc/sessionRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(), callSessionRpc,
}));

const requirement = { detachedScope: true, startAndWait: false, exactInputResults: true,
  runScopedAgentBindings: false, secretReferenceOverlay: false };

async function fixture(actionId: 'scm.diffSummary.generate' | 'session.delete' = 'scm.diffSummary.generate') {
  const home = await createProjectSessionRuntimeFixture({ serverId: 'session-home', serverUrl: 'https://session-home.test' });
  const target = { kind: 'machine', machineId: 'machine' } as const;
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: randomUUID(), target, input: {} });
  const requester = await admitRequesterAccountActionContext({
    authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admitted-root', binding: {
      accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'session-home', machineId: 'machine',
      installationId: home.installation.installationId, actionId,
      requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }), credentials: home.bootstrap.credentials, serverId: 'session-home', serverIdentityId: 'session-home',
    serverHttpBaseUrl: 'https://session-home.test', isCurrent: async () => home.isHomeCurrent(),
  });
  if (!requester) throw new Error('Fixture requester admission failed');
  onTestFinished(() => requester.dispose());
  const service = createCapabilitiesService({ capabilities: [executionRunsCapability],
    checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
    buildContext: async () => { throw new Error('Preflight must not discover native capabilities'); } });
  // Installed Machine invocation is the transport boundary; keep the real
  // authority guard and the real capability descriptor producer beneath it.
  const invoke = vi.fn<NonNullable<CliActionDepsParams['machineActionDirectTargetTransport']>['invoke']>(async method => {
    if (method !== RPC_METHODS.CAPABILITIES_DESCRIBE) throw new Error('Unexpected Machine effect');
    return service.describe();
  });
  const params: CliActionDepsParams = { token: home.bootstrap.credentials.token, credentials: home.bootstrap.credentials,
    sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'session-home', serverHttpBaseUrl: 'https://session-home.test',
    externalActionMachineInstallationId: home.installation.installationId,
    externalActionMachineRequestPrivateKey: decodeBase64(home.installation.privateKey, 'base64url'),
    machineActionDirectTargetTransport: { machineId: 'machine', invoke } };
  const unreachable = () => { throw new Error('An admitted exact target must not be reselected'); };
  const host: CliExecutionRunHost = { ...createCliMachineActionTransport(params),
    resolveTransportForSession: unreachable, readCurrentMachineControlIdentity: unreachable,
    readTransportSessionOwnerMetadata: unreachable, resumeInactiveSessionTransport: unreachable,
    normalizeStringValue: value => typeof value === 'string' && value.trim() ? value.trim() : null,
    isExecutionRunActionAbort: (error, signal) => Boolean(signal?.aborted || error instanceof Error && error.name === 'AbortError'),
    executionRunActionFailure: (code, _message, details) => ({ ok: false, errorCode: code, error: code,
      ...(details === undefined ? {} : { details }) }),
  };
  const options = { exactMachineId: 'machine', authority: 'account_automation',
    serverId: 'session-home', externalActionExecutionAuthorization: requester.authorization, externalActionTarget: target } satisfies
    NonNullable<Parameters<NonNullable<ActionExecutorDeps['executionRunCheckProtocolV2']>>[2]>;
  return { deps: createCliExecutionRunActionDeps(params, host).actionDeps, invoke, options, params };
}

describe('signed exact Execution Run preflight', () => {
  afterEach(() => { callSessionRpc.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('deletes detached history through the original session delete Action on its exact Machine', async () => {
    const { deps, invoke, options } = await fixture('session.delete');
    invoke.mockResolvedValueOnce({ success: true });
    const input = { machineId: 'machine', runId: 'retained-run' };
    await expect(deps.detachedSessionDelete?.({ input, context: {
      surface: 'agent', authority: options.authority, serverId: options.serverId,
      externalActionExecutionAuthorization: options.externalActionExecutionAuthorization, externalActionTarget: options.externalActionTarget,
    } })).resolves.toEqual({ success: true });
    expect(invoke).toHaveBeenCalledWith('session.delete', input, expect.anything());
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('starts an attached SCM child through the public Run Action with its signed root', async () => {
    const { params, options, invoke } = await fixture();
    const homeRead = vi.mocked(axios.get).getMockImplementation();
    if (!homeRead) throw new Error('Fixture Home adapter is unavailable');
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      if (new URL(String(url)).pathname === '/v2/sessions/source-session') {
        return { status: 200, data: { session: createSessionRecordFixture({ id: 'source-session', active: true,
          machineId: 'machine', encryptionMode: 'plain', dataEncryptionKey: null,
          metadata: JSON.stringify({ machineId: 'machine' }) }) } };
      }
      return homeRead(url, config);
    });
    callSessionRpc.mockResolvedValue({ runId: 'signed-attached-run', callId: 'attached-call', sidechainId: 'attached-call' });
    const result = await createActionExecutor(createCliActionDeps(params)).execute('execution.run.start', {
      sessionId: 'source-session', intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Summarize the captured comparison.', localInputId: 'scm-summary-input',
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    }, { surface: 'rpc', authority: 'present_user', serverId: 'session-home', executionRunTargetMachineId: 'machine',
      externalActionExecutionAuthorization: options.externalActionExecutionAuthorization,
      externalActionTarget: options.externalActionTarget });
    expect(result).toMatchObject({ ok: true, result: { runId: 'signed-attached-run' } });
    expect(invoke).toHaveBeenCalledOnce();
    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: `source-session:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`,
      request: expect.objectContaining({ localInputId: 'scm-summary-input' }),
    }));
  });

  it.each(['source-session', null])('admits the signed SCM root for Session %s without native discovery', async sessionId => {
    const { deps, options, invoke } = await fixture();
    await expect(deps.executionRunCheckProtocolV2?.(sessionId, requirement, options))
      .resolves.toEqual({ ok: true, exactMachineId: 'machine' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[2]?.localActionContext?.externalActionExecutionAuthorization)
      .toBe(options.externalActionExecutionAuthorization);
  });

  it('retains the unsigned exact-target control', async () => {
    const { deps, invoke } = await fixture();
    await expect(deps.executionRunCheckProtocolV2?.(null, requirement, { exactMachineId: 'machine' }))
      .resolves.toEqual({ ok: true, exactMachineId: 'machine' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('carries a non-retryable signed preflight refusal through the public Start result without creating a Run', async () => {
    const { params, options, invoke } = await fixture();
    await expect(createActionExecutor(createCliActionDeps(params)).execute('execution.run.start', {
      sessionId: null, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      instructions: 'Must not start without target authority.', permissionMode: 'read_only',
      retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    }, { surface: 'rpc', authority: 'present_user', serverId: 'session-home', executionRunTargetMachineId: 'machine',
      externalActionExecutionAuthorization: options.externalActionExecutionAuthorization }))
      .resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated', details: {
        executionRunPreflight: { phase: 'capabilities.describe', cause: { code: 'not_authenticated' } },
        executionRunStart: { runCreation: 'noRunCreated' },
      } });
    expect(invoke).not.toHaveBeenCalled();
    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('refuses a wrong Home with its cause and preflight phase before invoking the Machine', async () => {
    const { deps, options, invoke } = await fixture();
    await expect(deps.executionRunCheckProtocolV2?.(null, requirement, { ...options, serverId: 'wrong-home' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_scope_mismatch',
        details: { executionRunPreflight: { phase: 'capabilities.describe', cause: { code: 'server_scope_mismatch' } } } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('retains a typed transport refusal while excluding arbitrary exception content', async () => {
    const { deps, options, invoke } = await fixture();
    invoke.mockRejectedValueOnce(new RpcError('private receiver content', RPC_ERROR_CODES.FORBIDDEN));
    await expect(deps.executionRunCheckProtocolV2?.(null, requirement, options)).resolves.toEqual({
      ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: RPC_ERROR_CODES.FORBIDDEN,
      details: { executionRunPreflight: { phase: 'capabilities.describe', cause: { code: RPC_ERROR_CODES.FORBIDDEN } } },
    });
    invoke.mockRejectedValueOnce(Object.assign(new Error('private receiver content'), { code: 'private receiver code' }));
    await expect(deps.executionRunCheckProtocolV2?.(null, requirement, options)).resolves.toEqual({
      ok: false, errorCode: 'execution_run_target_unavailable', error: 'execution_run_target_unavailable',
      details: { executionRunPreflight: { phase: 'capabilities.describe', cause: { code: null } } },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
