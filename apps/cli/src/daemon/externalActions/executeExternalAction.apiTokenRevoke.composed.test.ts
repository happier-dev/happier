import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, decodeExternalActionResolvedTargetV1,
  verifyExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
} from '@happier-dev/protocol/auth/accountApiTokens';
import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountSessions';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reloadConfiguration } from '@/configuration';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

const control = vi.hoisted(() => ({ input: null as Parameters<typeof startDaemonControlServer>[0] | null }));
vi.mock('@/daemon/controlServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    control.input = input;
    return { port: 43129, stop: async () => {} };
  },
}));

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary();
  withdrawActiveProjectAccountRowsSnapshot(); resetServerFeaturesClientForTests(); });

const tokenId = 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d';
it.each([
  { actionId: 'account.apiTokens.list', path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, input: {}, output: { tokens: [] }, summary: undefined },
  { actionId: 'account.apiTokens.revoke', path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, input: { tokenId }, output: { revoked: true }, summary: undefined },
  { actionId: 'account.apiTokens.revokeAll', path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, input: {}, output: { revokedCount: 1 }, summary: undefined },
  { actionId: 'account.sessions.signOutEverywhere', path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
    input: {}, output: { status: 'signed_out' }, summary: /API tokens remain active/ },
  { actionId: 'account.sessions.signOutEverywhere', path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
    input: { revokeApiTokens: true }, output: { status: 'signed_out' }, summary: /API tokens will be revoked/ },
] as const)('applies the default approval policy for MCP $actionId $input', async ({ actionId, path, input, output, summary }) => {
  const h = await createHarness(actionId, 'default', false, 'srv_n2', undefined, false, false,
    { authentication: 'account', machineCustodianAccountId: 'account', machineRole: 'manage' });
  const request = vi.mocked(axios.request).getMockImplementation();
  if (!request) throw new Error('Missing installed Home transport');
  let applied = false;
  // HTTP is the genuine effect boundary; approval policy/replay and Account
  // dispatch remain the installed production owners.
  vi.mocked(axios.request).mockImplementation(async config => {
    if (new URL(String(config.url)).pathname !== path) return request(config);
    expect(config.data).toEqual(input);
    applied = true;
    return { status: 200, data: output };
  });
  const { mcp } = runWithServerHttpBaseUrl('https://home.example.test', () => createExternalMcpServer({
    credentials: { token: h.installedToken, encryption: null, credentialProvenance: 'stored_session' },
    machineId: h.ref.machineId,
    serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: h.ref.serverId } } }) },
  }));
  const client = new Client({ name: 'token-revoke-agent', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    expect(getActionSpec('account.apiTokens.create').surfaces).toMatchObject({ agent: false, mcp: false });
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId, input,
    } }));
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    if (actionId === 'account.apiTokens.list') {
      expect(h.hasApproval()).toBe(false);
      expect(applied, JSON.stringify(result)).toBe(true);
      return;
    }
    expect(h.hasApproval(), JSON.stringify(result)).toBe(true);
    expect(applied).toBe(false);
    expect(await h.approval()).toMatchObject({ actionId, status: 'open',
      ...(summary ? { summary: expect.stringMatching(summary) } : {}),
    });
    const decided = await h.decideFromCli();
    expect(decided).toMatchObject({ ok: true });
    expect(applied, JSON.stringify({ decided, approval: await h.approval(), paths: h.networkPaths })).toBe(true);
    // Creation remains the explicit owner-approved parity exception: its new
    // bearer must never become an Agent result, even behind a review card.
    const create = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'account.apiTokens.create', input: { tokenId, label: 'Must stay human-only' },
    } }));
    expect(create.isError).toBe(true);
  } finally { await client.close(); await mcp.close(); await h.close(); }
});

it('uses the guest Account for Session security Actions and refuses a Session shared by another person', async () => {
  const actions = [
    { actionId: 'account.apiTokens.revokeAll', path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
      input: {}, output: { revokedCount: 1 } },
    { actionId: 'account.sessions.signOutEverywhere', path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
      input: { revokeApiTokens: true }, output: { status: 'signed_out' } },
  ] as const;
  const tokenFor = (sub: string) => `e30.${Buffer.from(JSON.stringify({
    sub, tokenEpoch: 0, provenance: { v: 1, kind: 'terminal', authority: 'account_automation' },
  })).toString('base64url')}.signature`;
  const home = `srv_${'a'.repeat(32)}`;
  const guest = { token: tokenFor('requester'), encryption: null };
  const custodian = { token: tokenFor('custodian'), encryption: null };
  let settings = normalizeActionsSettingsV1();
  // The MCP tests above cover default approval. This test exercises the
  // installed Session path and the Account chosen for the actual effect.
  for (const { actionId } of actions) {
    settings = setActionApprovalOverride({ settings, actionId, surface: 'agent', approvalRequired: false });
  }
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== 'https://session-home.test') return fetch(input, init);
    if (url.pathname !== '/v1/features' && url.pathname !== '/v1/features/authenticated') {
      throw new Error(`Unexpected Session Home fetch ${url.pathname}`);
    }
    return Response.json({ features: { workflows: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: home } } });
  });
  onTestFinished(() => { control.input = null; });
  const h = await createInstalledProjectAgentDaemonFixture(() => control.input, undefined, true, undefined, undefined, {
    credentials: custodian, accountActionCredentials: guest, requesterCredentials: guest,
    homeServerIdentityId: home, machineAccess: { custodianAccountId: 'custodian', role: 'use' },
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }),
    accountSettings: { actionsSettingsV1: settings },
  });

  const serverId = h.f.bootstrap.attribution.serverId;
  await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId, servers: { [serverId]: {
    id: serverId, name: 'Session Home', serverUrl: 'https://session-home.test', webappUrl: 'https://session-home.test',
    createdAt: 0, updatedAt: 0, homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: {
      v: 1, homeServerIdentityId: home, canonicalServerUrl: 'https://session-home.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://session-home.test' }],
    },
  } }, machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' } });
  reloadConfiguration();

  const post = vi.mocked(axios.post).getMockImplementation();
  if (!post) throw new Error('Missing Home admission transport');
  const admitted = new Map<string, ExternalActionExecutionAuthorizationV1>();
  vi.spyOn(axios, 'post').mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    const effect = actions.find(({ actionId }) => path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId));
    if (!effect) {
      if (actions.some(({ actionId }) => path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId))) {
        return { status: 200, data: { ok: true } };
      }
      return post(...args);
    }
    expect(args[2]?.headers?.Authorization === `Bearer ${guest.token}`).toBe(true);
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
    const { sessionActionOrigin: origin, sessionActionSource: source, installationProof } = request;
    if (!origin || !source || !installationProof) throw new Error('Missing Session Action proof');
    expect(origin.caller).toMatchObject({ kind: 'session', sessionId: h.sessionId });
    expect(source).toEqual({ machineId: 'machine', installationId: h.f.installation.installationId });
    const { requestId } = request.envelope;
    if (!requestId) throw new Error('Missing Session Action request id');
    const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(request.envelope);
    expect(verifyMachineInstallationProof({ publicKey: h.f.installation.publicKey, proof: installationProof,
      payload: { version: 1, accountId: 'requester', ...source, externalActionOrigin: {
        homeId: home, actionId: effect.actionId, requestId, requestEnvelopeDigest, origin,
      } },
    })).toBe(true);
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1, token: `guest-account-action-root-${requestId}`, binding: {
        accountId: 'requester', custodianAccountId: 'custodian', authentication: { kind: 'terminal', tokenEpoch: 0 },
        serverIdentityId: home, ...source, actionId: effect.actionId, requestId,
        target: request.envelope.target, accountEncryptionMode: 'plain', admittedMachineRole: 'use',
        requestEnvelopeDigest, sessionActionOrigin: origin, sessionActionSource: source,
      },
    });
    admitted.set(effect.actionId, authorization);
    return { status: 200, data: authorization };
  });
  const request = vi.mocked(axios.request).getMockImplementation();
  const get = vi.mocked(axios.get).getMockImplementation();
  if (!get) throw new Error('Missing Home Session transport');
  let sharedSession = true;
  vi.spyOn(axios, 'get').mockImplementation(async (...args) => {
    const response = await get(...args);
    if (!sharedSession || new URL(String(args[0])).pathname !== `/v2/sessions/${h.sessionId}`) return response;
    const grant = { accessLevel: 'edit' as const, canApprovePermissions: false };
    return { ...response, data: { ...response.data, session: { ...response.data.session,
      share: grant, effectiveAccess: { v: 1, level: 'edit', sources: [{ kind: 'direct', shareId: 'foreign-session-grant' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [grant] }) },
    } } };
  });
  const effects: string[] = [];
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    const { pathname } = new URL(String(config.url));
    if (pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      expect(config.headers?.Authorization === `Bearer ${guest.token}`).toBe(true);
      return { status: 200, data: { v: 1, rows: [] } };
    }
    const effect = actions.find(action => action.path === pathname);
    if (!effect) {
      if (request) return request(config);
      throw new Error('Unexpected Home request');
    }
    const root = admitted.get(effect.actionId);
    if (!root) throw new Error('Missing guest authorization');
    const headers = config.headers;
    expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === root.token).toBe(true);
    expect(headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(effect.actionId);
    const target = decodeExternalActionResolvedTargetV1(String(headers?.[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]));
    expect(target).toEqual(root.binding.target);
    if (!target || !config.method) throw new Error('Missing signed effect target or method');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: effect.actionId,
      target, installationId: root.binding.installationId, requestId: root.binding.requestId, method: config.method,
      path: pathname, body: config.data, signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      publicKey: h.f.installation.publicKey,
    })).toBe(true);
    expect(config.data).toEqual(effect.input);
    effects.push(effect.actionId);
    return { status: 200, data: effect.output };
  });

  const invoke = ({ actionId, input }: typeof actions[number]) => h.dispatch({
    kind: 'action.execute', surface: 'agent', actionId, input, requestId: h.operationBase().requestId,
    witness: { turnId: 'security-turn', inputId: 'security-input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0,
      agentStartCaller: { kind: 'session', sessionId: h.sessionId, starterDepth: 0, turnDepth: 0 },
      callerPermissionMode: 'default' },
  });
  expect(await invoke(actions[0])).toMatchObject({
    ok: true, result: { kind: 'action.execution', outcome: { ok: false, details: { reason: 'session_not_owner' } } },
  });
  expect(effects).toEqual([]);
  sharedSession = false;
  for (const action of actions) {
    const result = await invoke(action);
    const outcome = result.ok && result.result.kind === 'action.execution' ? result.result.outcome : result;
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: action.output });
  }
  expect(effects).toEqual(actions.map(({ actionId }) => actionId));
}, 120_000);
