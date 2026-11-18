import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { Server } from 'socket.io';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import {
  API_TOKEN_FULL_GRANT_V1,
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  sealSessionDataKeyBundleV0,
  sealEncryptedDataKeyEnvelopeV1,
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
} from '@happier-dev/protocol';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol/machines/machineStoredContent';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ExternalActionDaemonDispatchRequestSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { auth } from '@/app/auth/auth';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import {
  createExternalActionDaemonDispatcher,
  type ExternalActionForwardRpcCall,
} from '@/app/api/socket/externalActionDispatcher';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import {
  preparePlainAccountApiTokenLabel,
  prepareE2eeAccountApiTokenLabel,
} from '@/testkit/privateLabelFixture';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createDeploymentEnvironmentV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

// Composed hop: the real bearer verifier, persisted API token, grant evaluator,
// Environment read route, external Action ingress and dispatcher decide what a
// scoped CI token can do. Only the controller daemon socket call is a boundary.
describe('Deploy from CI with an Environment-scoped API token (integration)', () => {
  let harness: LightSqliteHarness;

  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-ci-deploy-e2ee-',
      initAuth: true,
      initEncrypt: true,
      env: {
        AUTH_REQUIRED_LOGIN_PROVIDERS: '',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      },
    });
  }, 120_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    // Each case owns a fresh Account in this file's temporary database.
    harness.resetEnv();
  });
  afterAll(async () => {
    await harness.close();
  });

  async function fixture(mode: 'plain' | 'e2ee') {
    const serverId = await getOrCreateServerIdentityId();
    const contentKeys = nacl.box.keyPair();
    const account = await db.account.create({
      data: {
        encryptionMode: mode,
        ...(mode === 'e2ee'
          ? createSignedAccountContentBinding(contentKeys.publicKey)
          : {}),
      },
    });
    const machineKey = nacl.randomBytes(32);
    const installationKeys = nacl.sign.keyPair();
    const metadata = { host: 'ci-controller', platform: 'linux' };
    const controller = await db.machine.create({
      data: {
        id: crypto.randomUUID(),
        accountId: account.id,
        installationId: crypto.randomUUID(),
        installationPublicKey: new Uint8Array(installationKeys.publicKey),
        active: true,
        metadata:
          mode === 'plain'
            ? encodePlainMachineStoredContent(metadata)
            : privacyKit.encodeBase64(
                new Uint8Array(
                  await sealSessionDataKeyBundleV0(metadata, machineKey),
                ),
              ),
        dataEncryptionKey:
          mode === 'plain'
            ? privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
            : new Uint8Array(
                sealEncryptedDataKeyEnvelopeV1({
                  dataKey: machineKey,
                  recipientPublicKey: contentKeys.publicKey,
                  randomBytes: nacl.randomBytes,
                }),
              ),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: {
          externalActionExecutionAuthorization: { protocolVersions: [1] },
        },
      },
    });
    const source = await inTx((tx) =>
      createProjectSourceInTx(tx, account.id, {
        serverId,
        requestKey: crypto.randomUUID(),
        name: 'CI app',
        audience: [],
        repository: {
          provider: {
            id: 'github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
          },
          repository: {
            nameWithOwner: 'owner/app',
            cloneUrl: 'https://github.com/owner/app.git',
          },
          protocol: 'https',
        },
      }),
    );
    if (!source.ok) throw new Error(source.error);
    const key = nacl.randomBytes(32);
    const header = { kind: 'deployment-environment.v1', title: 'CI app' };
    // Home validates plain Environment content; E2EE content stays opaque to it.
    const plainContent = createDeploymentEnvironmentV1().content;
    if (plainContent.t !== 'plain') throw new Error('Expected plain Environment fixture');
    const value = { body: JSON.stringify(mode === 'plain' ? plainContent.v : { name: 'CI app' }) };
    const artifact = await createArtifact({
      actorUserId: account.id,
      artifactId: crypto.randomUUID(),
      kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
      header:
        mode === 'plain'
          ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(header))
          : new Uint8Array(await sealSessionDataKeyBundleV0(header, key)),
      body:
        mode === 'plain'
          ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
          : new Uint8Array(await sealSessionDataKeyBundleV0(value, key)),
      dataEncryptionKey:
        mode === 'plain'
          ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
          : new Uint8Array(
              sealEncryptedDataKeyEnvelopeV1({
                dataKey: key,
                recipientPublicKey: contentKeys.publicKey,
                randomBytes: nacl.randomBytes,
              }),
            ),
    });
    if (!artifact.ok) throw new Error(artifact.error);
    const environment = await inTx((tx) =>
      createDeploymentEnvironmentInTx(tx, account.id, {
        serverId,
        requestKey: crypto.randomUUID(),
        projectSourceId: source.source.id,
        protection: 'nonProduction',
        purpose: 'standard',
        deployerMode: 'managers',
        controllerMachineId: controller.id,
        buildMachineId: controller.id,
        contentArtifactId: artifact.artifact.id,
        contentHeaderVersion: 1,
        contentBodyVersion: 1,
      }),
    );
    if (!environment.ok) throw new Error(environment.error);
    const tokenId = crypto.randomUUID();
    // The product's Deploy from CI preset: exact Actions, one Environment, no approval.
    const grant = ApiTokenGrantV1Schema.parse({
      ...API_TOKEN_FULL_GRANT_V1,
      actions: {
        families: [],
        ids: ['deployments.deploy', 'action.operations.get'],
      },
      targets: {
        sessions: [],
        machines: [],
        environments: [environment.environmentId],
      },
      approve: false,
      create: null,
    });
    const label =
      mode === 'plain'
        ? await preparePlainAccountApiTokenLabel(account.id, 'Staging CI')
        : await prepareE2eeAccountApiTokenLabel(
            account.id,
            tokenId,
            'Staging CI',
          );
    const pat = await auth.createApiToken({
      accountId: account.id,
      tokenId,
      label,
      grant,
      deployment: {
        serverId,
        environmentId: environment.environmentId,
        deployApproval: 'automatic',
      },
    });
    return {
      serverId,
      account,
      controller,
      environmentId: environment.environmentId,
      pat,
      tokenId,
      accountKey: machineKey,
    };
  }

  it.each(['plain', 'e2ee'] as const)('places a %s CI deploy through the scoped controller read without a wider read', async (mode) => {
    const f = await fixture(mode);
    const forwarded: unknown[] = [];
    const forwardRpc: ExternalActionForwardRpcCall = async ({ callParams }) => {
      const request = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
      const binding = request.executionAuthorization?.binding;
      forwarded.push({ v: request.envelope.v, machineId: binding?.machineId,
        environmentId: binding?.environmentId, accountEncryptionMode: binding?.accountEncryptionMode });
      // The controller daemon is the boundary; its execution is not under test here.
      throw new Error('controller boundary');
    };
    const io = new Server();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    registerDeploymentRoutes(typed);
    registerExternalActionRoutes(typed, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc }) });
    io.attach(typed.server);
    await typed.listen({ host: '127.0.0.1', port: 0 });
    try {
      const headers = { authorization: `Bearer ${f.pat.token}` };
      const controllerRead = (environmentId: string, serverId = f.serverId) => typed.inject({ method: 'GET',
        url: `/v1/deployments/environments/${encodeURIComponent(environmentId)}/controller?serverId=${serverId}`, headers });
      // A fresh runner knows only the URL, the token and the step's serverId.
      const read = await controllerRead(f.environmentId);
      expect({ status: read.statusCode, body: read.json() }).toEqual({ status: 200, body: { ok: true,
        serverId: f.serverId, environmentId: f.environmentId, controllerMachineId: f.controller.id } });
      // Outside the grant, the answer is the same whether or not that Environment exists.
      const other = await controllerRead('environment-outside-the-grant');
      expect({ status: other.statusCode, body: other.json() }).toMatchObject({ status: 403,
        body: { ok: false, error: 'deployment_access_denied' } });
      const elsewhere = await controllerRead(f.environmentId, `srv_${'f'.repeat(32)}`);
      expect({ status: elsewhere.statusCode, body: elsewhere.json() }).toMatchObject({ status: 404,
        body: { ok: false, error: 'deployment_unavailable' } });
      // The full Environment read stays closed to the scoped token.
      const full = await typed.inject({ method: 'GET',
        url: `/v1/deployments/environments/${f.environmentId}?serverId=${f.serverId}`, headers });
      expect(full.statusCode).toBeGreaterThanOrEqual(400);
      expect(full.body).not.toContain(f.controller.id);

      // The read controller places the submission; E2EE seals it with that target.
      const target = { kind: 'machine' as const, machineId: read.json().controllerMachineId };
      const input = { serverId: f.serverId, environmentId: f.environmentId, sha: 'a'.repeat(40), requestKey: '1-1' };
      const payload = mode === 'plain' ? { v: 1, requestId: 'ci-run-1', target, input }
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
          binding: { serverIdentityId: f.serverId, accountId: f.account.id, credentialId: f.tokenId,
            actionId: 'deployments.deploy', requestId: 'ci-run-1', target },
          input, material: { type: 'dataKey', machineKey: f.accountKey },
          randomBytes: (length) => nacl.randomBytes(length) });
      await typed.inject({ method: 'POST', url: '/v1/actions/deployments.deploy', headers, payload });
      expect(forwarded).toEqual([{ v: mode === 'plain' ? 1 : 2, machineId: f.controller.id,
        environmentId: f.environmentId, accountEncryptionMode: mode }]);

      await auth.revokeApiToken({ accountId: f.account.id, tokenId: f.tokenId });
      expect((await controllerRead(f.environmentId)).statusCode).toBe(401);
    } finally {
      await new Promise<void>((resolve) => { io.close(() => resolve()); });
      await typed.close();
    }
  });
});
