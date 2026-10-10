import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import {
  API_TOKEN_FULL_GRANT_V1,
  NO_TEAM_CAPABILITIES_V1,
  computeExternalActionRequestEnvelopeDigestV1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  normalizeActionsSettingsV1,
  SessionAwarenessListResultV1Schema,
  wrapApiTokenEncryptionAccessV1,
  verifyExternalActionMachineRequestV1,
} from '@happier-dev/protocol';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { connect } from '@happier-dev/sdk';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  openExternalActionResponseV2,
  parseExternalActionDaemonDispatchResult,
  sealExternalActionRequestV2,
} from '@happier-dev/protocol/actions';
import { ACTION_API_SERVER_ORIGIN, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import type { RpcHandlerMap } from '@/api/rpc/types';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { mintExternalActionExecutionAuthorization } from '@/api/externalActionExecutionAuthorization';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { registerDaemonExternalActionRoute } from './registerDaemonExternalActionRoute';

const credentialId = '00000000-0000-4000-8000-000000000001';
const principal = { accountId: 'account-1', principalId: 'principal-1', credentialId,
  grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' as const };
const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
const target = { kind: 'machine' as const, machineId: 'machine-1' };
const installationIdentity = tweetnacl.sign.keyPair();
const binding = { serverIdentityId: 'srv_test', accountId: principal.accountId, credentialId,
  actionId: 'action.spec.get', requestId: 'private-read', target };

function executionAuthorization(actionId: string, envelope: Parameters<typeof computeExternalActionRequestEnvelopeDigestV1>[0], token = 'home-authorized') {
  return {
    v: 1 as const,
    token,
    binding: {
      serverIdentityId: binding.serverIdentityId,
      accountId: principal.accountId,
      principalId: principal.principalId,
      credentialId,
      grant: principal.grant,
      machineId: target.machineId,
      custodianAccountId: principal.accountId,
      installationId: 'machine-installation-1',
      actionId,
      requestId: envelope.requestId ?? `generated-${actionId}`,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      target: envelope.target ?? target,
    },
  };
}

function owner() {
  return {
    currentServerId: binding.serverIdentityId,
    resolveInstallationId: () => 'machine-installation-1',
    verifyExecutionAuthorization: async () => true,
    externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
    resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
    // The OS/Machine correspondence is a boundary; all Action logic stays real.
    resolveTarget: async () => target,
    executor: createCliActionExecutorHarness({ token: 'test-boundary-token', sessionId: '',
      mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
    }).executor,
    resolvePatExecutor: () => createCliActionExecutorHarness({ token: 'test-boundary-token', sessionId: '',
      mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
    }).executor,
  };
}

describe('private external Action origins with the real CLI executor', () => {
  it.each([1, 2] as const)('refuses a V%s relay PAT request without authenticated invocation authority before contacting Home', async (version) => {
    const home = fastify();
    const homeUrl = 'http://unproven-relay-home.test';
    const restore = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
    const receivedAuthorizations: Array<string | undefined> = [];
    home.post('/v1/teams/archive', async (request, reply) => {
      receivedAuthorizations.push(request.headers.authorization);
      return reply.code(403).send({ error: 'team_authentication_required' });
    });
    const executor = createCliActionExecutorHarness({
      token: 'qualified-daemon-bearer', sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({
        v: 1, actions: {}, approvalWaivedSurfaces: { 'teams.archive': ['api'] },
      }) },
    }, createAccountServerActionDeps({
      token: 'qualified-daemon-bearer', serverId: binding.serverIdentityId, serverHttpBaseUrl: homeUrl,
    })).executor;
    const handlers: RpcHandlerMap = new Map();
    registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      ...owner(), executor, machineId: target.machineId, resolveAccountId: async () => principal.accountId,
    });
    const input = { v: 1 as const, teamId: 'team-1' };
    const requestBinding = { ...binding, actionId: 'teams.archive', requestId: `unproven-relay-${version}` };
    const envelope = version === 1
      ? { v: 1 as const, requestId: requestBinding.requestId, target, input }
      : sealExternalActionRequestV2({ binding: requestBinding, material, input,
        randomBytes: (length) => new Uint8Array(length).fill(4) });
    try {
      await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!({
        actionId: requestBinding.actionId, envelope, principal,
        placement: { machineId: target.machineId, target },
      }, { signal: new AbortController().signal, authorization: ACTION_API_SERVER_ORIGIN });
      expect(receivedAuthorizations).toEqual([]);
    } finally {
      restore();
      await home.close();
    }
  });

  it.each([
    {
      name: 'qualified PAT behind an unqualified daemon succeeds',
      daemonBearer: 'daemon-unqualified',
      patSecret: 'A',
      qualifiedBearer: `hap_v1_${credentialId}_${'A'.repeat(43)}`,
      expected: { ok: true, result: expect.objectContaining({ id: 'team-1' }) },
    },
    {
      name: 'unqualified PAT behind a qualified daemon fails',
      daemonBearer: 'daemon-qualified',
      patSecret: 'B',
      qualifiedBearer: 'daemon-qualified',
      expected: {
        ok: false,
        errorCode: 'team_authentication_required',
        error: 'team_authentication_required',
      },
    },
  ])('RED: preserves credential-specific Team qualification when a $name', async ({
    daemonBearer,
    patSecret,
    qualifiedBearer,
    expected,
  }) => {
    const home = fastify();
    const ingress = fastify();
    const homeUrl = 'http://team-qualification-home.test';
    const restore = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
    const patBearer = `hap_v1_${credentialId}_${patSecret.repeat(43)}`;
    const receivedAuthorizations: Array<string | undefined> = [];
    const receivedExecutionAuthorizations: Array<string | undefined> = [];
    const team = {
      id: 'team-1',
      name: 'Credential evidence',
      description: null,
      logo: null,
      archivedAt: null,
      recovery: null,
      policy: {
        v: 1,
        sessionCreationPolicy: 'private_default',
        externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership',
        admissionMode: 'invite_only',
        authenticationPolicy: null,
      },
      viewerRole: 'owner',
      capabilities: NO_TEAM_CAPABILITIES_V1,
      admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
      counts: null,
    } as const;

    // Home HTTP is the only mocked process boundary. It intentionally does not
    // reproduce Team qualification internals: the stable accepted/denied result
    // depends solely on the bearer the real daemon adapter actually sends.
    home.post('/v1/actions/teams.policy.set/execution-authorization', async (request) => {
      const body = request.body as { envelope: Parameters<typeof executionAuthorization>[1] };
      return executionAuthorization(
        'teams.policy.set',
        body.envelope,
        request.headers.authorization === `Bearer ${qualifiedBearer}`
          ? 'qualified-invocation'
          : 'unqualified-invocation',
      );
    });
    home.post('/v1/teams/policy/set', async (request, reply) => {
      receivedAuthorizations.push(request.headers.authorization);
      receivedExecutionAuthorizations.push(
        request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] as string | undefined,
      );
      return request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'qualified-invocation'
        ? team
        : reply.code(403).send({ error: 'team_authentication_required' });
    });
    const createExecutor = (token: string) => createCliActionExecutorHarness({
      token,
      sessionId: '',
      mode: 'plain',
      ctx: null,
      actionsSettingsProvider: {
        getActionsSettings: () => normalizeActionsSettingsV1({
          v: 1,
          actions: {},
          approvalWaivedSurfaces: { 'teams.policy.set': ['api'] },
        }),
      },
    }, createAccountServerActionDeps({
      token,
      serverId: binding.serverIdentityId,
      serverHttpBaseUrl: homeUrl,
      serverIdentityId: binding.serverIdentityId,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      externalActionMachineInstallationId: 'machine-installation-1',
    })).executor;
    const executor = createExecutor(daemonBearer);
    registerDaemonExternalActionRoute(ingress, {
      ...owner(),
      executor,
      currentMachineId: target.machineId,
      mintExecutionAuthorization: async ({ actionId, envelope, machineId, pat, signal }) =>
        await mintExternalActionExecutionAuthorization({
          actionId,
          envelope,
          machineId,
          pat,
          serverHttpBaseUrl: homeUrl,
          ...(signal ? { signal } : {}),
        }),
      verifyPat: async (received) => {
        expect(received).toBe(patBearer);
        return { ...principal, ok: true, expiresAt: null };
      },
    });

    try {
      const response = await ingress.inject({
        method: 'POST',
        url: '/v1/actions/teams.policy.set',
        headers: { authorization: `Bearer ${patBearer}` },
        payload: {
          v: 1,
          requestId: `team-qualification-${patSecret}`,
          target,
          input: {
            v: 1,
            teamId: team.id,
            previousAuthenticationPolicy: {
              v: 1,
              mode: 'restricted',
              accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
            authenticationPolicy: { v: 1, mode: 'inherit' },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(receivedAuthorizations).toEqual([undefined]);
      expect(receivedExecutionAuthorizations).toEqual([
        qualifiedBearer === patBearer ? 'qualified-invocation' : 'unqualified-invocation',
      ]);
      expect(response.json().execution).toMatchObject(expected);
    } finally {
      restore();
      await ingress.close();
      await home.close();
    }
  });

  it('round trips SDK later-page awareness through daemon admission and the canonical Home list owner', async () => {
    const home = fastify();
    const ingress = fastify();
    const homeUrl = 'http://session-list-home.test';
    const restore = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
    resetInMemoryAccountSettingsContextForTests();
    const sentinel = 'PRIVATE_LIST_RESULT_SENTINEL';
    const contentKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const listMaterial = { type: 'dataKey' as const, machineKey: contentKey };
    const wrappingSecret = new Uint8Array(32).fill(7);
    const context = { serverIdentityId: binding.serverIdentityId, accountId: principal.accountId,
      tokenId: credentialId, contentPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' };
    const bearer = `hap_v1_${credentialId}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
    const token = formatAccountApiTokenCredentialV1({ bearer,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url'),
      serverIdentityId: context.serverIdentityId, accountId: context.accountId,
      contentPublicKey: context.contentPublicKey });
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: contentKey, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const baseQuery = { v: 1 as const, storage: 'active' as const,
      includeInactive: false, scope: 'assigned_to_me' as const, attention: 'needs_my_attention' as const,
      includeAttention: true, audiences: [{ kind: 'team' as const, teamId: 'team-1' }], tagIds: ['tag-1'],
      limit: 17 };
    const ordinaryInput = { view: 'awareness' as const, query: {
      ...baseQuery, cursor: 'cursor_v1_ordinary_private_later',
    } };
    const attentionInput = { view: 'awareness' as const, query: {
      ...baseQuery, attentionCursor: 'cursor_v1_attention_private_later',
    } };
    const page = { sessions: [{ ...createSessionRecordFixture({ id: 'session-private', encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: sentinel } }), active: false,
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 }),
      effectiveAccess: { v: 1 as const, level: 'owner' as const,
        sources: [{ kind: 'owner' as const }],
        capabilities: {
          readTranscript: true,
          submitAgentInput: true,
          editSessionRecords: true,
          approveRuntimePermissions: true,
          manageAccess: true,
          managePermissionDelegation: true,
          managePublicLink: true,
          archiveSession: true,
          renameSession: true,
          assignResponsibility: true,
          stopSession: true,
          deleteSession: true,
        } },
      viewer: { readState: { state: 'not_started' as const },
        relevance: { relevant: true, reasons: ['owned_by_me' as const] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' as const },
        follow: { follows: false, notificationLevel: null },
        notification: { level: 'none' as const, source: 'none' as const } },
      responsibleAccountId: null,
      responsibleAccount: null }],
      nextCursor: 'cursor_v1_ordinary_next', hasNext: true,
      attentionNextCursor: 'cursor_v1_attention_next', attentionHasNext: true };
    let domainRequests = 0;
    let accountSettingsRequests = 0;
    let authorizedRequestId = '';
    const recordUnexpectedAccountSettingsRead = () => {
      accountSettingsRequests += 1;
      return { settings: null, settingsVersion: 0 };
    };
    home.get('/v1/account/settings', recordUnexpectedAccountSettingsRead);
    home.get('/v2/account/settings', recordUnexpectedAccountSettingsRead);
    home.post('/v2/sessions/query', async (request) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('session-list-authorization');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: 'session-list-authorization',
        effectActionId: 'session.list',
        target,
        installationId: 'machine-installation-1',
        requestId: authorizedRequestId,
        method: 'POST',
        path: '/v2/sessions/query',
        body: request.body,
        publicKey: installationIdentity.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''),
      })).toBe(true);
      expect([ordinaryInput.query, attentionInput.query]).toContainEqual(request.body);
      domainRequests += 1;
      return page;
    });
    home.get('/v1/account/encryption/currentness', async (request) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('session-list-authorization');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: 'session-list-authorization',
        effectActionId: 'session.list',
        target,
        installationId: 'machine-installation-1',
        requestId: authorizedRequestId,
        method: 'GET',
        path: '/v1/account/encryption/currentness',
        publicKey: installationIdentity.publicKey,
        signature: String(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''),
      })).toBe(true);
      return createAccountEncryptionCurrentnessFixture();
    });
    const createListExecutor = (serverIdentityId: string) => createCliActionExecutorFromCredentials({
      credentials: { token: 'runtime-list-token', encryption: null },
      serverId: 'home-profile-routing-id',
      serverIdentityId,
      serverApiUrl: homeUrl,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      externalActionMachineInstallationId: 'machine-installation-1',
      pluginActionExecutionOwner: 'current_process',
    });
    let activeExecutor = createListExecutor(binding.serverIdentityId);
    const executor = {
      execute: (...args: Parameters<typeof activeExecutor.execute>) => activeExecutor.execute(...args),
      prepare: (...args: Parameters<typeof activeExecutor.prepare>) => activeExecutor.prepare(...args),
    };
    const carrier: string[] = [];
    let fault: 'none' | 'tampered' | 'unsupported' = 'none';
    ingress.addHook('preHandler', async (request, reply) => {
      if (!request.url.startsWith('/v1/actions/')) return;
      carrier.push(JSON.stringify(request.body));
      if (fault === 'unsupported') return reply.code(409).send({ error: 'encrypted_action_unsupported' });
    });
    ingress.addHook('onSend', async (request, _reply, payload) => {
      if (!request.url.startsWith('/v1/actions/')) return payload;
      carrier.push(String(payload));
      if (fault === 'tampered') {
        const envelope = JSON.parse(String(payload));
        envelope.requestId = 'wrong-request';
        return JSON.stringify(envelope);
      }
      return payload;
    });
    registerDaemonExternalActionRoute(ingress, { ...owner(), executor,
      currentServerId: 'home-profile-routing-id',
      resolvePatExecutor: () => executor, currentMachineId: target.machineId,
      mintExecutionAuthorization: async ({ actionId, envelope }) => {
        const authorization = executionAuthorization(actionId, envelope, 'session-list-authorization');
        authorizedRequestId = authorization.binding.requestId;
        return { ok: true, authorization };
      },
      resolveEncryption: async () => ({ serverIdentityId: context.serverIdentityId, material: listMaterial }),
      verifyPat: async (received) => {
        expect(received).toBe(bearer);
        return { ...principal, ok: true, expiresAt: null };
      },
      readEncryptionAccess: async () => ({ statusCode: 200,
        body: { v: 1, accountId: context.accountId, tokenId: credentialId, encryptionAccess } }),
    });
    const clients: ReturnType<typeof connect>[] = [];
    try {
      const endpoint = await ingress.listen({ host: '127.0.0.1', port: 0 });
      const encrypted = connect({ endpoint, token });
      clients.push(encrypted);
      const ordinaryResult = SessionAwarenessListResultV1Schema.parse(
        await encrypted.machine(target.machineId).actions.session.list(ordinaryInput),
      );
      const attentionResult = SessionAwarenessListResultV1Schema.parse(
        await encrypted.machine(target.machineId).actions.session.list(attentionInput),
      );
      for (const result of [ordinaryResult, attentionResult]) {
        expect(result).toMatchObject({ view: 'awareness', projectionVersion: 1,
          sessions: [{ sessionId: 'session-private', title: sentinel, encryption: 'plain' }],
          nextCursor: page.nextCursor, hasNext: true,
          attentionNextCursor: page.attentionNextCursor, attentionHasNext: true });
        expect(Object.keys(result).sort()).toEqual([
          'attentionHasNext', 'attentionNextCursor', 'hasNext', 'nextCursor',
          'projectionVersion', 'sessions', 'view',
        ]);
      }
      const privateCarrierSentinels = [
        sentinel,
        ordinaryInput.query.cursor,
        attentionInput.query.attentionCursor,
        page.nextCursor,
        page.attentionNextCursor,
        baseQuery.audiences[0].teamId,
        baseQuery.tagIds[0],
      ];
      for (const privateSentinel of privateCarrierSentinels) {
        expect(carrier.join('')).not.toContain(privateSentinel);
      }
      expect(domainRequests).toBe(2);
      expect(accountSettingsRequests).toBe(0);
      const raw = connect({ endpoint, token: bearer });
      clients.push(raw);
      await expect(raw.machine(target.machineId).actions.session.list(attentionInput)).resolves.toEqual(attentionResult);
      expect(domainRequests).toBe(3);
      activeExecutor = createListExecutor('srv_different_cryptographic_home');
      await expect(raw.machine(target.machineId).actions.session.list(attentionInput)).rejects.toThrow();
      expect(domainRequests).toBe(3);
      activeExecutor = createListExecutor(binding.serverIdentityId);
      const diagnostics: string[] = [];
      for (const failure of ['tampered', 'unsupported'] as const) {
        carrier.length = 0;
        fault = failure;
        const error = await encrypted.machine(target.machineId).actions.session.list(attentionInput)
          .then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        diagnostics.push(JSON.stringify({
          name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
          ...(error && typeof error === 'object' && 'code' in error
            ? { code: (error as { code?: unknown }).code }
            : {}),
        }));
        const requests = carrier.filter((body) => JSON.parse(body).target);
        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0]!)).toMatchObject({ v: 2 });
        for (const privateSentinel of privateCarrierSentinels) {
          expect(`${carrier.join('')}\n${diagnostics.join('\n')}`).not.toContain(privateSentinel);
        }
      }
      expect(domainRequests).toBe(4);
      expect(accountSettingsRequests).toBe(0);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      restore();
      vi.unstubAllEnvs();
      resetInMemoryAccountSettingsContextForTests();
      await ingress.close();
      await home.close();
    }
  });

  it.each(['http', 'rpc'] as const)('protects Pool conflicts through %s and the bound Account HTTP adapter', async (origin) => {
    const home = fastify();
    const ingress = fastify();
    const restore = installAxiosFastifyAdapter({ app: home, origin: 'http://pool-home.test' });
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const sentinel = 'PRIVATE_POOL_CONFLICT_SENTINEL';
    const current = { pool: { id: poolId, name: sentinel, description: null, revision: 2,
      createdAt: 1, updatedAt: 2, members: [] },
      availability: { state: 'known', connectedCount: 0, enabledCount: 0 } };
    let domainRequests = 0;
    // Home HTTP is the system boundary; the transport codec, Action policy and family adapter are real.
    home.post('/v1/machines/pools/update', async (request, reply) => {
      domainRequests += 1;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('pool-authorization');
      expect(typeof request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBe('string');
      expect(request.body).toEqual({ poolId, expectedRevision: 1, name: 'Requested private name', members: [] });
      return reply.code(409).send({ code: 'pool_changed', current });
    });
    const host = { ...owner(), executor: createCliActionExecutorHarness({
      token: 'alice-runtime-token', sessionId: '', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
    }, createAccountServerActionDeps({
      token: 'alice-runtime-token',
      serverId: binding.serverIdentityId,
      serverHttpBaseUrl: 'http://pool-home.test',
      serverIdentityId: binding.serverIdentityId,
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      externalActionMachineInstallationId: 'machine-installation-1',
    })).executor };
    const poolBinding = { ...binding, actionId: 'machines.pools.update', requestId: 'pool-conflict' };
    const request = sealExternalActionRequestV2({ binding: poolBinding, material, randomBytes: (length) => new Uint8Array(length).fill(4),
      input: { poolId, expectedRevision: 1, name: 'Requested private name', members: [] } });
    const poolAuthorization = executionAuthorization(poolBinding.actionId, request, 'pool-authorization');
    try {
      const envelope = await runWithServerHttpBaseUrl('http://unrelated-home.test', async () => {
        if (origin === 'http') {
          registerDaemonExternalActionRoute(ingress, { ...host,
            resolvePatExecutor: () => host.executor, currentMachineId: target.machineId,
            mintExecutionAuthorization: async () => ({ ok: true, authorization: poolAuthorization }),
            verifyPat: async () => ({ ...principal, ok: true, expiresAt: null }) });
          const response = await ingress.inject({ method: 'POST', url: '/v1/actions/machines.pools.update', payload: request,
            headers: { authorization: `Bearer hap_v1_${credentialId}_${'A'.repeat(43)}` } });
          expect(response.statusCode).toBe(200);
          return response.json();
        }
        const handlers: RpcHandlerMap = new Map();
        registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
          ...host, machineId: target.machineId, resolveAccountId: async () => principal.accountId,
        });
        const handle = handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!;
        const rejected = parseExternalActionDaemonDispatchResult(await handle({
          actionId: poolBinding.actionId, envelope: request, principal: { ...principal, accountId: 'bob' },
          placement: { machineId: target.machineId, target },
          executionAuthorization: poolAuthorization,
        }, { signal: new AbortController().signal, authorization: ACTION_API_SERVER_ORIGIN }));
        expect(rejected).toEqual({
          kind: 'invalid_request',
          errorCode: 'target_not_local',
          requestId: 'pool-conflict',
        });
        expect(domainRequests).toBe(0);
        const result = parseExternalActionDaemonDispatchResult(await handle({
          actionId: poolBinding.actionId, envelope: request, principal, placement: { machineId: target.machineId, target },
          executionAuthorization: poolAuthorization,
        }, { signal: new AbortController().signal, authorization: ACTION_API_SERVER_ORIGIN }));
        if (result?.kind !== 'response') throw new Error('Expected protected Pool response');
        return result.prepared.response;
      });
      expect(JSON.stringify(envelope)).not.toContain(sentinel);
      expect(JSON.stringify(envelope)).not.toContain('pool_changed');
      expect(openExternalActionResponseV2({ envelope, binding: poolBinding, request, material })).toMatchObject({
        ok: false, errorCode: 'pool_changed', details: { code: 'pool_changed', current },
      });
      expect(domainRequests).toBe(1);
    } finally { restore(); await ingress.close(); await home.close(); }
  });

  it('admits the strict PAT-self metadata operation without passing credentials into Actions', async () => {
    const app = fastify();
    let reads = 0;
    registerDaemonExternalActionRoute(app, { ...owner(), currentMachineId: target.machineId,
      verifyPat: async () => ({ ...principal, ok: true, expiresAt: null }),
      readEncryptionAccess: async (token) => {
        expect(token).toBe(`hap_v1_${credentialId}_${'A'.repeat(43)}`);
        reads += 1;
        return { statusCode: 409, body: { error: 'api_token_encryption_stale' } };
      },
    });
    try {
      const headers = { authorization: `Bearer hap_v1_${credentialId}_${'A'.repeat(43)}` };
      const response = await app.inject({ method: 'POST', url: '/v1/auth/api-tokens/encryption-access', payload: {}, headers });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'api_token_encryption_stale' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect((await app.inject({ method: 'POST', url: '/v1/auth/api-tokens/encryption-access', payload: { token: 'caller-selected' }, headers })).statusCode).toBe(400);
      expect(reads).toBe(1);
    } finally { await app.close(); }
  });

  it('opens and seals direct HTTP discovery through canonical Action admission', async () => {
    const app = fastify();
    registerDaemonExternalActionRoute(app, { ...owner(), currentMachineId: target.machineId,
      verifyPat: async () => ({ ...principal, ok: true, expiresAt: null }) });
    const request = sealExternalActionRequestV2({ binding, material,
      input: { id: 'session.message.send' }, randomBytes: (length) => new Uint8Array(length).fill(2) });
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/actions/action.spec.get', payload: request,
        headers: { authorization: `Bearer hap_v1_${credentialId}_${'A'.repeat(43)}` } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('session.message.send');
      expect(openExternalActionResponseV2({ envelope: response.json(), binding, request, material }))
        .toMatchObject({ ok: true });
    } finally { await app.close(); }
  });

  it('uses the same sealed execution behind the reserved server-origin RPC', async () => {
    const handlers: RpcHandlerMap = new Map();
    registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
      ...owner(), machineId: target.machineId, resolveAccountId: async () => principal.accountId,
    });
    const request = sealExternalActionRequestV2({ binding, material,
      input: { id: 'session.message.send' }, randomBytes: (length) => new Uint8Array(length).fill(3) });
    const handle = handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!;
    const dispatch = {
      actionId: binding.actionId,
      envelope: request,
      principal,
      placement: { machineId: target.machineId, target },
      executionAuthorization: executionAuthorization(binding.actionId, request),
    };
    const result = parseExternalActionDaemonDispatchResult(await handle(dispatch, {
      signal: new AbortController().signal, authorization: ACTION_API_SERVER_ORIGIN,
    }));
    expect(result?.kind).toBe('response');
    if (result?.kind !== 'response') throw new Error('Expected protected response');
    expect(result.prepared.body).not.toContain('session.message.send');
    expect(openExternalActionResponseV2({ envelope: result.prepared.response, binding, request, material }))
      .toMatchObject({ ok: true });
    await expect(handle(dispatch)).resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
});
