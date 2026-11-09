import axios from 'axios';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalExecutionV2Schema, ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createRpcCallError } from '@happier-dev/protocol/rpc/errors';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { handleActionsCommand } from './actions';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = undefined; });

it('accepts existing V2 history and rejects unvalidated diagnostic payloads', () => {
  const execution = { executedAtMs: 1, ok: false, errorCode: 'RPC_FORBIDDEN', error: 'Forbidden' };
  expect(ApprovalExecutionV2Schema.safeParse(execution).success).toBe(true);
  expect(ApprovalExecutionV2Schema.safeParse({ ...execution, failureCause: { phase: 'rpc.admission.machine_admission',
    errorClass: 'UnknownThrownValue', errorCode: 'RPC_FORBIDDEN', httpStatus: null } }).success).toBe(true);
  expect(ApprovalExecutionV2Schema.safeParse({ ...execution, failureCause: { phase: 'rpc.admission.machine_admission',
    errorClass: 'UnknownThrownValue', errorCode: 'RPC_FORBIDDEN', httpStatus: null, privateCredential: 'never-copy' } }).success).toBe(false);
});

it.each(['native_refusal', 'raw_rpc'] as const)('prints %s failureCause and the owning effect fact after real approval settlement and public read', async transport => {
  await withConfiguredDaemonTestHome({ prefix: 'cli-refusal-projection-' }, async () => {
  const endpoint = 'https://cli-refusal.test';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
  const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: 'srv_cli_refusal' } } });
  vi.stubGlobal('fetch', async () => Response.json(features));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (new URL(String(url)).pathname !== '/v1/account/profile') throw new Error('Unexpected Home HTTP read');
    return { status: 200, data: { id: 'owner' } };
  });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  const notices = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {} });
  let effects = 0;
  rpc.registerHandler('demo.effect', () => { effects++; return { revoked: true }; });
  let stored: ApprovalRequest | null = null;
  let onApprovalRequested: Parameters<typeof createCliActionExecutorHarness>[0]['onApprovalRequested'];
  const { executor } = createCliActionExecutorHarness({ token: credentials.token, sessionId: '', mode: 'plain', ctx: null, serverHttpBaseUrl: endpoint,
    onApprovalRequested: (id, signal, decide) => onApprovalRequested?.(id, signal, decide) }, {
    ...createUnavailableActionTransportDeps(),
    // Artifact persistence, native RPC and the host's live-origin observation
    // are boundaries. Approval admission, decision, replay and projection stay real.
    accountApiTokensRevokeAction: async () => {
      const response = await rpc.handleRequest({ method: 'machine:demo.effect', params: { privateOperand: 'never-copy' },
        callerInputAuthorization: JSON.parse('{"privateCredential":"never-copy"}') });
      if (!response || typeof response !== 'object' || !('error' in response) || typeof response.error !== 'string') {
        throw new Error('Expected RPC admission refusal');
      }
      // Machine result wrappers preserve explicit admission evidence. A raw
      // RpcError carries no effect claim; the settlement retains dispatched work.
      if (transport === 'raw_rpc') throw createRpcCallError(response);
      return readMachineActionRpcResult(response);
    },
    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials, machineId: 'machine', serverId: 'home', serverApiUrl: endpoint }),
    approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'approval' }; },
    approvalsGet: async () => stored,
    approvalsUpdate: async ({ request }) => {
      if (!stored) throw new Error('Missing approval');
      const transition = decideApprovalRequestTransition(stored, request);
      if (!transition.ok) return transition;
      stored = ApprovalRequestV2Schema.parse(request);
      return { ok: true };
    },
  });
  const context = { authority: 'account_automation' as const, runtimeAccountId: 'owner', serverId: 'home',
    serverIdentityId: 'srv_cli_refusal', defaultSessionMachineId: 'machine', actionCaller: { kind: 'host' as const } };
  await handleActionsCommand(['invoke', 'account.apiTokens.revoke', '--input-json',
    JSON.stringify({ tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' }), '--yes', '--json'], {
    readCredentialsFn: async () => ({ ...credentials, credentialProvenance: 'stored_session' }),
    createExecutorFn: params => {
      onApprovalRequested = params.onApprovalRequested;
      return { execute: (id, input, ctx) => executor.execute(id, input, { ...ctx, ...context,
        ...(id === 'approval.request.decide' ? { authority: 'present_user' } : {}) }),
      resolveSessionTarget: async () => { throw new Error('Unexpected Session lookup'); } };
    },
  });
  const failureCause = { phase: 'rpc.admission.caller_input_authorization', errorClass: 'UnknownThrownValue',
    errorCode: 'RPC_FORBIDDEN', httpStatus: null };
  expect(effects).toBe(0);
  expect(notices.mock.calls.flat().join(' ')).toContain('approval');
  const effectAttempted = transport === 'raw_rpc';
  expect(stored).toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'RPC_FORBIDDEN', effectAttempted } });
  expect(JSON.parse(output), output).toMatchObject({ ok: false,
    error: { code: 'RPC_FORBIDDEN', failureCause, effectAttempted } });
  expect(await executor.execute('approval.request.get', { artifactId: 'approval' }, { surface: 'cli', ...context }))
    .toMatchObject({ ok: true, result: { request: { execution: { failureCause, effectAttempted } } } });
  expect(output).not.toContain('never-copy');
  expect(process.exitCode).toBe(1);
  });
});
