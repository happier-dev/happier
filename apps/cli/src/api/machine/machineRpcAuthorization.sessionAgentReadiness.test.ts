import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildMachineAgentsDetectRequest } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createActionExecutor } from '@happier-dev/protocol';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import * as installationStore from '@/daemon/identity/store';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { encodeStoredCredentials } from '@/persistence';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';
import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';

describe('signed Session Agent readiness receiver', () => {
  it.each([
    { child: SESSION_AGENT_READINESS_CHILDREN_V1.inventory, method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      actionInput: { agentId: 'codex', refresh: true }, request: { machineId: 'machine', selection: 'agents' } },
    { child: SESSION_AGENT_READINESS_CHILDREN_V1.inventory, method: RPC_METHODS.CAPABILITIES_DETECT,
      actionInput: { agentId: 'codex', refresh: true },
      request: buildMachineAgentsDetectRequest({ agents: [{ agentId: 'codex', title: 'Codex' }], refresh: true, readinessOnly: true }) },
    { child: SESSION_AGENT_READINESS_CHILDREN_V1.acquire, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
      actionInput: { agentId: 'codex', intent: 'install', consent: { vendorRecipe: false } },
      request: { agentId: 'codex', intent: 'install', consent: { vendorRecipe: false } } },
    { child: SESSION_AGENT_READINESS_CHILDREN_V1.status, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
      actionInput: { jobId: 'job', waitForTerminal: true }, request: { jobId: 'job', cursor: 0, waitForTerminal: true } },
    { child: SESSION_AGENT_READINESS_CHILDREN_V1.status, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
      actionInput: { jobId: 'job', waitForTerminal: false }, request: { jobId: 'job', cursor: 0, waitForTerminal: false } },
  ])('admits exact $child.role through Home and refuses altered proof or input', async scenario => {
    const keys = tweetnacl.sign.keyPair();
    const admission = { actorAccountId: 'requester', custodianAccountId: 'company', machineId: 'machine',
      installationId: 'installation', role: scenario.child === SESSION_AGENT_READINESS_CHILDREN_V1.acquire ? 'manage' as const : 'use' as const,
      encryptionMode: 'plain' as const };
    const envelope = { v: 1 as const, requestId: 'spawn', target: { kind: 'machine' as const, machineId: admission.machineId }, input: {
      executionTarget: { serverId: 'home', machineId: admission.machineId }, directory: { kind: 'path', path: '/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      organizationPlacement: { sectionId: 'section', tagIds: [] },
      agentInstallConsent: { vendorRecipe: false },
    } };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'company', serverIdentityId: 'home', machineId: admission.machineId, installationId: admission.installationId,
      actionId: 'session.spawn_new', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
      purpose: { kind: 'machine_rpc', method: scenario.method, params: scenario.request },
      credentials: encodeStoredCredentials({ token: 'requester-account', credentialProvenance: 'stored_session', encryption: null }),
      installationPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
    const method = `${admission.machineId}:${scenario.method}`;
    const requestId = '0123456789abcdef0123456789abcdef';
    const childInput = getActionSpec(scenario.child.action).inputSchema.parse({ machineId: admission.machineId,
      ...(scenario.child === SESSION_AGENT_READINESS_CHILDREN_V1.inventory ? { serverId: 'home' } : {}), ...scenario.actionInput });
    const reviewedChild = { actionId: scenario.child.action, role: scenario.child.role,
      inputDigest: computeActionInputApprovalDigestV1(scenario.child.action, childInput) };
    const encode = async (request: unknown) => socketRpcCodec.encodeParams({ mode: 'plain' }, request, { method, callId: requestId });
    const packet = (params: unknown, proof = reviewedChild) => ({ method, requestId, params,
      originalActionEnvelope: envelope, externalActionExecution: { v: 1, authorization: sealed, effectActionId: scenario.child.action,
        target: root.binding.target, installationId: admission.installationId, reviewedChild: proof,
        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token, requesterAccountContext: sealed.requesterAccountContext,
          effectActionId: scenario.child.action, target: root.binding.target, installationId: admission.installationId,
          method, requestId, params, reviewedChild: proof, privateKey: keys.secretKey }) } });
    const channel = await createRequesterCurrentnessSocketHarness();
    const installed = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: admission.installationId, createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
      privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    // Home is the genuine network boundary. All local parsing, custody opening,
    // proof binding, native owner selection and handler dispatch remain real.
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true } });
    const homeChildRequests: unknown[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/machines/machine') {
        homeChildRequests.push(config?.headers?.Authorization);
        throw new Error('Home refused this child before dispatch');
      }
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected requester HTTP path ${path}`);
    });
    try {
      const boundary: MachineRpcAdmissionBoundary = { machineId: admission.machineId, resolveInstallationId: () => admission.installationId,
        resolveCustodianAccountId: async () => admission.custodianAccountId, resolveHomeServerIdentityId: async () => 'home',
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
          daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid' }) };
      const rpc = new RpcHandlerManager({ scopePrefix: admission.machineId, localMachineId: admission.machineId, scopeKind: 'machine',
        encryptionMode: 'plain', logger: () => {},
        authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, boundary, source),
        prepareRequesterAccountContext: input => prepareInstalledRequesterAccountActionContext({ ...input,
          machineId: admission.machineId, serverId: 'home', serverHttpBaseUrl: 'https://home.invalid',
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: admission.machineId, serverIdentityId: 'home' }),
          createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()) }),
      });
      const effects: unknown[] = [];
      const localChildEffects: unknown[] = [];
      rpc.registerHandler(scenario.method, async (request, context) => {
        effects.push(request);
        if (scenario.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE && context?.callerInputAuthorization) {
          const transport = createCliMachineActionTransport({ credentials: { token: 'custodian-account', encryption: null, credentialProvenance: 'stored_session' },
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.invalid',
            externalActionMachineInstallationId: admission.installationId, externalActionMachineRequestPrivateKey: keys.secretKey,
            machineActionDirectTargetTransport: { machineId: admission.machineId,
              invoke: async (_method, request) => { localChildEffects.push(request); return { accepted: true }; } } });
          await invokeHostAdmittedSignedReviewedChildV1({ context: { surface: 'rpc', authority: 'present_user',
            machineAdmission: admission, externalActionExecutionAuthorization: context.callerInputAuthorization,
            externalActionTarget: root.binding.target, originalActionEnvelope: envelope },
            child: { ...reviewedChild, input: childInput }, execute: async (_input, childContext) => {
              await transport.callMachineAction({ machineId: admission.machineId, method: scenario.method, request,
                context: childContext, effectActionId: scenario.child.action }).catch(() => undefined);
            } });
        }
        return { accepted: true };
      });
      const invoke = async (request: unknown, proof = reviewedChild) => {
        const params = await encode(request);
        const result = await rpc.handleRequest({ method, params, requestId, callerAuthority: 'present_user', machineAdmission: admission,
          callerInputAuthorization: sealed, originalActionEnvelope: envelope, workspaceSyncSourceExecution: packet(params, proof) });
        return socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result }, requestId);
      };
      const response = await invoke(scenario.request);
      expect(localChildEffects).toEqual([]);
      if (scenario.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        expect(homeChildRequests).toEqual(['Bearer requester-account']);
      }
      expect(response).toEqual({ accepted: true });
      expect(effects).toEqual([scenario.request]);
      expect(post.mock.calls.filter(([url]) => String(url).endsWith('/admission/verify'))).toHaveLength(1);
      expect(await invoke(scenario.request, { ...reviewedChild, role: 'forged' })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(await invoke(scenario.request, { ...reviewedChild, inputDigest: 'A'.repeat(43) })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      if (scenario.child === SESSION_AGENT_READINESS_CHILDREN_V1.acquire) {
        expect(await invoke({ ...scenario.request, agentId: 'other-agent' })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      }
      if (scenario.child === SESSION_AGENT_READINESS_CHILDREN_V1.status && 'waitForTerminal' in scenario.request) {
        expect(await invoke({ ...scenario.request, waitForTerminal: !scenario.request.waitForTerminal })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      }
      if (scenario.method === RPC_METHODS.CAPABILITIES_DETECT) {
        expect(await invoke(buildMachineAgentsDetectRequest({ agents: [{ agentId: 'codex', title: 'Codex' }], refresh: true })))
          .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      }
      expect(effects).toHaveLength(1);
    } finally { installed.mockRestore(); post.mockRestore(); get.mockRestore(); await channel.close(); }
  });
});
