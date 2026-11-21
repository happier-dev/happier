import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import {
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 as collectionIds } from '@happier-dev/protocol/plugins/data/collectionSharingActionIdsV1';
import { PLUGIN_COLLECTION_SHARING_HTTP_PATHS_V1 as collectionPaths } from '@happier-dev/protocol/plugins/data/collectionSharingV1';
import { PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { SESSION_DATA_KEY_ENVELOPE_BYTES_V1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import { auth } from '@/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest } from '@/app/auth/externalActionExecutionAuthorization';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { mutateProjectAccountRows } from '@/app/projects/projectAccountRowService';

// An installed Machine executes an admitted Account-placement root over that
// Action's declared server transport. The signed proof must spend exactly that
// operation for every Account Action family, not only families listed by name.
let harness: LightSqliteHarness;
beforeAll(async () => {
  harness = await createLightSqliteHarness({
    tempDirPrefix: 'happier-account-transport-purpose-',
    initAuth: true,
    env: {
      AUTH_REQUIRED_LOGIN_PROVIDERS: '',
      AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
    },
  });
}, 120_000);
afterAll(async () => {
  await harness?.close();
});

describe('signed Account Action transport purpose', () => {
  it('confines Source creation and checkout linking to the requester’s existing checkout row', async () => {
    const homeId = await getOrCreateServerIdentityId();
    const actionId = 'projects.sources.create';
    const key = { kind: 'workspace-ref', serverId: homeId, id: crypto.randomUUID() } as const;
    const otherKey = { ...key, id: crypto.randomUUID() };
    const createRequester = async () => {
      const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
      const signer = tweetnacl.sign.keyPair();
      const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
          homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }), metadataVersion: 1,
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), daemonState: null, daemonStateVersion: 0,
        installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(signer.publicKey),
      } });
      return { account, machine, signer, token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }) };
    };
    const owner = await createRequester();
    const nonCustodian = await createRequester();
    const workspace = { v: 2, kind: 'managed', id: key.id, serverId: homeId, managedId: 'guest',
      controller: { machineId: owner.machine.id, installationId: owner.machine.installationId! }, rootPath: '/guest/repo', createdAtMs: 1 } as const;
    const content = { t: 'plain', v: { key, value: workspace } } as const;
    const graph = { kind: 'relationship-graph' } as const;
    const seeded = await mutateProjectAccountRows({ accountId: owner.account.id,
      request: { mutations: [{ key, expectedRevision: 'absent', content }, { key: graph, expectedRevision: 'absent',
        content: { t: 'plain', v: { key: graph, value: { relationships: [] } } } }], expectedRefs: [], topologyChange: true } });
    expect(seeded).toMatchObject({ status: 'updated' });
    if (seeded.status !== 'updated') throw new Error('Failed to seed the custodian checkout');
    const checkout = { v: 2, kind: 'managed', workspaceId: key.id, serverId: homeId,
      managedId: workspace.managedId, controller: workspace.controller, rootPath: workspace.rootPath } as const;
    const source = { serverId: homeId, name: 'Example repository', requestKey: 'connect-repository', repository: {
      provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'example/repo', cloneUrl: 'https://github.com/example/repo.git', visibility: 'private' }, protocol: 'https',
    } };
    const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
    registerProjectAccountRowRoutes(app);
    try {
      const bind = (requester: typeof owner) => app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
        headers: { authorization: `Bearer ${requester.token}` }, payload: { v: 1, machineId: requester.machine.id,
          envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: requester.machine.id },
            input: { ...source, checkout } } } });
      const accepted = await bind(owner);
      expect(accepted.statusCode, accepted.body).toBe(200);
      const root = ExternalActionExecutionAuthorizationV1Schema.parse(accepted.json());
      const signature = (path: string, body: unknown, requester = owner, authorization = root) => signExternalActionMachineRequestV1({
        authorizationToken: authorization.token, effectActionId: actionId, target: authorization.binding.target,
        installationId: requester.machine.installationId!, requestId: authorization.binding.requestId,
        method: 'POST', path, body, privateKey: requester.signer.secretKey,
      });
      const verify = async (path: string, body: unknown, routeInput = body) => (await verifyExternalActionDomainExecutionRequest({
        authorizationToken: root.token, effectActionId: actionId, encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target),
        method: 'POST', path, body, routeInput, machineSignature: signature(path, body),
      })) !== null;
      const postRow = (operation: 'read' | 'mutate', body: object, requester = owner, authorization = root) => {
        const url = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/${operation}`;
        return app.inject({ method: 'POST', url, payload: body, headers: {
          [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
          [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
          [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(authorization.binding.target),
          [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signature(url, body, requester, authorization),
        } });
      };
      const mutation = { mutations: [{ key, expectedRevision: seeded.rows[0]!.revision,
        content: { ...content, v: { key, value: { ...workspace, source: { sourceId: 'new-source', revision: 1 } } } } }],
      expectedRefs: [], topologyChange: false };
      expect(await verify('/v1/projects/sources', source)).toBe(true);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, { key })).toBe(true);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, mutation)).toBe(true);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { serverId: homeId })).toBe(false);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, { key: otherKey })).toBe(false);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, { key }, { key: otherKey })).toBe(false);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, { ...mutation, topologyChange: true })).toBe(false);
      expect(await verify(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`, { ...mutation,
        mutations: [{ ...mutation.mutations[0], key: otherKey }] })).toBe(false);
      expect((await postRow('read', { key })).json()).toMatchObject({ status: 'present', row: { key, content } });
      const rejectedRead = await postRow('read', { key: otherKey });
      expect(rejectedRead.statusCode).toBe(401);
      expect(rejectedRead.json()).toMatchObject({ error: 'invalid_token', authorizationRefusal: 'verification_purpose' });
      const changedController = { ...workspace, controller: { ...workspace.controller, installationId: 'other-installation' } };
      expect((await postRow('mutate', { ...mutation, mutations: [{ ...mutation.mutations[0],
        content: { ...content, v: { key, value: changedController } } }] })).json()).toEqual({ status: 'graph-required' });
      expect((await postRow('mutate', mutation)).json()).toMatchObject({
        status: 'updated', rows: [{ key, revision: seeded.rows[0]!.revision + 1 }],
      });
      const otherAdmission = await bind(nonCustodian);
      expect(otherAdmission.statusCode, otherAdmission.body).toBe(200);
      const otherRoot = ExternalActionExecutionAuthorizationV1Schema.parse(otherAdmission.json());
      const otherRead = await postRow('read', { key }, nonCustodian, otherRoot);
      expect(otherRead.statusCode, otherRead.body).toBe(200);
      expect(otherRead.json()).toEqual({ status: 'absent' });
      const otherWrite = await postRow('mutate', mutation, nonCustodian, otherRoot);
      expect(otherWrite.json()).toMatchObject({ status: 'conflict' });
      expect((await postRow('read', { key })).json()).toMatchObject({
        status: 'present', row: { key, revision: seeded.rows[0]!.revision + 1 },
      });
    } finally { await app.close(); }
  });

  it('refuses a Can-use member Archive carrier before disclosing credentials and retains custodian Archive', async () => {
    const owner = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const member = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
      id: crypto.randomUUID(), accountId: owner.id,
      metadata: encodePlainMachineStoredContent({ host: 'owner', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/owner', happyHomeDir: '/home/owner/.happier' }), metadataVersion: 1,
      dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), daemonState: null, daemonStateVersion: 0,
      installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
    } });
    await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id,
      accountId: member.id, accessLevel: 'view', createdByAccountId: owner.id } });
    const homeId = await getOrCreateServerIdentityId();
    const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: member.id,
      name: '', launch: { contentEncryptionMode: 'plain', recipients: [], content: { t: 'plain', v: {
        v: 1, name: 'Member-authored preset', launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' },
          schemaVersion: 1, choices: {} },
      } } } } });
    const token = await auth.createToken(member.id, undefined, { kind: 'account', authority: 'present_user' });
    const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
    try {
      const bind = async (actionId: 'machines.presets.archive' | 'machines.presets.prepare', bearer = token, selectedPreset = preset) => await app.inject({
        method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
        headers: { authorization: `Bearer ${bearer}` }, payload: { v: 1, machineId: machine.id,
          envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id },
            input: { homeId, id: selectedPreset.id, expectedRevision: selectedPreset.revision,
              ...(actionId === 'machines.presets.prepare' ? { machineId: machine.id } : {}) } } },
      });
      const archived = await bind('machines.presets.archive');
      expect(archived.statusCode, archived.body).toBe(403);
      expect(archived.json()).toMatchObject({ error: 'credential_scope_denied', failureCause: {
        nativeErrorReason: 'prepared_image_custodian_required',
      } });
      const ownPreset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: owner.id,
        name: '', launch: preset.launch } });
      const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
      const ownArchive = await bind('machines.presets.archive', ownerToken, ownPreset);
      expect(ownArchive.statusCode, ownArchive.body).toBe(200);
      expect(ExternalActionExecutionAuthorizationV1Schema.parse(ownArchive.json()).binding).toMatchObject({
        accountId: owner.id, custodianAccountId: owner.id,
      });
      const prepared = await bind('machines.presets.prepare');
      expect(prepared.statusCode, prepared.body).toBe(409);
      expect(prepared.json()).toMatchObject({ code: 'target_unavailable' });
    } finally { await app.close(); }
  });

  it.each(Object.entries(collectionIds))('confines Collection %s to its native sharing phases', async (operation, actionId) => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
      id: crypto.randomUUID(), accountId: account.id,
      metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }), metadataVersion: 1,
      dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), daemonState: null, daemonStateVersion: 0,
      installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
    } });
    const homeId = await getOrCreateServerIdentityId();
    const ref = { pluginId: 'example.documents', collectionId: 'documents', schemaVersion: 1, contractDigest: 'a'.repeat(43) };
    const address = { pluginId: ref.pluginId, collectionId: ref.collectionId, ownerAccountId: account.id, rowId: 'document' };
    const principal = { kind: 'account', accountId: 'recipient' };
    const source = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(),
      metadata: '{}', encryptionMode: 'plain' } });
    await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: source.id, data: 'source' } });
    const requestId = crypto.randomUUID();
    const resolveCurrentSessionMachine = async () => machine.id;
    const root = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id, serverIdentityId: homeId,
      authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId,
      machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId,
      requestEnvelopeDigest: 'a'.repeat(43),
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: source.id, starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId },
      sessionActionSource: { machineId: machine.id, installationId: machine.installationId! },
    }, { resolveCurrentSessionMachine });
    const verify = async (method: string, path: string, body?: unknown, effectActionId = actionId, routeInput = body) =>
      (await verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token, effectActionId,
        encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method, path, body, routeInput, resolveCurrentSessionMachine,
        machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId,
          target: root.binding.target, installationId: machine.installationId!, requestId: root.binding.requestId,
          method, path, body, privateKey: keys.secretKey }) })) !== null;
    expect(await verify('POST', PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { ref })).toBe(true);
    expect(await verify('GET', '/v1/account/encryption/currentness')).toBe(true);
    const readsRows = operation === 'get' || operation === 'put' || operation === 'setGrant';
    const repairsKeys = operation === 'get' || operation === 'list';
    const nativeRequests = [
      { path: collectionPaths.get, body: { ...address, readerContext: ref }, allowed: readsRows },
      { path: collectionPaths.sharedWithMe, body: { pluginId: ref.pluginId, collectionId: ref.collectionId,
        readerContext: ref, sharedWithTeamId: 'selected-team' }, allowed: operation === 'list' },
      { path: collectionPaths.put, body: { ...address, writerContext: ref, expectedRevision: 1,
        content: { t: 'plain', v: { note: 'Edited' } }, projection: { status: 'open' } }, allowed: operation === 'put' },
      { path: collectionPaths.grants, body: address, allowed: operation === 'listGrants' },
      { path: collectionPaths.setGrant, body: { ...address, principal, accessLevel: 'view', expectedRevision: 1 }, allowed: operation === 'setGrant' },
      { path: collectionPaths.revokeGrant, body: { ...address, principal }, allowed: operation === 'revokeGrant' },
      { path: collectionPaths.census, body: address, allowed: repairsKeys || operation === 'setGrant' },
      { path: collectionPaths.commitKeys, body: { ...address,
        expectedDataEncryptionKey: encodeBase64(new Uint8Array(SESSION_DATA_KEY_ENVELOPE_BYTES_V1)), recipientKeyEnvelopes: [] }, allowed: repairsKeys },
    ];
    for (const request of nativeRequests) expect(await verify('POST', request.path, request.body), request.path).toBe(request.allowed);
    expect(await verify('POST', '/v1/account/project-rows/list', {})).toBe(false);
    expect(await verify('POST', PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { ref }, collectionIds.get === actionId ? collectionIds.put : collectionIds.get)).toBe(false);
    expect(await verify('POST', PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { ref, extra: true })).toBe(false);
    expect(await verify('POST', PLUGIN_COLLECTION_CONTRACT_HTTP_PATH_V1, { ref }, actionId, { ref: { ...ref, collectionId: 'other' } })).toBe(false);
  });

  it.each([
    { actionId: 'session.spawn_new', hasProject: true, signedAccount: false }, { actionId: 'template.instantiate', hasProject: true, signedAccount: false },
    { actionId: 'session.spawn_new', hasProject: false, signedAccount: false }, { actionId: 'template.instantiate', hasProject: false, signedAccount: false },
    { actionId: 'session.spawn_new', hasProject: false, signedAccount: true },
  ] as const)('confines $actionId defaults reads with Project=$hasProject and signedAccount=$signedAccount', async ({ actionId, hasProject, signedAccount }) => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
      id: crypto.randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux',
        happyCliVersion: 'test', homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
      metadataVersion: 1, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      daemonState: null, daemonStateVersion: 0, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
    } });
    const homeId = await getOrCreateServerIdentityId();
    const sourceId = crypto.randomUUID();
    await db.projectSource.create({ data: { id: sourceId, name: 'Selected', createdByAccountId: account.id,
      owner: { kind: 'team', teamId: 'linked-team' }, audience: [], attachments: [] } });
    const creation = { executionTarget: { serverId: homeId, machineId: machine.id }, directory: { kind: 'path', path: '/repo' },
      projectContext: { projectRef: { serverId: homeId, projectKey: 'private' }, sourceRef: { serverId: homeId, sourceId } } };
    const selectedCreation = hasProject ? creation : { executionTarget: creation.executionTarget, directory: creation.directory };
    const input = actionId === 'session.spawn_new' ? selectedCreation : { creation: selectedCreation };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
      targets: { sessions: [], machines: [machine.id], environments: [] } };
    const token = await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(),
      label: { content: { t: 'plain', v: 'Scoped creation' }, recipients: [] }, grant });
    const principal = await auth.verifyPat(token.token);
    if (!principal.ok) throw new Error('Expected admitted API token');
    const root = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id, serverIdentityId: homeId,
      ...(signedAccount ? { authentication: { kind: 'account' as const, tokenEpoch: account.tokenEpoch } }
        : { principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant }), actionId,
      machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId: crypto.randomUUID(), requestEnvelopeDigest: 'a'.repeat(43) }, { input });
    const verify = async (method: string, path: string, body: unknown, effectActionId: string, routeInput = body) =>
      (await verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token, effectActionId,
        encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method, path, body, routeInput,
        machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId,
          target: root.binding.target, installationId: machine.installationId!, requestId: root.binding.requestId,
          method, path, ...(body === undefined ? {} : { body }), privateKey: keys.secretKey }) })) !== null;
    // The admitted installed signer can already spend the root's currentness purpose.
    if (actionId === 'session.spawn_new') expect(await verify('GET', '/v1/account/encryption/currentness', undefined, actionId)).toBe(true);
    expect(await verify('GET', `/v1/projects/sources/${sourceId}?serverId=${homeId}`, undefined, 'projects.sources.read')).toBe(hasProject);
    expect(await verify('GET', `/v1/projects/sources/sibling?serverId=${homeId}`, undefined, 'projects.sources.read')).toBe(false);
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'linked-team' }, 'teams.get')).toBe(hasProject);
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'sibling-team' }, 'teams.get')).toBe(false);
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'linked-team' }, 'teams.get', { v: 1, teamId: 'sibling-team' })).toBe(false);
    expect(await verify('POST', '/v1/home/governance/get', { projection: 'session_defaults' }, 'home.governance.get')).toBe(hasProject || signedAccount);
    expect(await verify('POST', '/v1/home/governance/get', {}, 'home.governance.get')).toBe(false);
    expect(await verify('POST', '/v1/account/project-rows/read', { key: { kind: 'project-session-defaults', ...creation.projectContext.projectRef } }, actionId)).toBe(false);
    expect(await verify('POST', '/v1/account/project-rows/mutate', {}, actionId)).toBe(false);
  });

  it.each(['teams.groups.create', 'teams.credentials.update', 'teams.credentials.externalKeys.create'] as const)(
    'prepares an authored label under the signed %s purpose', async actionId => {
      const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
      const keys = tweetnacl.sign.keyPair();
      const machine = await db.machine.create({ data: {
        id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
          homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
        metadataVersion: 1, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        daemonState: null, daemonStateVersion: 0, installationId: crypto.randomUUID(),
        installationPublicKey: new Uint8Array(keys.publicKey),
      } });
      const teamId = 'team';
      const id = crypto.randomUUID();
      const group = { v: 1, teamId, groupId: id, name: 'Group', requestKey: 'create-group' };
      const input = actionId === 'teams.groups.create' ? group
        : actionId === 'teams.credentials.update' ? { resourceId: id, expectedRevision: 0, displayName: 'Credential' }
          : { resourceId: id, teamMembershipId: 'member', keyId: id, label: 'External key' };
      const root = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id,
        serverIdentityId: await getOrCreateServerIdentityId(), authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
        actionId, machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId: crypto.randomUUID(),
        requestEnvelopeDigest: 'a'.repeat(43),
      }, { input });
      const verify = async (method: string, path: string, body?: unknown, effectActionId: string = actionId) =>
        (await verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token, effectActionId,
          encodedTarget: encodeExternalActionResolvedTargetV1(root.binding.target), method, path, body, routeInput: body,
          machineSignature: signExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId,
            target: root.binding.target, installationId: machine.installationId!, requestId: root.binding.requestId,
            method, path, ...(body === undefined ? {} : { body }), privateKey: keys.secretKey }) })) !== null;
      expect(await verify('GET', '/v1/account/encryption/currentness')).toBe(true);
      expect(await verify('POST', PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, { owner: { kind: 'team', teamId } })).toBe(true);
      expect(await verify('POST', PRIVATE_LABEL_RECIPIENT_CENSUS_PATH, { owner: { kind: 'account', accountId: account.id } })).toBe(false);
      expect(await verify('POST', '/v1/teams/credential-resources/get', { resourceId: id })).toBe(actionId !== 'teams.groups.create');
      expect(await verify('POST', '/v1/teams/credential-resources/get', { resourceId: id }, 'teams.credentials.get')).toBe(false);
      if (actionId === 'teams.groups.create') {
        const path = getActionSpec(actionId).serverTransport!.path;
        expect(await verify('POST', path, group)).toBe(false);
        expect(await verify('POST', path, { ...group, name: { content: { t: 'plain', v: group.name }, recipients: [] } })).toBe(true);
      }
  });

  it('confines demanded defaults to the selected row, Source and Team and refuses mutation', async () => {
    const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({ data: {
      id: crypto.randomUUID(), accountId: account.id, metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux',
        happyCliVersion: 'test', homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
      metadataVersion: 1, dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
      daemonState: null, daemonStateVersion: 0, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
    } });
    const homeId = await getOrCreateServerIdentityId();
    const input = { projectRef: { serverId: homeId, projectKey: 'selected' }, sourceRef: { serverId: homeId, sourceId: 'selected-source' }, primaryTeamId: 'selected-team' };
    await db.projectSource.create({ data: { id: input.sourceRef.sourceId, name: 'Selected', createdByAccountId: account.id,
      owner: { kind: 'team', teamId: 'linked-team' }, audience: [], attachments: [] } });
    const root = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id, serverIdentityId: homeId,
      authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId: 'projects.sessionDefaults.get',
      machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId: crypto.randomUUID(), requestEnvelopeDigest: 'a'.repeat(43) }, { input });
    const verify = async (method: string, path: string, body: unknown, effectActionId = root.binding.actionId, authorization = root, routeInput = body) =>
      (await verifyExternalActionDomainExecutionRequest({ authorizationToken: authorization.token, effectActionId,
        encodedTarget: encodeExternalActionResolvedTargetV1(authorization.binding.target), method, path, body, routeInput,
        machineSignature: signExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
          target: authorization.binding.target, installationId: machine.installationId!, requestId: authorization.binding.requestId,
          method, path, body, privateKey: keys.secretKey }) })) !== null;
    const row = { key: { kind: 'project-session-defaults', ...input.projectRef } };
    expect(await verify('POST', '/v1/account/project-rows/read', row)).toBe(true);
    expect(await verify('POST', '/v1/account/project-rows/read', { key: { ...row.key, projectKey: 'sibling' } })).toBe(false);
    expect(await verify('POST', '/v1/account/project-rows/list', {})).toBe(false);
    const mutation = { mutations: [{ key: row.key, expectedRevision: 'absent', content: null }], expectedRefs: [], topologyChange: false };
    expect(await verify('POST', '/v1/account/project-rows/mutate', mutation)).toBe(false);
    const sourcePath = `/v1/projects/sources/selected-source?serverId=${encodeURIComponent(homeId)}`;
    expect(await verify('GET', sourcePath, undefined, 'projects.sources.read')).toBe(true);
    expect(await verify('GET', sourcePath.replace('selected-source', 'sibling-source'), undefined, 'projects.sources.read')).toBe(false);
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'selected-team' }, 'teams.get')).toBe(true);
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'sibling-team' }, 'teams.get')).toBe(false);
    const homeSpec = getActionSpec('home.governance.get');
    const homeInput = { projection: 'session_defaults' };
    const homeRead = bindHomeDomainHttpRequestV1({ transport: homeSpec.serverTransport!, inputSchema: homeSpec.inputSchema, input: homeInput });
    expect(await verify(homeRead.method, homeRead.path, homeRead.body, 'home.governance.get', root, homeInput)).toBe(true);
    expect(await verify(homeRead.method, homeRead.path, homeRead.body, 'home.governance.get', root, {})).toBe(false);
    const linkedRoot = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id, serverIdentityId: homeId,
      authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId: 'projects.sessionDefaults.get',
      machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId: crypto.randomUUID(), requestEnvelopeDigest: 'b'.repeat(43) },
      { input: { projectRef: input.projectRef, sourceRef: input.sourceRef, sharedTeamIds: ['different-shared-team'] } });
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'linked-team' }, 'teams.get', linkedRoot)).toBe(true);
    expect(await verify('POST', '/v1/teams/get', { v: 1, teamId: 'different-shared-team' }, 'teams.get', linkedRoot)).toBe(false);
    const writeRoot = await auth.mintExternalActionExecutionAuthorization({ accountId: account.id, serverIdentityId: homeId,
      authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId: 'projects.organization.update',
      machineId: machine.id, target: { kind: 'machine', machineId: machine.id }, requestId: crypto.randomUUID(), requestEnvelopeDigest: 'c'.repeat(43) },
      { input: { projectRef: input.projectRef, expectedRevision: 'absent', sessionDefaults: { expectedRevision: 'absent', defaults: {} } } });
    expect(await verify('POST', '/v1/account/project-rows/mutate', mutation, 'projects.organization.update', writeRoot)).toBe(true);
  });

  it.each(['machines.presets.get', 'machines.isolation.set'] as const)('admits only the supporting preset read for %s', async (actionId) => {
    const account = await db.account.create({
      data: { publicKey: null, encryptionMode: 'plain' },
    });
    const keys = tweetnacl.sign.keyPair();
    const machine = await db.machine.create({
      data: {
        id: crypto.randomUUID(),
        accountId: account.id,
        metadata: encodePlainMachineStoredContent({
          host: 'controller',
          platform: 'linux',
          happyCliVersion: 'test',
          homeDir: '/home/controller',
          happyHomeDir: '/home/controller/.happier',
        }),
        metadataVersion: 1,
        dataEncryptionKey: decodeBase64(
          MACHINE_PLAIN_DATA_KEY_MARKER,
          'base64',
        ),
        daemonState: null,
        daemonStateVersion: 0,
        installationId: crypto.randomUUID(),
        installationPublicKey: new Uint8Array(keys.publicKey),
      },
    });
    const token = await auth.createToken(account.id, undefined, {
      kind: 'account',
      authority: 'present_user',
    });
    const homeId = await getOrCreateServerIdentityId();
    const app = Fastify().withTypeProvider<ZodTypeProvider>() as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    registerExternalActionRoutes(app, {
      dispatch: async () => ({
        kind: 'placement_error',
        code: 'target_unavailable',
      }),
    });
    try {
      const presetInput = { homeId, id: crypto.randomUUID() };
      const policy = { configuredSandboxes: { local: { provisioner: { pluginId: 'test.local', localId: 'vm' }, presetId: presetInput.id } },
        workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } };
      const input = actionId === 'machines.presets.get' ? presetInput : { machineId: machine.id, expectedMetadataVersion: 1,
        expectedPolicy: policy, policy };
      const minted = await app.inject({
        method: 'POST',
        url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
        headers: { authorization: `Bearer ${token}` },
        payload: {
          v: 1,
          machineId: machine.id,
          envelope: ExternalActionRequestEnvelopeV1Schema.parse({
            v: 1,
            requestId: crypto.randomUUID(),
            target: { kind: 'machine', machineId: machine.id },
            input,
          }),
        },
      });
      expect(minted.statusCode, minted.body).toBe(200);
      const root = ExternalActionExecutionAuthorizationV1Schema.parse(
        minted.json(),
      );
      const verify = async (path: string, body: unknown, effectActionId: string = actionId) => {
        let phase: string | undefined;
        const result = await verifyExternalActionDomainExecutionRequest({
          authorizationToken: root.token,
          effectActionId,
          encodedTarget: encodeExternalActionResolvedTargetV1(
            root.binding.target,
          ),
          method: 'POST',
          path,
          body,
          machineSignature: signExternalActionMachineRequestV1({
            authorizationToken: root.token,
            effectActionId,
            target: root.binding.target,
            installationId: machine.installationId!,
            requestId: root.binding.requestId,
            method: 'POST',
            path,
            body,
            privateKey: keys.secretKey,
          }),
          onRefusal: (refused) => {
            phase = refused;
          },
        });
        return {
          admitted:
            result !== null && result.principal.accountId === account.id,
          phase,
        };
      };
      const path = machinePresetActionEndpointPathV1('machines.presets.get');

      expect(await verify(path, presetInput)).toEqual({
        admitted: true,
        phase: undefined,
      });
      expect(
        await verify(
          machinePresetActionEndpointPathV1('machines.presets.archive'),
          presetInput,
        ),
      ).toEqual({ admitted: false, phase: 'verification_purpose' });
      expect(await verify(machinePresetActionEndpointPathV1('machines.presets.list'), { homeId })).toEqual({ admitted: false, phase: 'verification_purpose' });
      if (actionId === 'machines.isolation.set') {
        expect(await verify(path, { ...presetInput, homeId: 'another-home' })).toEqual({ admitted: false, phase: 'verification_purpose' });
        expect(await verify(path, presetInput, 'machines.roles.set')).toMatchObject({ admitted: false });
        const outsider = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const refused = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1(actionId),
          headers: { authorization: `Bearer ${outsiderToken}` }, payload: { v: 1, machineId: machine.id,
            envelope: { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id }, input } } });
        expect(refused.statusCode, refused.body).toBe(409);
        expect(refused.json()).toMatchObject({ code: 'target_unavailable' });
      }
    } finally {
      await app.close();
    }
  });
});
