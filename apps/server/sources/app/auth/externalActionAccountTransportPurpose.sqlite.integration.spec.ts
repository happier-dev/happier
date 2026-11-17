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
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1,
  encodeExternalActionResolvedTargetV1,
  signExternalActionMachineRequestV1,
} from '@happier-dev/protocol/actions';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
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
