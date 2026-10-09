import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { projectRequesterAccountActionAuthorization } from '../sessionEncryption/requesterSessionCredentials';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';

import {
  createActionExecutor,
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  computeExternalActionRequestEnvelopeDigestV1,
  measureExternalActionResponseEnvelopeUtf8BytesV1,
  openExternalActionResponseV2,
  sealExternalActionRequestV2,
  verifyExternalActionApprovalInputV1,
} from '@happier-dev/protocol/actions';
import { API_TOKEN_FULL_GRANT_V1, buildBackendTargetKeyV2 } from '@happier-dev/protocol';
import { createUnavailableActionTransportDeps as createUnavailableHostActionDeps } from '@/testkit/actionTransportDeps';

import {
  executeExternalAction,
  type ExternalActionExecutor,
  type ResolveExternalActionTarget,
} from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ActionsSettingsV1Schema, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  projectExternalActionExecutionResultV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { ManagedAdmissionComputeInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { ProjectAccountRowV1Schema, ProjectAccountRowMutationRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { encodeStoredCredentials } from '@/persistence';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';

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
  it('preserves terminal E2EE identity and automation through actual installed custody, effect and reply', async () => {
    const accountId = 'bob-terminal';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, session: 'bob-terminal-session', tokenEpoch: 7,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(31) };
    const credentials = { token, encryption: { ...material, publicKey: tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey },
      credentialProvenance: 'stored_session' as const };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const target = { kind: 'machine' as const, machineId: 'alice-controller' };
    const actionId = 'machines.managed.list';
    const authentication = { kind: 'terminal' as const, tokenEpoch: 7 };
    const principal = { accountId, authority: 'account_automation' as const, authentication };
    const binding = { serverIdentityId: 'srv_home', accountId, authentication, actionId,
      requestId: 'terminal-e2ee-request', target };
    const envelope = sealExternalActionRequestV2({ binding, material, input: { homeId: 'srv_home' }, randomBytes: tweetnacl.randomBytes });
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: { v: 1, token: 'home-terminal-root', binding: {
      ...binding, accountEncryptionMode: 'e2ee', custodianAccountId: 'alice', machineId: target.machineId,
      installationId: 'alice-installation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }, credentials: encodeStoredCredentials(credentials), purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'encrypted' });
    let effects = 0;
    let servedContext: ActionExecutorContext | undefined;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: settings, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'e2ee', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: computeContentPublicKeyFingerprint(
          tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey), updatedAt: 1 } };
      throw new Error(`Unexpected terminal requester GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(new URL(String(url)).pathname).toBe(`/v1/actions/${actionId}/execution-authorization/verify`);
      return { status: 200, data: { ok: true } };
    });
    const run = (requestPrincipal: Parameters<typeof executeExternalAction>[0]['principal']) => executeExternalAction({
      actionId, envelope, principal: requestPrincipal, surface: 'cli', executionAuthorization: authorization,
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'alice-installation',
      externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-custodian' } }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
        purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'alice-installation',
        installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
        serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
        createExecutor: admitted => {
          expect(admitted.credentials.token).toBe(token);
          return createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
            serverId: 'profile', serverApiUrl: admitted.serverHttpBaseUrl, serverIdentityId: 'srv_home', machineId: target.machineId,
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admitted.accountSettingsContext.settings },
            managedMachineAction: async ({ context }) => { effects++; servedContext = context; return { machines: [] }; },
          });
        },
      }),
    });
    try {
      const result = await run(principal);
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { v: 2 } });
      if (result.kind !== 'response') throw new Error('Expected terminal encrypted reply');
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material })).toMatchObject({
        ok: true, result: { machines: [] },
      });
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope,
        binding: { ...binding, authentication: { kind: 'account', tokenEpoch: authentication.tokenEpoch } }, material })).toBeNull();
      expect(servedContext).toMatchObject({ authority: 'account_automation',
        externalActionExecutionAuthorization: { binding: { accountId, authentication } } });
      expect(effects).toBe(1);
      expect(await run({ accountId, authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 7 } }))
        .toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
      expect(effects).toBe(1);
    } finally { get.mockRestore(); post.mockRestore(); }
  });
  it('preserves UI Ask through the real private requester credential factory on a foreign installation', async () => {
    const accountId = 'bob-private-ask';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const target = { kind: 'machine' as const, machineId: 'alice-controller' };
    const actionId = 'machines.managed.acquire';
    const input = { selection: { kind: 'one-off' as const, homeId: 'srv_home',
      controller: { machineId: target.machineId, installationId: 'alice-installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
    const principal = { accountId, authority: 'present_user' as const, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const envelope = { v: 1 as const, requestId: 'bob-reviewed-request', input, target };
    const authorization = sealExternalActionRequesterAccountContextV1({
      authorization: { v: 1, token: 'home-admitted-bob', binding: {
        accountId, authentication: principal.authentication, accountEncryptionMode: 'plain', serverIdentityId: 'srv_home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'alice-installation',
        actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }, credentials: { token }, purpose: { kind: 'external_action' }, installationPublicKey: installation.publicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    const storedSettings = { actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } };
    const aliceSnapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: 'alice-custodian' };
    setActiveAccountSettingsSnapshot(aliceSnapshot);
    let effects = 0;
    const approvals: ApprovalRequest[] = [];
    // HTTP is the only substituted owner. Private credential opening,
    // requester admission, policy, receiver signing and Artifact codec stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: storedSettings }, version: 2 } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error(`Unexpected requester GET: ${String(url)}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
      if (new URL(String(url)).pathname === `/v1/actions/${actionId}/execution-authorization/verify`) return { status: 200, data: { ok: true } };
      expect(new URL(String(url)).pathname).toBe('/v1/artifacts');
      if (!raw || typeof raw !== 'object' || !('id' in raw) || !('body' in raw)) throw new Error('Malformed requester Artifact');
      const body = typeof raw.body === 'string' ? decodePlainArtifactStoredContent(raw.body) : null;
      if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing private approval');
      approvals.push(ApprovalRequestV2Schema.parse(JSON.parse(body.body)));
      return { status: 200, data: { id: raw.id, headerVersion: 1, bodyVersion: 1 } };
    });
    try {
      const result = await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'alice-installation',
        externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-custodian' } }),
        executor: createActionExecutor(createUnavailableHostActionDeps()),
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'alice-installation',
          installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: 'srv_home',
          serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
          createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
            readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
            serverId: 'profile', serverApiUrl: admitted.serverHttpBaseUrl, serverIdentityId: 'srv_home', machineId: target.machineId,
            externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: 'alice-installation',
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
              getAccountSettings: () => admitted.accountSettingsContext.settings },
            managedMachineAction: async () => { effects++; return { managedId: 'retained' }; },
          }),
        }),
      });
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
        result: { kind: 'approval_request_created', actionId } } } });
      expect(effects).toBe(0);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ status: 'open', executionOriginV1: { surface: 'ui', authority: 'present_user', accountId,
        externalActionExecutionAuthorization: { binding: { accountId, custodianAccountId: 'alice' } } } });
      expect(JSON.stringify(approvals[0])).not.toContain(token);
      expect(getActiveAccountSettingsSnapshot()).toBe(aliceSnapshot);
    } finally { get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('preserves own original Account Project HTTP custody without inventing a requester box', async () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'own-account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
      rawSettings: { privateOwnPublicationMarker: 'unchanged' }, settingsVersion: 9, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const ownSnapshot = getActiveAccountSettingsSnapshot();
    const principal = { accountId: 'own-account', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 1 } };
    const actionId = 'projects.visibility.set';
    const target = { kind: 'machine' as const, machineId: 'own-machine' };
    const input = { target: { serverId: 'own-home', projectKey: 'project' }, expectedRevision: 2, hidden: false };
    const envelope = { v: 1 as const, requestId: 'own-project-request', target, input };
    const authorization = { v: 1 as const, token: 'own-home-root', binding: { accountId: principal.accountId,
      custodianAccountId: principal.accountId, authentication: principal.authentication, accountEncryptionMode: 'plain' as const,
      serverIdentityId: 'srv_own', machineId: target.machineId, installationId: 'own-installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
    let row = ProjectAccountRowV1Schema.parse({ key: { kind: 'project-organization', serverId: 'own-home', projectKey: 'project' },
      revision: 2, content: { t: 'plain', v: { key: { kind: 'project-organization', serverId: 'own-home', projectKey: 'project' },
        value: { hidden: true, pinned: false, promptStack: [] } } } });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/profile') return { status: 200, data: { id: principal.accountId } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected own Project GET ${path}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown, config) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toEqual(expect.any(String));
      if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [row] } };
      if (path === '/v1/account/project-rows/mutate') {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        const mutation = request.mutations[0]!;
        expect(mutation.expectedRevision).toBe(row.revision);
        row = ProjectAccountRowV1Schema.parse({ key: mutation.key, revision: row.revision + 1, content: mutation.content });
        return { status: 200, data: { status: 'updated', rows: [row], cursor: row.revision } };
      }
      throw new Error(`Unexpected own Project POST ${path}`);
    });
    const createExecutor = () => createActionExecutor(createCliActionDeps({ token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
      serverId: 'own-home', serverHttpBaseUrl: 'https://own-home.test' }));
    try {
      const run = (authority: 'present_user' | 'account_automation') => {
        const authentication = authority === 'present_user' ? principal.authentication : { kind: 'terminal' as const, tokenEpoch: 1 };
        return executeExternalAction({ actionId, envelope,
        principal: { ...principal, authority, authentication }, executionAuthorization: {
          ...authorization, binding: { ...authorization.binding, authentication },
        },
        currentMachineId: target.machineId, currentServerId: 'own-home', currentServerHttpBaseUrl: 'https://own-home.test',
        currentInstallationId: 'own-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async () => true, resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: createExecutor(),
        prepareRequesterAccountContext: async ({ authorization: root, purpose, signal }) => {
          const admission = { authorization: root, purpose: purpose ?? { kind: 'external_action' as const },
            machineId: target.machineId, installationId: 'own-installation', installationPrivateKey: installation.secretKey,
            serverId: 'own-home', serverIdentityId: 'srv_own', serverHttpBaseUrl: 'https://own-home.test',
            ownCredentials: credentials, isCurrent: async () => true, signal, createExecutor };
          return await prepareRequesterAccountActionContext(admission);
        },
      });
      };
      const executed = await run('present_user');
      expect(executed, JSON.stringify(executed)).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { row: { hidden: false }, revision: 3 },
      } } });
      expect(JSON.stringify(authorization)).not.toContain('requesterAccountContext');
      expect(getActiveAccountSettingsSnapshot()).toBe(ownSnapshot);
      expect(await run('account_automation')).toMatchObject({ kind: 'response', response: { execution: {
        ok: false, errorCode: 'project_visibility_access_denied',
      } } });
    } finally { get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('opens arbitrary requester custody only after Home admission and supplies Bob private crypto to the real executor', async () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    const bob = { token: 'bob-private', encryption: null };
    const accountPrincipal = { accountId: 'bob', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 1 } };
    const target = { kind: 'machine' as const, machineId: 'alice-machine' };
    const envelope = { v: 1 as const, requestId: 'private-request', target, input: { message: 'Private result' } };
    const actionId = 'notifications.notify_me';
    const authorization = sealExternalActionRequesterAccountContextV1({
      authorization: { v: 1, token: 'home-root', binding: { accountId: 'bob', custodianAccountId: 'alice',
        authentication: accountPrincipal.authentication, accountEncryptionMode: 'plain', serverIdentityId: 'home',
        machineId: target.machineId, installationId: 'installation', actionId, requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } },
      credentials: { token: bob.token }, purpose: { kind: 'external_action' }, installationPublicKey: installation.publicKey,
      randomBytes: tweetnacl.randomBytes,
    });
    let homeCurrent = true;
    let retired: (() => Promise<boolean>) | undefined;
    let deliveredTo: string | undefined;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe('Bearer bob-private');
      if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`https://home.test/v1/actions/${actionId}/execution-authorization/verify`);
      return { status: homeCurrent ? 200 : 403, data: { ok: homeCurrent } };
    });
    const run = () => executeExternalAction({ actionId, envelope, principal: accountPrincipal, surface: 'cli',
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: authorization, externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization: async () => homeCurrent,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-custodian' } }),
      executor: createActionExecutor(createUnavailableHostActionDeps()),
      prepareRequesterAccountContext: async ({ authorization: root }) => {
        return await prepareRequesterAccountActionContext({ authorization: root, purpose: { kind: 'external_action' },
          machineId: target.machineId, installationId: 'installation', installationPrivateKey: installation.secretKey,
          serverId: 'profile', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test', isCurrent: async () => homeCurrent,
          createExecutor: admitted => {
            retired = admitted.isCurrent;
            // The private runtime owns credentials, but Project effects still require original Home HTTP authority on the carrier.
            return createActionExecutor({ ...createUnavailableHostActionDeps(),
            // Notification delivery is the external boundary; admission and crypto owners stay real.
            notificationsNotifyMe: async (_input, context) => {
              deliveredTo = context.externalActionExecutionAuthorization?.requesterAccountProjection?.accountId;
              expect(context.externalActionExecutionAuthorization?.requesterHttpProjection?.accountId).toBe('bob');
              expect(JSON.stringify(context.externalActionExecutionAuthorization)).not.toContain('requesterAccountContext');
              return { attemptedChannels: 1, deliveredChannels: deliveredTo === 'bob' ? 1 : 0 };
            } });
          },
        });
      },
    });
    try {
      const executed = await run();
      expect(executed, JSON.stringify(executed)).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 },
      } } });
      expect(deliveredTo).toBe('bob');
      expect(await retired?.()).toBe(false);
      homeCurrent = false;
      expect(await run()).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    } finally { get.mockRestore(); post.mockRestore(); }
  });
  it.each([
    ['current', 'prepare'], ['current', 'execute'], ['newly persisted', 'prepare'], ['newly persisted', 'execute'],
    ['refused by Home', 'prepare'],
  ] as const)('preserves signed own-Account UI authority and %s Ask before native %s', async (policy, operation) => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    const accountId = 'ask-fresh-account';
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const privateKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey;
    const actionId = 'machines.managed.acquire';
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const input = { selection: { kind: 'one-off' as const, homeId: 'srv_home',
      controller: { machineId: target.machineId, installationId: 'installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
    const principal = { accountId, authority: 'present_user' as const, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const envelope = { v: 1 as const, requestId: 'fresh-ask', input, target };
    const authorization = { v: 1 as const, token: 'signed-account-root', binding: {
      accountId, authentication: principal.authentication, accountEncryptionMode: 'plain' as const,
      serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: accountId,
      installationId: 'installation', actionId, requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    const storedSettings = { actionsSettingsV1: { v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } } };
    const snapshotSettings = policy === 'newly persisted' ? {} : storedSettings;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(snapshotSettings), rawSettings: snapshotSettings, settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    let effects = 0;
    const savedApprovals: ApprovalRequest[] = [];
    // HTTP is the only substituted owner here: real credential scoping,
    // settings publication, policy, input signing and private Artifact codec run.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: storedSettings }, version: 2 } };
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error(`Unexpected HTTP GET: ${String(url)}`);
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
      if (new URL(String(url)).pathname === `/v1/actions/${actionId}/execution-authorization/verify`) return policy === 'refused by Home'
        ? { status: 403, data: { ok: false } } : { status: 200, data: { ok: true } };
      expect(new URL(String(url)).pathname).toBe('/v1/artifacts');
      if (!raw || typeof raw !== 'object' || !('id' in raw) || !('body' in raw)) throw new Error('Malformed Artifact request');
      const body = typeof raw.body === 'string' ? decodePlainArtifactStoredContent(raw.body) : null;
      if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Missing private approval body');
      savedApprovals.push(ApprovalRequestV2Schema.parse(JSON.parse(body.body)));
      return { status: 200, data: { id: raw.id, headerVersion: 1, bodyVersion: 1 } };
    });
    try {
      const native = createCliActionExecutorFromCredentials({ credentials, machineId: target.machineId,
        serverId: 'profile', serverApiUrl: 'https://home.test', serverIdentityId: 'srv_home',
        externalActionMachineRequestPrivateKey: privateKey, externalActionMachineInstallationId: 'installation',
        managedMachineAction: async request => {
          expect(request.context).toMatchObject({ surface: 'ui', authority: 'present_user', runtimeAccountId: accountId });
          effects++; return { managedId: 'retained' };
        },
      });
      const executor: ExternalActionExecutor = { execute: async (id, args, context) => {
        if (operation === 'execute') return await native.execute(id, args, context);
        const prepared = await native.prepare(id, args, context);
        return prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
      } };
      const result = await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
        currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation', executor,
        externalActionMachineRequestPrivateKey: privateKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      });
      if (policy === 'refused by Home') {
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'target_unavailable' } } });
        expect(effects).toBe(0);
        expect(savedApprovals).toHaveLength(0);
        return;
      }
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { kind: 'approval_request_created', actionId } } } });
      expect(effects).toBe(0);
      expect(savedApprovals).toHaveLength(1);
      expect(savedApprovals[0]).toMatchObject({ status: 'open', executionOriginV1: { accountId, authority: 'present_user', surface: 'ui' } });
    } finally {
      get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); vi.unstubAllEnvs();
    }
  });

  it.each([
    ['plain', 'machines.managed.acquire', 'own'], ['e2ee', 'machines.managed.acquire', 'own'],
    ['plain', 'machines.managed.bootstrap.retry', 'own'], ['e2ee', 'machines.managed.bootstrap.retry', 'own'],
    ['plain', 'machines.managed.acquire', 'admitted requester'], ['e2ee', 'machines.managed.acquire', 'admitted requester'],
  ] as const)('preserves one exact-Account UI Ask and its registered approved replay for %s %s %s', async (mode, actionId, custody) => {
    const accountPrincipal = { accountId: 'requester', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const input = actionId === 'machines.managed.acquire' ? { selection: { kind: 'one-off' as const,
      homeId: 'srv_home', controller: { machineId: target.machineId, installationId: 'installation' },
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
    } } : { homeId: 'srv_home', managedId: 'retained', expectedIntentRevision: 0 };
    const binding = { accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication,
      serverIdentityId: 'srv_home', actionId, requestId: 'reviewed-request', target };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ binding, material, input,
      randomBytes: length => new Uint8Array(length).fill(12),
      ...(actionId === 'machines.managed.acquire' ? { managedAdmission: {
        actionId: 'machines.managed.acquire' as const, input: ManagedAdmissionComputeInputV1Schema.parse(input), continuationPresent: false,
      } } : {}),
    }) : { v: 1 as const, input, target, requestId: binding.requestId };
    const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
    const authorization = { v: 1 as const, token: 'signed-account-root', binding: { ...binding,
      machineId: target.machineId, custodianAccountId: custody === 'own' ? accountPrincipal.accountId : 'alice', installationId: 'installation',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: mode,
    } };
    const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: accountPrincipal.accountId,
      machineId: target.machineId, serverId: 'profile',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: target.machineId }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester' } }),
      listAccountApiTokens: async () => ({ tokens: [] }), externalActionMachinePublicKey: keyPair.publicKey,
      // Current Home proof verification is the network boundary. Installation,
      // original input signature, strict Artifact and Action policy stay real.
      verifyExternalExecutionAuthorization: async () => true,
    });
    const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } });
    const artifacts = new Map<string, ApprovalRequest>();
    const states: string[] = [];
    let effects = 0;
    // Persistent Artifact IO is substituted; its immutable subject and
    // open/approved/executing/terminal transition owner remain real.
    const approvalStore = {
      approvalsCreate: async ({ request }: { request: ApprovalRequest }) => {
        const artifactId = `approval-${artifacts.size + 1}`;
        const parsed = ApprovalRequestV2Schema.parse(request);
        artifacts.set(artifactId, parsed); states.push(parsed.status);
        return { artifactId };
      },
      approvalsGet: async ({ artifactId }: { artifactId: string }) => artifacts.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }: { artifactId: string; request: ApprovalRequest }) => {
        const previous = artifacts.get(artifactId);
        if (!previous) throw new Error('Missing approval Artifact');
        const next = ApprovalRequestV2Schema.parse(request);
        const admitted = decideApprovalRequestTransition(previous, next);
        if (!admitted.ok) return admitted;
        artifacts.set(artifactId, next); states.push(next.status);
        return { ok: true as const };
      },
    };
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountPrincipal.accountId })).toString('base64url')}.signature`;
    const daemon = createCliActionExecutorHarness({ token, credentials: { token, encryption: null }, sessionId: '',
      serverId: 'profile', serverHttpBaseUrl: 'https://home.test', mode: 'plain', ctx: null,
      actionsSettingsProvider: { getActionsSettings: () => settings, getAccountSettings: () => null },
    }, { ...approvalStore, isApprovalExecutionOriginCurrent: currentness,
      managedMachineAction: async request => {
        expect(request.context).toMatchObject({ authority: 'present_user', actionRequestId: binding.requestId,
          externalActionExecutionAuthorization: authorization, runtimeAccountId: accountPrincipal.accountId });
        effects++;
        return { managedId: 'retained' };
      },
    }).executor;
    const handlers = new Map<string, (input: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    registerApprovalRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } },
      actionExecutor: custody === 'own' ? daemon : createActionExecutor(createUnavailableHostActionDeps()) });
    const freshAdmission = { ...authorization };
    // The already-admitted private host facet is not a wire field. Generic installed-box admission is tested at RpcHandlerManager.
    Object.defineProperty(freshAdmission, 'requesterAccountExecutor', { value: daemon, enumerable: false });
    const client = createActionExecutor({ ...createUnavailableHostActionDeps(), ...approvalStore,
      isApprovalExecutionOriginCurrent: currentness,
      approvalRequestApprovedReplay: async request => {
        if (!requiresExactDaemonApprovalReplay(request.request)) return null;
        const result = await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId: request.artifactId },
          { callerAuthority: 'present_user', signal: new AbortController().signal,
            ...(custody === 'admitted requester' ? { callerInputAuthorization: freshAdmission } : {}) });
        return projectExternalActionExecutionResultV1(result);
      },
      // The app cannot consume signed native origin as a local bypass.
      managedMachineAction: async () => ({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' }),
    });
    const admitted = await executeExternalAction({ actionId, envelope, principal: accountPrincipal,
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: authorization, externalActionMachineRequestPrivateKey: keyPair.secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveEncryption: async () => ({ serverIdentityId: 'srv_home', material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester' } }), executor: daemon,
    });
    const result = admitted.kind === 'response' ? admitted.response.v === 2 && envelope.v === 2
      ? openExternalActionResponseV2({ envelope: admitted.response, binding, material, request: envelope })
      : admitted.response.v === 1 ? admitted.response.execution : null : null;
    expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId } });
    expect(effects).toBe(0);
    const approval = ApprovalRequestV2Schema.parse(artifacts.get('approval-1'));
    expect(approval.executionOriginV1).toMatchObject({ authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
      accountId: accountPrincipal.accountId, machineId: target.machineId, requestId: binding.requestId });
    const decision = await client.execute('approval.request.decide', { artifactId: 'approval-1', decision: 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'profile' });
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { managedId: 'retained' } } } });
    expect(states).toEqual(['open', 'approved', 'executing', 'executed']);
    expect(artifacts.size).toBe(1);
    expect(effects).toBe(1);
    expect(await handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!({ artifactId: 'approval-1' },
      { callerAuthority: 'present_user', signal: new AbortController().signal,
        ...(custody === 'admitted requester' ? { callerInputAuthorization: freshAdmission } : {}) })).toEqual(decision);
    expect(effects).toBe(1);
  });

  it('materializes only the exact signed Session caller and cause instead of promoting it to a present user', async () => {
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
      caller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'turn',
      callerPermissionMode: 'read-only', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
      workspaceWrites: 'deny', requestId: 'original-request' });
    const accountPrincipal = { accountId: 'requester', authority: 'account_automation' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 7 }, sessionActionOrigin };
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const envelope = { v: 1 as const, requestId: 'original-request', target, input: { homeId: 'srv_home' } };
    const authorization = { v: 1 as const, token: 'home-signed-source', binding: {
      accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication, sessionActionOrigin,
      sessionActionSource: { machineId: 'source-machine', installationId: 'source-installation' },
      serverIdentityId: 'srv_home', machineId: target.machineId, custodianAccountId: 'requester', installationId: 'installation',
      actionId: 'machines.managed.list', requestId: envelope.requestId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain' as const,
    } };
    let servedContext: ActionExecutorContext | undefined;
    // Managed HTTP and Home proof currentness are network boundaries; the
    // receiving transport, target reconciliation and Action executor stay real.
    const managedMachineAction = vi.fn(async ({ context }: { context: ActionExecutorContext }) => {
      servedContext = context;
      return { machines: [] };
    });
    const run = (requestPrincipal: typeof accountPrincipal) => executeExternalAction({
      actionId: 'machines.managed.list', envelope, principal: requestPrincipal,
      currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation',
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'requester' } }),
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), managedMachineAction }),
    });
    expect(await run(accountPrincipal)).toMatchObject({ kind: 'response', response: { execution: { ok: true } } });
    expect(servedContext).toMatchObject({ surface: 'agent', authority: 'account_automation',
      actionCaller: sessionActionOrigin.caller, defaultSessionId: 'source', callerPermissionMode: 'read-only', workspaceWrites: 'deny',
      causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
      sessionInputSource: { sourceSessionId: 'source', sourceTurnId: 'turn', via: 'action' } });
    expect(servedContext).not.toHaveProperty('externalActionCredential');
    expect(await run({ ...accountPrincipal, sessionActionOrigin: { ...sessionActionOrigin,
      caller: { ...sessionActionOrigin.caller, turnDepth: 0 } } })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    expect(managedMachineAction).toHaveBeenCalledTimes(1);
  });
  it('admits ordinary Account proof without PAT grants and rejects changed pre-forward compute before any effect', async () => {
    const accountPrincipal = { accountId: 'requester', authority: 'present_user' as const,
      authentication: { kind: 'account' as const, tokenEpoch: 7 } };
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const privateKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey;
    let servedContext: ActionExecutorContext | undefined;
    // Managed HTTP output and Home currentness are network boundaries; the
    // receiver, target owner, crypto and canonical Action executor stay real.
    const managedMachineAction = vi.fn(async ({ context }: { context: ActionExecutorContext }) => {
      servedContext = context;
      return { machines: [] };
    });
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(), managedMachineAction });
    const run = async (actionId: 'machines.managed.list' | 'machines.managed.acquire', actionInput: unknown,
      projection?: Parameters<typeof executeExternalAction>[0]['envelope']) => {
      const envelope = { ...sealExternalActionRequestV2({ binding: { accountId: accountPrincipal.accountId,
        authentication: accountPrincipal.authentication, serverIdentityId: 'srv_home', actionId, requestId: 'ordinary', target },
        input: actionInput, material, randomBytes: length => new Uint8Array(length).fill(12) }),
        ...(projection && typeof projection === 'object' ? projection : {}),
      };
      return await executeExternalAction({ actionId, envelope, principal: accountPrincipal,
        currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation-1',
        executionAuthorization: { v: 1, token: 'signed-account-root', binding: {
          accountId: accountPrincipal.accountId, authentication: accountPrincipal.authentication, serverIdentityId: 'srv_home',
          machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation-1',
          actionId, requestId: 'ordinary', target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } },
        externalActionMachineRequestPrivateKey: privateKey, verifyExecutionAuthorization: async () => true,
        resolveEncryption: async () => ({ serverIdentityId: 'srv_home', material }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'custodian' } }), executor,
      });
    };
    expect(await run('machines.managed.list', { homeId: 'home' })).toMatchObject({ kind: 'response' });
    expect(servedContext).toMatchObject({ authority: 'present_user', externalActionExecutionAuthorization: {
      binding: { accountId: 'requester', authentication: accountPrincipal.authentication },
    } });
    expect(servedContext).not.toHaveProperty('externalActionCredential');
    const compute = { selection: { kind: 'one-off' as const, homeId: 'home',
      controller: { machineId: target.machineId, installationId: 'installation-1' },
      launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} },
      retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
    expect(await run('machines.managed.acquire', compute, { managedAdmission: {
      actionId: 'machines.managed.acquire', input: { ...compute, selection: { ...compute.selection, wakeOnAcceptedMessage: true } },
      continuationPresent: false,
    } })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
    expect(managedMachineAction).toHaveBeenCalledTimes(1);
  });
  it('preserves admitted requester private Account ports through wire parsing and refuses their retired custody', async () => {
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const envelope = { v: 1 as const, requestId: 'requester-ports', target, input: { message: 'Finished' } };
    const secret = new Uint8Array(32).fill(7);
    const key = { kind: 'project-organization', serverId: 'home-profile', projectKey: 'bob-project' } as const;
    const row = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret },
      randomBytes: length => new Uint8Array(length).fill(12) }).seal({ key, value: { pinned: true } });
    const read = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
    } });
    try {
      let live = true;
      const authorization = await projectRequesterAccountActionAuthorization({
        authorization: { v: 1, token: 'home-proof', binding: { accountId: principal.accountId,
          principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
          serverIdentityId: 'home', custodianAccountId: 'alice', machineId: target.machineId,
          installationId: 'installation-1', actionId: 'notifications.notify_me', requestId: envelope.requestId,
          target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } },
        serverIdentityId: 'home', bootstrap: { credentials: { token: 'bob-ordinary', encryption: { type: 'legacy', secret } },
          attribution: { serverId: 'home-profile', accountId: principal.accountId, machineId: target.machineId,
            installationId: 'installation-1' }, serverHttpBaseUrl: 'https://bob-home.test', isCurrent: async () => live },
      });
      if (!authorization) throw new Error('Expected admitted private requester projection');
      // Notification delivery is the network boundary; all Action/crypto/admission owners are real.
      const deliver = vi.fn(async (_input: unknown, context: ActionExecutorContext) => {
        const projection = context.externalActionExecutionAuthorization?.requesterAccountProjection;
        const opened = projection?.projectAccountRowCipher.open(key, row);
        return { attemptedChannels: 1, deliveredChannels: opened?.value && 'pinned' in opened.value && opened.value.pinned ? 1 : 0 };
      });
      const run = () => executeExternalAction({ actionId: 'notifications.notify_me', envelope, principal,
        currentMachineId: target.machineId, currentServerId: 'home-profile', currentInstallationId: 'installation-1',
        executionAuthorization: authorization,
        externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).secretKey,
        verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice' } }),
        executor: createActionExecutor({ ...createUnavailableHostActionDeps(), notificationsNotifyMe: deliver }),
      });
      expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
        ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 },
      } } });
      live = false;
      expect(await run()).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'not_authenticated' } } });
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });

  it('opens shared Machine V2 under target material and rechecks current admission after preparation', async () => {
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const machineMaterial = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(23) };
    const actorMaterial = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(17) };
    const installationId = '11111111-1111-4111-8111-111111111111';
    const binding = { serverIdentityId: 'srv_home', accountId: 'bob',
      credentialId: '00000000-0000-4000-8000-000000000001', actionId: 'session.spawn_new',
      requestId: 'shared-machine-start', target };
    const envelope = sealExternalActionRequestV2({ binding, material: machineMaterial,
      input: { creationKey: 'shared-start', agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, directory: { kind: 'managed' } },
      randomBytes: (length) => new Uint8Array(length).fill(2) });
    const authorization = { v: 1 as const, token: 'home-proof', binding: {
      ...binding, principalId: 'bob', custodianAccountId: 'alice', installationId,
      machineId: target.machineId, grant: API_TOKEN_FULL_GRANT_V1,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    // Host launch is the OS effect boundary; all ingress, crypto, target and Action logic are real.
    const sessionSpawnNew = vi.fn(async () => SESSION_SPAWN_PENDING_RESULT);
    const executor = createActionExecutor({ ...createUnavailableHostActionDeps(), sessionSpawnNew });
    let current = true;
    const run = (material = machineMaterial) => executeExternalAction({
      actionId: binding.actionId, envelope,
      principal: { ...principal, accountId: 'bob', principalId: 'bob', credentialId: binding.credentialId },
      currentMachineId: target.machineId, currentInstallationId: installationId, currentServerId: 'home-profile',
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'alice-daemon-token' } }),
      verifyExecutionAuthorization: async () => current,
      executor,
    });
    const successful = await run();
    if (successful.kind !== 'response' || successful.response.v !== 2) throw new Error('Expected protected response');
    expect(openExternalActionResponseV2({ envelope: successful.response, binding, material: machineMaterial, request: envelope }))
      .toMatchObject({ ok: true });
    expect(await run(actorMaterial)).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope' });
    current = false;
    const denied = await run();
    if (denied.kind !== 'response' || denied.response.v !== 2) throw new Error('Expected protected refusal');
    expect(openExternalActionResponseV2({ envelope: denied.response, binding, material: machineMaterial, request: envelope }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(sessionSpawnNew).toHaveBeenCalledTimes(1);
  });

  it('admits a Companion widget client Action through an exact Session envelope', async () => {
    const target = { kind: 'session' as const, sessionId: 'session-1' };
    const ref = { surface: { serverId: 'home', accountId: principal.accountId,
      owner: { kind: 'companion' as const, sessionId: target.sessionId } }, instanceId: 'checks' };
    // Only the connected-client transport is replaced; ingress and Action admission are real.
    const clientActionExecute = vi.fn(async () => ({ ok: true as const, result: { ref, bindings: {} } }));
    const result = await executeExternalAction({ actionId: 'widgets.item.inputs.get',
      envelope: { v: 1, target, input: { ref } }, principal, currentMachineId: 'machine-1',
      resolveTarget: async ({ target: resolved }) => resolved ?? null,
      executor: createActionExecutor({ ...createUnavailableHostActionDeps(), clientActionExecute }),
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { bindings: {} } } } });
    expect(clientActionExecute).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'widgets.item.inputs.get', input: { ref }, context: expect.objectContaining({ defaultSessionId: target.sessionId }),
    }));
  });

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
      custodianAccountId: principal.accountId, installationId: 'installation-1',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      grant: { ...API_TOKEN_FULL_GRANT_V1, permissionModes: ['default'] as ['default'] },
    } };
    const sessionPermissionModeSet = vi.fn(async () => ({ ok: true }));
    const result = await executeExternalAction({ actionId: binding.actionId, envelope,
      principal: { ...principal, credentialId: binding.credentialId },
      executionAuthorization: authorization,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
      currentMachineId: 'machine-1', currentServerId: 'server-1',
      currentInstallationId: 'installation-1', verifyExecutionAuthorization: async () => true,
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
    // Decision Actions are public, but their canonical actor boundary still
    // rejects this automatic PAT before any approval effect.
    await expect(executeExternalAction({ ...request, principal,
      executor: createActionExecutor(createUnavailableHostActionDeps()),
    })).resolves.toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'present_user_required',
    } } });
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
        custodianAccountId: principal.accountId,
        installationId: 'installation-1',
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
      currentInstallationId: 'installation-1', verifyExecutionAuthorization: async () => true,
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
      currentInstallationId: 'installation-1', verifyExecutionAuthorization: async () => true,
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
          custodianAccountId: principal.accountId,
          installationId: 'installation-1',
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
      actionInput: { directory: '/workspace', prompt: 'hello' },
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
      actionInput: { sessionId: 'session-other-machine' },
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
      actionInput: { sessionId: 'session-1' },
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
