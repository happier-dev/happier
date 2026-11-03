import {
  API_TOKEN_FULL_GRANT_V1,
  computeExternalActionRequestEnvelopeDigestV1,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  parseExternalActionDaemonDispatchResultV1,
  type ExternalActionDaemonDispatchRequest,
  type ExternalActionDaemonDispatchRequestV1,
  createActionExecutor,
  ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import {
  ACTION_API_SERVER_ORIGIN,
  isSocketRpcActionApiServerOriginAuthorizationContext,
} from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';

import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { createProviderActionExecuteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { parseExternalActionDaemonDispatchResult } from '@happier-dev/protocol/actions/externalActionApi';

import {
  registerExternalActionRpcHandler,
} from './externalAction';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
} from '@/daemon/externalActions/executeExternalAction';

const SESSION_SPAWN_PENDING_RESULT = {
  type: 'pending',
  retryWithSameCreationKey: true,
  outcome: 'accepted',
} as const;
const installationIdentity = tweetnacl.sign.keyPair();
const currentInstallationBoundary = {
  resolveInstallationId: () => 'installation-1',
  verifyExecutionAuthorization: async () => true,
};

function authorizedDispatch<T extends ExternalActionDaemonDispatchRequest>(request: T): T & {
  executionAuthorization: NonNullable<ExternalActionDaemonDispatchRequest['executionAuthorization']>;
} {
  return {
    ...request,
    executionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1,
      token: `authorization-${request.actionId}`,
      binding: {
        serverIdentityId: 'server-reserved-rpc',
        accountId: request.principal.accountId,
        ...('credentialId' in request.principal ? {
          principalId: request.principal.principalId,
          credentialId: request.principal.credentialId,
          grant: request.principal.grant,
        } : { authentication: request.principal.authentication }),
        machineId: request.placement.machineId,
        custodianAccountId: request.principal.accountId,
        installationId: 'installation-1',
        actionId: request.actionId,
        requestId: request.envelope.requestId ?? 'server-generated-request-id',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        target: request.envelope.target ?? { kind: 'machine', machineId: request.placement.machineId },
      },
    }),
  };
}

function registerHandlerForTest() {
  const handlers = new Map<string, RpcHandler>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return { handlers, registrar };
}

function expectPreparedRelayResponse(raw: unknown, response: unknown): void {
  const parsed = parseExternalActionDaemonDispatchResultV1(raw);
  expect(parsed?.kind).toBe('response');
  if (!parsed || parsed.kind !== 'response') throw new Error('expected a prepared relay response');
  expect(parsed.prepared.response).toEqual(response);
  expect(parsed.prepared.body).toBe(JSON.stringify(response));
}

describe('registerExternalActionRpcHandler', () => {
  it.each(['plain', 'e2ee'] as const)('creates and reads recipient confirmation on a non-hub Machine over %s Action RPC', async mode => {
    const { handlers, registrar } = registerHandlerForTest();
    const peer = 'peer-machine';
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_peer', role: 'named', displayName: 'Gateway',
      displayNameMode: 'custom', source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
      deployment: { kind: 'managedLocal' }, gatewayPlacement: { kind: 'machine', machineId: 'hub-machine' },
      revision: 2, createdAt: 1, updatedAt: 1 });
    let catalog: ProviderConnectionsCatalogV1 = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] };
    let catalogRevision = 1;
    let approval: ApprovalRequestV2 | null = null;
    // Account-row and Artifact persistence plus Home proof verification are the
    // boundaries. RPC registration, ingress, policy, crypto and semantics stay real.
    const account = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 100,
      readCatalog: async () => ({ status: 'ready', catalog, revision: catalogRevision }), readDefinitions: async () => [],
      writeCatalog: async write => { expect(write.expectedRevision).toBe(catalogRevision);
        catalog = write.catalog; catalogRevision++; return { status: 'updated' }; },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      isApprovalExecutionOriginCurrent: async () => true,
      approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'peer-approval' }; },
      approvalsGet: async () => approval && structuredClone(approval),
      approvalsUpdate: async ({ request }) => {
        if (!approval) throw new Error('Missing approval');
        const next = ApprovalRequestV2Schema.parse(request);
        const transition = decideApprovalRequestTransition(approval, next);
        if (!transition.ok) return transition;
        approval = next; return { ok: true }; },
      providerActionExecute: createProviderActionExecuteV1({ assertCurrent() {}, account,
        rpc: async () => { throw new Error('Consent is Account-owned; hub RPC must not execute it'); },
        setDefault: async () => ({ status: 'applied' }) }),
    });
    const target = { kind: 'machine' as const, machineId: peer };
    const actionId = 'providers.models.experimental.confirm';
    const input = { action: 'confirmExperimental', machineId: peer, connectionId: connection.id, expectedConnectionRevision: 2,
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5.6-luna', compatibilityFingerprint: 'compatibility:v1:worker' };
    const authentication = { kind: 'account' as const, tokenEpoch: 1 };
    const binding = { serverIdentityId: 'srv_peer_confirmation', accountId: 'account-1', authentication,
      actionId, requestId: 'peer-confirm', target };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(24) };
    const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ binding, material, input, randomBytes: tweetnacl.randomBytes })
      : { v: 1 as const, requestId: binding.requestId, target, input };
    const admittedDispatch = authorizedDispatch({ actionId, envelope,
      principal: { accountId: 'account-1', authentication, authority: 'account_automation' },
      placement: { machineId: peer, target: { kind: 'machine', machineId: peer } },
    });
    const dispatch = { ...admittedDispatch, executionAuthorization: { ...admittedDispatch.executionAuthorization,
      binding: { ...admittedDispatch.executionAuthorization.binding, serverIdentityId: binding.serverIdentityId,
        accountEncryptionMode: mode } } };
    registerExternalActionRpcHandler(registrar, { machineId: peer, currentServerId: 'home-profile',
      resolveAccountId: async () => 'account-1', ...currentInstallationBoundary,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'fixture', encryption: null } }), executor,
    });
    const response = parseExternalActionDaemonDispatchResult(await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!(dispatch,
      { authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal }));
    expect(response?.kind).toBe('response');
    if (!response || response.kind !== 'response') throw new Error('Missing peer RPC response');
    const opened = envelope.v === 2 ? openExternalActionResponseV2({ envelope: response.prepared.response, binding, request: envelope, material })
      : response.prepared.response.v === 1 ? response.prepared.response.execution : null;
    expect(opened).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'peer-approval', actionId } });
    expect(catalog.experimentalBindingConfirmations).toHaveLength(0);
    const decided = await executor.execute('approval.request.decide', { artifactId: 'peer-approval', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home-profile' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({ connectionId: connection.id,
      modelId: input.modelId, agentTargetKey: input.agentTargetKey, compatibilityFingerprint: input.compatibilityFingerprint })]);
    expect(ApprovalRequestV2Schema.parse(approval).execution).toMatchObject({ ok: true,
      result: { status: 'success', action: 'confirmExperimental' } });
  });
  it('refuses a replaced installation during the final awaited Home check', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const sessionSpawnNew = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
    let installationId = 'installation-1';
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1', currentServerId: 'home-profile',
      resolveAccountId: async () => 'account-1', resolveInstallationId: () => installationId,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'daemon-token', encryption: null } }),
      executor: createActionExecutor({ ...createUnavailableActionTransportDeps(), sessionSpawnNew }),
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      // Home verification is the network boundary. Installation replacement
      // while it is awaited must still prevent the reached host effect.
      verifyExecutionAuthorization: async () => { installationId = 'replacement'; return true; },
    });
    const request = authorizedDispatch({
      actionId: 'session.spawn_new', envelope: { v: 1, requestId: 'installation-replaced',
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { creationKey: 'own-start', agentTarget: { kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, directory: { kind: 'managed' } } },
      principal: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' },
      placement: { machineId: 'machine-1', target: { kind: 'machine', machineId: 'machine-1' } },
    });
    const result = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(request, {
      authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal,
    });
    expectPreparedRelayResponse(result, { v: 1, actionId: 'session.spawn_new', requestId: 'installation-replaced',
      execution: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' } });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('refuses a foreign Account root without private requester custody even with a current Home proof', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1', currentServerId: 'home-profile',
      resolveAccountId: async () => 'alice', resolveInstallationId: () => 'alice-installation',
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon-token', encryption: null } }),
      executor: createActionExecutor(createUnavailableActionTransportDeps()),
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      verifyExecutionAuthorization: async () => true,
    });
    const request = authorizedDispatch({
      actionId: 'session.spawn_new', envelope: { v: 1, requestId: 'bob-start',
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { creationKey: 'shared-start', agentTarget: { kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, directory: { kind: 'managed' } } },
      principal: { accountId: 'bob', principalId: 'bob', credentialId: 'bob-pat',
        grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' },
      placement: { machineId: 'machine-1', target: { kind: 'machine', machineId: 'machine-1' } },
    });
    const dispatch = { ...request, executionAuthorization: { ...request.executionAuthorization,
      binding: { ...request.executionAuthorization.binding, custodianAccountId: 'alice', installationId: 'alice-installation' } } };
    const result = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(dispatch, {
      authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal,
    });
    expectPreparedRelayResponse(result, { v: 1, actionId: 'session.spawn_new', requestId: 'bob-start',
      execution: { ok: false, errorCode: 'target_not_local', error: 'target_not_local' } });
    const wrongInstallation = { ...dispatch, executionAuthorization: { ...dispatch.executionAuthorization,
      binding: { ...dispatch.executionAuthorization.binding, installationId: 'replacement' } } };
    const replaced = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(wrongInstallation, {
      authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal,
    });
    expectPreparedRelayResponse(replaced, { v: 1, actionId: 'session.spawn_new', requestId: 'bob-start',
      execution: { ok: false, errorCode: 'target_not_local', error: 'target_not_local' } });
  });

  it('admits only the server-stamped exact-machine dispatch into the canonical ingress', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => (
      { kind: 'machine', machineId: 'machine-1' }
    ));
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => (
      { ok: true, result: SESSION_SPAWN_PENDING_RESULT }
    ));
    const executor = { execute } satisfies ExternalActionExecutor;
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      ...currentInstallationBoundary,
      resolveTarget,
      executor,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
    });
    const handler = handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1);
    expect(handler).toBeDefined();

    const signal = new AbortController().signal;
    expect(isSocketRpcActionApiServerOriginAuthorizationContext(ACTION_API_SERVER_ORIGIN)).toBe(true);
    const request: ExternalActionDaemonDispatchRequestV1 = {
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        requestId: 'request-1',
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { sessionId: 'session-1' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };
    expectPreparedRelayResponse(await handler?.(authorizedDispatch(request), {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal,
    }), {
      v: 1,
      actionId: 'session.spawn_new',
      requestId: 'request-1',
      execution: { ok: true, result: SESSION_SPAWN_PENDING_RESULT },
    });
    expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      currentMachineId: 'machine-1',
      signal,
    }));
    expect(executor.execute).toHaveBeenCalledWith('session.spawn_new', { sessionId: 'session-1' }, expect.objectContaining({
      surface: 'api',
      authority: 'account_automation',
      serverId: 'server-reserved-rpc',
      signal,
    }));
  });

  it('preserves a verified Session envelope target through the reserved server-origin ingress', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => (
      { ok: true, result: { invoked: true } }
    ));
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      ...currentInstallationBoundary,
      resolveTarget,
      executor: { execute },
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
    });
    const signal = new AbortController().signal;
    const request: ExternalActionDaemonDispatchRequestV1 = {
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: { sessionId: 'nested-plugin-payload' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };

    expectPreparedRelayResponse(await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(authorizedDispatch(request), {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal,
    }), {
      v: 1,
      actionId: 'action.invoke',
      execution: { ok: true, result: { invoked: true } },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'action.invoke',
      actionInput: request.envelope.input,
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-1',
      signal,
    });
    expect(execute).toHaveBeenCalledWith(
      'action.invoke',
      request.envelope.input,
      expect.objectContaining({
        surface: 'api',
        authority: 'account_automation',
        defaultSessionId: 'session-1',
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        signal,
      }),
    );
  });

  it.each([
    undefined,
    { kind: 'action.api.serverOrigin', forged: true },
    { kind: 'session.serverStart.serverOrigin' },
  ])('rejects a missing or forged server-origin stamp', async (authorization) => {
    const { handlers, registrar } = registerHandlerForTest();
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    const executor = { execute } satisfies ExternalActionExecutor;
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      ...currentInstallationBoundary,
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
    });
    const request: ExternalActionDaemonDispatchRequestV1 = {
      actionId: 'session.spawn_new',
      envelope: { v: 1, input: { sessionId: 'session-1' } },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };
    const response = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(request, {
      signal: new AbortController().signal,
      ...(authorization ? {
        // This negative fixture deliberately crosses the typed registrar
        // boundary so the receiver's runtime authorization check is exercised.
        authorization: authorization as unknown as NonNullable<RpcHandlerContext['authorization']>,
      } : {}),
    });

    expect(response).toEqual({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('preserves an opaque server action id until canonical external ingress rejects it', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    const executor = { execute } satisfies ExternalActionExecutor;
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      ...currentInstallationBoundary,
      resolveTarget,
      executor,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
    });

    await expect(handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(authorizedDispatch({
      actionId: 'not-a-public-action',
      envelope: { v: 1, input: {} },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    }), {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_action',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('never turns a protected pre-open placement rejection into a V1 Action envelope', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      ...currentInstallationBoundary,
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor: { execute },
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
    });
    const request: ExternalActionDaemonDispatchRequest = {
      actionId: 'session.message.send',
      envelope: {
        v: 2,
        requestId: 'rpc-wrong-placement',
        target: { kind: 'machine', machineId: 'machine-2' },
        payload: { t: 'encrypted', c: 'opaque' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-2',
        target: { kind: 'machine', machineId: 'machine-2' },
      },
    };

    await expect(handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(request, {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'target_not_local',
      requestId: 'rpc-wrong-placement',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
