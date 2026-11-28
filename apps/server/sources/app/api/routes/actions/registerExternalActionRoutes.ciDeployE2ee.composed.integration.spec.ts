import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '../../../../../../cli/src/api/artifacts/accountArtifactStore';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '../../../../../../cli/src/api/clientCompatibility/cliClientCompatibility';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { executeExternalAction } from '../../../../../../cli/src/daemon/externalActions/executeExternalAction';
import { createHostActionOperationRuntime } from '../../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import * as installationStore from '../../../../../../cli/src/daemon/identity/store';
import { withConfiguredDaemonTestHome } from '../../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonDeploymentActionDeps } from '../../../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createOwnServerDockerBoundary } from '../../../../../../cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from '../../../../../../cli/src/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import * as ownServerDeploymentTarget from '../../../../../../cli/src/deployments/targets/ownServer/ownServerDeploymentTarget';
import { readRequesterDeploymentArtifactStore } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createFilesystemEffectAdmission } from '../../../../../../cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createAdmittedPluginRuntimeFixture } from '../../../../../../cli/src/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '../../../../../../cli/src/plugins/runtime/reload/singleton';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '../../../../../../cli/src/server/serverProfiles';
import { createCliActionDeps } from '../../../../../../cli/src/session/actions/createCliActionDeps';
import { registerAccountEncryptionRoutes } from '../account/registerAccountEncryptionRoutes';
import { registerAutomationActionIndexRoutes } from '../automations/registerAutomationActionIndexRoutes';
import { createUnavailableActionTransportDeps } from '../../../../../../cli/src/testkit/actionTransportDeps';
import { projectSourceRoutes } from '../projects/projectSourceRoutes';
import { registerProjectAccountRowRoutes } from '../projects/registerProjectAccountRowRoutes';
import { machinesRoutes } from '../machines/machinesRoutes';
import Fastify, { type FastifyRequest } from 'fastify';
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
  computeDeploymentTransitionRequestDigestV1,
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1,
  DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
  DeploymentReceiptResultV1Schema,
  type DeploymentTransitionInputV1,
} from '@happier-dev/protocol';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol/machines/machineStoredContent';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openExternalActionRequestV2, openExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import {
  createExternalActionDaemonDispatchResponse,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  ExternalActionDaemonDispatchRequestSchema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { decodeDeploymentChildExecutionV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { featuresRoutes } from '../features/featuresRoutes';
import { admitDeploymentStoredContentInTx } from '@/app/deployments/deploymentStoredContent';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { registerAccountApiTokenManagementRoutes } from '../auth/registerAccountApiTokenManagementRoutes';
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
import { createDeploymentEnvironmentV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployments';
import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

function importCli(specifier: string): Promise<unknown> {
  return import(specifier);
}

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
    const createContent = async (kind: string, headerKind: string, body: unknown) => {
      const key = nacl.randomBytes(32);
      const header = { kind: headerKind, title: 'CI app' };
      const value = { body: JSON.stringify(body) };
      const artifact = await createArtifact({
        actorUserId: account.id,
        artifactId: crypto.randomUUID(),
        kind,
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
      return artifact.artifact.id;
    };
    // Home validates plain Environment content; E2EE content stays opaque to it.
    const plainContent = createDeploymentEnvironmentV1().content;
    if (plainContent.t !== 'plain') throw new Error('Expected plain Environment fixture');
    const artifactId = await createContent(DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, 'deployment-environment.v1', plainContent.v);
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
        contentArtifactId: artifactId,
        contentHeaderVersion: 1,
        contentBodyVersion: 1,
      }),
    );
    if (!environment.ok) throw new Error(environment.error);
    if (!controller.installationId) throw new Error('Missing controller installation');
    const targetContent = createDeploymentTargetLinkV1().content;
    if (targetContent.t !== 'plain') throw new Error('Expected plain Target Link fixture');
    // Seed the native target at the storage boundary, before the CI token can act.
    const target = await db.deploymentTargetLink.create({ data: {
      environmentId: environment.environmentId, createdByAccountId: account.id,
      role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
      contentArtifactId: await createContent(DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, 'deployment-target-link.v1', targetContent.v),
      contentHeaderVersion: 1, contentBodyVersion: 1,
      machines: { create: [{ machineId: controller.id, installationId: controller.installationId, position: 0, state: 'active' }] },
    } });
    const { revision: environmentRevision } = await db.deploymentEnvironment.update({
      where: { id: environment.environmentId }, data: { runtimeTargetLinkId: target.id }, select: { revision: true },
    });
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
    const wrappingSecret = nacl.randomBytes(32);
    const contentPublicKey = privacyKit.encodeBase64(contentKeys.publicKey);
    const encryption = mode === 'e2ee' ? { access: wrapApiTokenEncryptionAccessV1({
      context: { serverIdentityId: serverId, accountId: account.id, tokenId, contentPublicKey },
      contentPrivateKey: contentKeys.secretKey, wrappingSecret, randomBytes: nacl.randomBytes,
    }) } : undefined;
    const pat = await auth.createApiToken({
      accountId: account.id,
      tokenId,
      label,
      grant,
      ...(encryption ? { encryption } : {}),
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
      environmentRevision,
      target,
      pat,
      tokenId,
      accountKey: machineKey,
      contentKeys,
      source: source.source,
      installationPublicKey: installationKeys.publicKey,
      installationPrivateKey: installationKeys.secretKey,
      artifactId,
      apiTokenContentAccess: { contentPublicKey, wrappingSecret: Buffer.from(wrappingSecret).toString('base64url') },
    };
  }

  async function exerciseCiActivate(mode: 'plain' | 'e2ee', source: 'registry' | 'build', refuseLocalActivate = false) {
    const f = await fixture(mode);
    const foreign = await fixture(mode);
    const sibling = await db.deploymentEnvironment.create({ data: {
      createdByAccountId: f.account.id, projectSourceId: f.source.id, protection: 'nonProduction',
      purpose: 'standard', deployerMode: 'managers', controllerMachineId: f.controller.id, buildMachineId: f.controller.id,
      referencedSavedSecretRevisions: [], contentArtifactId: f.artifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
    } });
    const installationId = f.controller.installationId;
    if (!installationId) throw new Error('Missing controller installation');
    const action = DEPLOYMENT_DEPLOY_ACTION_ID_V1;
    const target = { kind: 'machine' as const, machineId: f.controller.id };
    const directory = await mkdtemp(join(tmpdir(), 'ci-activate-'));
    const app = Fastify({ logger: false });
    const io = new Server();
    try {
      const tools = join(directory, 'tools');
      const docker = await createOwnServerDockerBoundary(tools, { engineId: 'ci-activate' });
      const image = 'example/ci-app:review';
      if (source === 'build') {
        await docker.registerBuildResult('app', 'review');
        await writeFile(join(directory, 'Dockerfile'), 'FROM scratch\n');
      } else {
        await docker.registerImage('app', 'review', { registryReferences: [image] });
      }
      await writeFile(join(directory, 'compose.yaml'), JSON.stringify({
        services: { app: source === 'build' ? { build: '.' } : { image } },
      }));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git('init');
      git('remote', 'add', 'origin', 'https://github.com/owner/app.git');
      git('add', 'compose.yaml', ...(source === 'build' ? ['Dockerfile'] : []));
      git('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.test', 'commit', '-m', 'Deploy fixture');
      const sha = git('rev-parse', 'HEAD');
      const credentials = {
        token: await auth.createToken(f.account.id, undefined, { kind: 'account', authority: 'present_user' }),
        encryption: mode === 'e2ee' ? { type: 'dataKey' as const, machineKey: f.contentKeys.secretKey,
          publicKey: f.contentKeys.publicKey } : null,
      };
      const childReads: Array<{ kind: string; phase?: string; status: number }> = [];
      const childRefusals: unknown[] = [];
      let execute: ExternalActionForwardRpcCall;
      const forwarded = vi.fn<ExternalActionForwardRpcCall>((request) => execute(request));
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
      enableAuthentication(typed);
      registerDeploymentRoutes(typed);
      artifactsRoutes(typed);
      registerAccountEncryptionRoutes(typed);
      featuresRoutes(typed);
      const readChildRouting = (request: FastifyRequest) => {
        if (request.method !== 'GET' || request.url !== `/v1/machines/${f.controller.id}`) return;
        const header = request.headers[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER];
        const token = request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
        if (typeof header !== 'string' || typeof token !== 'string') return;
        return decodeDeploymentChildExecutionV1(header, token)?.externalActionExecution.deploymentChildRouting;
      };
      if (refuseLocalActivate) {
        // The signed read is decoded before this hook and authenticated after it.
        typed.addHook('preValidation', async (request, reply) => {
          const routing = readChildRouting(request);
          if (routing?.kind !== 'member' || routing.phase !== 'activate') return;
          return reply.code(403).send({ error: 'credential_scope_denied' });
        });
        const createTarget = ownServerDeploymentTarget.createOwnServerDeploymentTargetForHost;
        vi.spyOn(ownServerDeploymentTarget, 'createOwnServerDeploymentTargetForHost').mockImplementation(input => {
          const dispatch = input.dispatchMember;
          if (!dispatch) return createTarget(input);
          // Observe the dispatch refusal before the rollout projects receipt details.
          return createTarget({ ...input, async dispatchMember(member) {
            try { return await dispatch(member); }
            catch (error) {
              if (member.phase === 'activate' && error instanceof Error) childRefusals.push(error.cause);
              throw error;
            }
          } });
        });
      }
      typed.addHook('onResponse', async (request, reply) => {
        const routing = readChildRouting(request);
        if (routing) childReads.push({ kind: routing.kind, ...(routing.kind === 'member' ? { phase: routing.phase } : {}),
          status: reply.statusCode });
      });
      machinesRoutes(typed);
      registerAutomationActionIndexRoutes(typed);
      projectSourceRoutes(typed);
      registerProjectAccountRowRoutes(typed);
      registerAccountApiTokenManagementRoutes(typed);
      registerExternalActionRoutes(typed, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc: forwarded }) });
      io.attach(typed.server);
      const origin = await typed.listen({ host: '127.0.0.1', port: 0 });
      await withConfiguredDaemonTestHome({ prefix: 'ci-activate-controller-', env: {
        HAPPIER_SERVER_URL: origin, HAPPIER_ACTIVE_SERVER_ID: f.serverId, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
      } }, async () => {
        const profile = await addServerProfile({ name: 'ci-home', serverUrl: origin, webappUrl: origin });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
          descriptor: { v: 1, homeServerIdentityId: f.serverId, canonicalServerUrl: origin, revision: 1,
            endpoints: [{ kind: 'https', url: origin }] } });
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
          installationId, publicKey: Buffer.from(f.installationPublicKey).toString('base64url'),
          privateKey: Buffer.from(f.installationPrivateKey).toString('base64url') });
        const key = { kind: 'workspace-ref', serverId: f.serverId, id: 'ci-checkout' } as const;
        const graphKey = { kind: 'relationship-graph' } as const;
        const cipher = createProjectAccountRowCipherV1({ mode, material: credentials.encryption, randomBytes: nacl.randomBytes });
        const seeded = await typed.inject({ method: 'POST', url: '/v1/account/project-rows/mutate',
          headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), authorization: `Bearer ${credentials.token}` },
          payload: { mutations: [{ key, expectedRevision: 'absent', content: cipher.seal({ key, value: {
            id: key.id, serverId: f.serverId, machineId: f.controller.id, rootPath: directory, createdAtMs: 1,
            source: { sourceId: f.source.id, revision: f.source.revision },
          } }) }, { key: graphKey, expectedRevision: 'absent', content: cipher.seal({ key: graphKey, value: { relationships: [] } }) }],
          expectedRefs: [], topologyChange: true } });
        expect(seeded.statusCode, seeded.body).toBe(200);
        expect(seeded.json()).toMatchObject({ status: 'updated' });

        const runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
          runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        try {
          const admission = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => f.serverId,
            resolveHostIdentity: async () => ({ machineId: f.controller.id, installationId, custodianAccountId: f.account.id }) });
          const resolveRequesterIdentity: Parameters<typeof createOwnServerDeploymentRuntimeForHost>[0]['resolveRequesterIdentity'] = async context => {
            const requester = await admission.resolveActionRequester!(
              context as Parameters<NonNullable<typeof admission.resolveActionRequester>>[0]);
            try { return requester.identity; } finally { await requester.dispose(); }
          };
          const host = { credentials, serverId: f.serverId, serverHttpBaseUrl: origin, machineId: f.controller.id,
            acquirePluginRuntimeRegistryLease: () => runtime.controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => runtime.registry }),
            resolveRequesterIdentity };
          const native = createOwnServerDeploymentRuntimeForHost(host);
          const { actionAutomations } = createCliActionDeps({ token: credentials.token, credentials,
            sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: f.serverId, serverHttpBaseUrl: origin });
          const operations = createHostActionOperationRuntime({ serverId: f.serverId, machineId: f.controller.id,
            custodyBinding: { serverId: f.serverId, installationId }, resolveAccountId: async () => f.account.id });
          execute = async ({ callParams }) => {
            const request = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
            const result = await runWithServerHttpBaseUrl(origin, () => executeExternalAction({
              ...request, currentMachineId: f.controller.id, currentInstallationId: installationId,
              currentServerId: f.serverId, currentServerHttpBaseUrl: origin, currentAccountId: f.account.id,
              externalActionMachineRequestPrivateKey: f.installationPrivateKey,
              verifyExecutionAuthorization: proof => verifyExternalActionExecutionAuthorizationCurrent({ ...proof,
                installationId, privateKey: f.installationPrivateKey, serverHttpBaseUrl: origin }),
              resolveTarget: async () => target,
              resolveEncryption: async () => ({ serverIdentityId: f.serverId,
                material: { type: 'dataKey', machineKey: f.accountKey } }),
              executor: { async execute(actionId, input, context) {
                const accountArtifacts = readRequesterDeploymentArtifactStore(context?.externalActionExecutionAuthorization);
                if (!accountArtifacts) throw new Error('Expected scoped CI artifact custody');
                const deps = createDaemonDeploymentActionDeps({ ...host, accountArtifacts, runtime: native });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                  actionAutomations, runActionOperation: operations.runActionOperation });
                return executor.execute(actionId, input, context);
              } },
            }));
            return { ok: true, result: result.kind === 'invalid_request'
              ? result : createExternalActionDaemonDispatchResponse(result.prepared) };
          };
          const submit = (environmentId: string, controllerId: string) => {
            const requestId = crypto.randomUUID();
            const destination = { kind: 'machine' as const, machineId: controllerId };
            const input = { serverId: f.serverId, environmentId, sha, requestKey: requestId };
            const binding = { serverIdentityId: f.serverId, accountId: f.account.id, credentialId: f.tokenId,
              actionId: action, requestId, target: destination };
            const material = { type: 'dataKey' as const, machineKey: f.accountKey };
            const payload = mode === 'plain' ? { v: 1 as const, requestId, target: destination, input }
              : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
                binding, input, material, apiTokenContentAccess: f.apiTokenContentAccess, randomBytes: nacl.randomBytes });
            return typed.inject({ method: 'POST', url: `/v1/actions/${action}`,
              headers: { authorization: `Bearer ${f.pat.token}` }, payload }).then(response => ({
                response,
                openExecution: () => payload.v === 1 ? response.json().execution
                  : openExternalActionResponseV2({ envelope: response.json(), request: payload, binding, material }),
              }));
          };
          const { response: siblingDenied } = await submit(sibling.id, f.controller.id);
          expect(siblingDenied.statusCode, siblingDenied.body).toBe(403);
          expect(siblingDenied.json()).toMatchObject({ error: 'credential_scope_denied' });
          const { response: foreignScopeDenied } = await submit(foreign.environmentId, f.controller.id);
          expect(foreignScopeDenied.statusCode, foreignScopeDenied.body).toBe(403);
          expect(foreignScopeDenied.json()).toMatchObject({ error: 'credential_scope_denied' });
          const { response: foreignMachineDenied } = await submit(foreign.environmentId, foreign.controller.id);
          if (mode === 'plain') {
            expect(foreignMachineDenied.json()).toMatchObject({ execution: { ok: false, errorCode: 'target_not_local' } });
          } else {
            expect(foreignMachineDenied.statusCode).toBe(409);
            expect(foreignMachineDenied.json()).toMatchObject({ code: 'target_not_local' });
          }
          expect(forwarded).not.toHaveBeenCalled();
          const submitted = await submit(f.environmentId, f.controller.id);
          expect(submitted.response.statusCode).toBe(200);
          const receipt = await db.deployment.findFirst({ where: { environmentId: f.environmentId } });
          const execution = submitted.openExecution();
          if (refuseLocalActivate) {
            expect(childReads.filter(read => read.kind === 'member' && read.phase === 'activate'))
              .toEqual([{ kind: 'member', phase: 'activate', status: 403 }]);
            const dockerCalls = await docker.readInvocations();
            expect(dockerCalls.filter(call => call.args.includes('up')
              || (call.args[0] === 'buildx' && call.args[1] === 'bake'))).toEqual([]);
            expect(receipt).toMatchObject({ state: 'failed' });
            expect(execution).toMatchObject({ ok: false, errorCode: 'machine_unavailable',
              details: { failure: { code: 'machine_unavailable', phase: 'activate' } } });
            expect(childRefusals).toEqual([expect.objectContaining({ ok: false, errorCode: 'machine_unavailable',
              details: { machineId: f.controller.id, status: 403, reason: 'http_refused' } })]);
            return;
          }
          expect(execution, JSON.stringify({ receipt: receipt?.state, execution, native: await docker.readFailures() }))
            .toMatchObject({ ok: true, result: { state: 'succeeded' } });
          expect(receipt).toMatchObject({ state: 'succeeded' });
          if (!receipt?.contentArtifactId) throw new Error('Expected settled receipt content');
          const artifact = await runWithServerHttpBaseUrl(origin, () => createCredentialedAccountArtifactStore(credentials)
            .read(receipt.contentArtifactId!, { prepareRecipients: false, includeSharedAudience: false }));
          const persisted = readDeploymentReceiptArtifactV1({ contentArtifactId: receipt.contentArtifactId,
            contentHeaderVersion: receipt.contentHeaderVersion, contentBodyVersion: receipt.contentBodyVersion }, artifact);
          expect(persisted).toMatchObject({ ok: true, content: { sourceIntent: { kind: 'repository', sha } } });
          expect(childReads.filter(read => read.kind === 'member' && read.phase === 'activate'))
            .toEqual([{ kind: 'member', phase: 'activate', status: 200 }]);
          const dockerCalls = await docker.readInvocations();
          expect(dockerCalls.some(call => call.args.includes('up'))).toBe(true);
          if (source === 'build') {
            expect(childReads.filter(read => read.kind === 'build')).toEqual([{ kind: 'build', status: 200 }]);
            expect(dockerCalls.some(call => call.args[0] === 'buildx' && call.args[1] === 'bake'
              && !call.args.includes('--print'))).toBe(true);
            expect(persisted).toMatchObject({ ok: true, content: { ownServer: {
              imageArchives: [{ holder: { machineId: f.controller.id, installationId } }],
            } } });
          }
        } finally {
          await runtime.dispose();
        }
      });
    } finally {
      await new Promise<void>((resolve) => { io.close(() => resolve()); });
      await app.close();
      // A native subprocess can finish writing its fixture files during teardown.
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  it.each([['plain', 'registry'], ['e2ee', 'registry'], ['plain', 'build'], ['e2ee', 'build']] as const)(
    'activates a %s exact-SHA scoped CI Deploy from a %s image on the admitted installation',
    (mode, source) => exerciseCiActivate(mode, source), 120_000);

  it('settles a failed receipt without native effects when Home refuses the local Activate child',
    () => exerciseCiActivate('plain', 'registry', true), 120_000);

  it.each(['plain', 'e2ee'] as const)('admits and settles a %s exact-SHA CI deploy without granting a wider read', async (mode) => {
    const f = await fixture(mode);
    const forwarded: unknown[] = [];
    const statuses: Array<{ path: string; status: number }> = [];
    let origin: string;
    let custodyStep = 'daemon not reached';
    const forwardRpc: ExternalActionForwardRpcCall = async ({ callParams }) => {
      const request = ExternalActionDaemonDispatchRequestSchema.parse(callParams);
      const binding = request.executionAuthorization?.binding;
      forwarded.push({ v: request.envelope.v, machineId: binding?.machineId,
        environmentId: binding?.environmentId, accountEncryptionMode: binding?.accountEncryptionMode });
      // Replace Socket.IO only for this diagnostic. The scoped token, envelope,
      // installed proof, signed Home read and Account Artifact opener stay real.
      if (!request.executionAuthorization || !f.controller.installationId) {
        custodyStep = 'controller admission absent';
        throw new Error(custodyStep);
      }
      const root = request.executionAuthorization;
      const envelope = request.envelope;
      const opened = envelope.v === 2 ? openExternalActionRequestV2({ envelope,
        binding: { serverIdentityId: f.serverId, accountId: f.account.id, credentialId: f.tokenId,
          actionId: 'deployments.deploy', requestId: 'ci-run-1', target: root.binding.target },
        material: { type: 'dataKey', machineKey: f.accountKey }, projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 }) : null;
      custodyStep = 'exact controller envelope';
      if (envelope.v === 2 && !opened?.apiTokenContentAccess) throw new Error(custodyStep);
      expect(envelope.v === 1 ? envelope.input : opened?.input)
        .toMatchObject({ environmentId: f.environmentId, sha: 'a'.repeat(40) });

      const { projectExternalActionRequesterHttpAuthorization } = await importCli('../../../../../../cli/src/api/externalActionExecutionAuthorization') as
        typeof import('../../../../../../cli/src/api/externalActionExecutionAuthorization');
      const { prepareApiTokenDeploymentAccountProjection, readRequesterDeploymentArtifactStore } = await importCli('../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection') as
        typeof import('../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection');
      const { retainApiTokenDeploymentContentAccess } = await importCli('../../../../../../cli/src/auth/apiTokenDeploymentCustody') as
        typeof import('../../../../../../cli/src/auth/apiTokenDeploymentCustody');
      const projected = await projectExternalActionRequesterHttpAuthorization({
        authorization: root, serverId: f.serverId, serverIdentityId: f.serverId, serverHttpBaseUrl: origin,
        installationId: f.controller.installationId, privateKey: f.installationPrivateKey, rootAdmitted: true,
        target: root.binding.target,
      });
      custodyStep = 'installed HTTP proof';
      if (!projected) throw new Error(custodyStep);
      // The daemon preserves the signed HTTP projector's immutable descriptors
      // on an extensible invocation before attaching optional token custody.
      const invocation = Object.defineProperties({ ...projected }, Object.getOwnPropertyDescriptors(projected));
      const disposeKey = opened?.apiTokenContentAccess
        ? retainApiTokenDeploymentContentAccess(invocation, opened.apiTokenContentAccess) : undefined;
      custodyStep = 'envelope access retained';
      try {
        const scope = await prepareApiTokenDeploymentAccountProjection(invocation);
        custodyStep = 'same-token custody projection';
        if (!scope) throw new Error(custodyStep);
        try {
          const read = await invocation.requesterAccountProjection?.readArtifact({ serverId: f.serverId, artifactId: f.artifactId },
            { authorization: invocation });
          custodyStep = 'exact Environment Artifact read';
          expect(read).toMatchObject({ artifactId: f.artifactId,
            document: { header: { kind: 'deployment-environment.v1' }, body: expect.any(String) } });
          custodyStep = 'Environment Artifact opened';
          const candidateId = root.binding.deploymentCandidatePublication?.contentArtifactId;
          const store = readRequesterDeploymentArtifactStore(invocation);
          const http = invocation.requesterHttpProjection;
          custodyStep = 'exact candidate publication authorized';
          if (!candidateId || !store || !http) throw new Error(custodyStep);
          const authHeaders: NonNullable<Parameters<typeof store.create>[0]['authorizationHeaders']> = async proof => {
            const headers = await http.createRequestHeaders({ ...proof, effectActionId: root.binding.actionId });
            if (!headers) throw new Error('CI deployment HTTP proof absent');
            return headers;
          };
          const receiptTitle = 'CI exact-SHA Deploy';
          const receiptContent = createDeploymentReceiptDetailV1().content;
          const receiptHeader = createDeploymentReceiptArtifactHeaderV1(receiptTitle, receiptContent);
          const artifact = await runWithServerHttpBaseUrl(origin, () => store.create({
            artifactId: candidateId, header: receiptHeader, body: JSON.stringify(receiptContent),
            authorizationHeaders: authHeaders,
          }));
          custodyStep = 'candidate Artifact published';
          const refusal = await inTx(tx => admitDeploymentStoredContentInTx(tx, f.account.id,
            { kind: 'account', accountId: f.account.id }, { contentArtifactId: artifact.artifactId,
              contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion },
            DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1));
          if (refusal) {
            const stored = await db.artifact.findUnique({ where: { id: candidateId }, select: { accountId: true, kind: true } });
            const path = '/v1/features/authenticated';
            const headers = await http.createRequestHeaders({ method: 'GET', path, effectActionId: root.binding.actionId });
            const response = headers ? await typed.inject({ method: 'GET', url: path, headers }) : null;
            custodyStep = 'candidate Artifact refused: ' + JSON.stringify({ code: refusal.error, kind: stored?.kind,
              owned: stored?.accountId === f.account.id, featuresStatus: response?.statusCode,
              featuresError: response?.statusCode === 200 ? undefined : response?.json().error });
            throw new Error(custodyStep);
          }
          custodyStep = 'candidate Artifact admitted';
          const post = async (path: string, body: unknown) => typed.inject({
            method: 'POST', url: path, headers: { ...await authHeaders({ method: 'POST', path, body }), 'content-type': 'application/json' },
            payload: JSON.stringify(body),
          });
          const path = `/v1/deployments/environments/${f.environmentId}`;
          const actionOperationId = crypto.randomUUID();
          const admission = await post(`${path}/deploy`, {
            serverId: f.serverId, environmentId: f.environmentId, expectedRevision: f.environmentRevision,
            targetLinkId: f.target.id, expectedTargetLinkRevision: f.target.revision, requestKey: '1-1', actionOperationId,
            contentArtifactId: candidateId, contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion,
          });
          custodyStep = `Receipt admission: ${admission.statusCode} ${admission.json().error ?? ''}`;
          const admitted = DeploymentReceiptResultV1Schema.parse(admission.json());
          if (!admitted.ok || !('deploymentId' in admitted)) throw new Error(custodyStep);
          const transition = async (expectedRevision: number, state: 'running' | 'succeeded') => {
            custodyStep = `preparing ${state} Receipt content`;
            const resource = await runWithServerHttpBaseUrl(origin, () => store.readForUpdate(candidateId, {
              authorizationHeaders: authHeaders, prepareRecipients: false, includeSharedAudience: false,
            }));
            if (!resource) throw new Error(custodyStep);
            const prepared = await runWithServerHttpBaseUrl(origin, () => resource.prepareJsonUpdate({
              header: receiptHeader, body: JSON.stringify(receiptContent),
            }));
            if (!prepared.ok) throw new Error(custodyStep);
            const body: Omit<DeploymentTransitionInputV1, 'proof'> = {
              serverId: f.serverId, environmentId: f.environmentId, deploymentId: admitted.deploymentId,
              actionOperationId, expectedRevision, machineId: f.controller.id, installationId: root.binding.installationId,
              ...(state === 'running' ? { kind: 'stage' as const, state }
                : { kind: 'settle' as const, state, expectedTargetLinkRevision: f.target.revision }),
              contentArtifactId: candidateId, contentHeaderVersion: resource.artifact.revision.headerVersion,
              contentBodyVersion: resource.artifact.revision.bodyVersion, contentUpdate: prepared.mutation,
            };
            const proof = signMachineInstallationProof({ privateKey: f.installationPrivateKey, payload: {
              version: 1, machineId: body.machineId, installationId: body.installationId, accountId: f.account.id,
              deploymentTransition: { serverId: body.serverId, environmentId: body.environmentId, deploymentId: body.deploymentId,
                actionOperationId, expectedRevision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) },
            } });
            await runWithServerHttpBaseUrl(origin, () => prepared.assertCurrent());
            const response = await post(`${path}/deployments/${admitted.deploymentId}/transitions`, { ...body, proof });
            const result = response.json();
            const stored = response.statusCode === 200 ? undefined
              : await db.artifact.findUniqueOrThrow({ where: { id: candidateId }, select: { kind: true, headerVersion: true } });
            custodyStep = `Receipt ${state}: ${JSON.stringify({ status: response.statusCode, error: result.error,
              wireKind: prepared.mutation.kind, stored })}`;
            expect({ status: response.statusCode, result }).toMatchObject({ status: 200,
              result: { ok: true, state, deploymentRevision: expectedRevision + 1 } });
          };
          await transition(admitted.deploymentRevision, 'running');
          await transition(admitted.deploymentRevision + 1, 'succeeded');
          custodyStep = 'exact-SHA Receipt settled';
        } finally { scope.dispose(); }
      } finally { disposeKey?.(); }
      throw new Error('deployment effect boundary');
    };
    const io = new Server();
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    enableAuthentication(typed);
    typed.addHook('onSend', async (req, reply, payload) => {
      const path = req.url.split('?')[0]!;
      if (path.startsWith('/v1/artifacts') || path.endsWith('/encryption-access') || path === '/v1/features/authenticated') {
        statuses.push({ path, status: reply.statusCode });
      }
      return payload;
    });
    registerDeploymentRoutes(typed);
    artifactsRoutes(typed);
    featuresRoutes(typed);
    registerAccountApiTokenManagementRoutes(typed);
    registerExternalActionRoutes(typed, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc }) });
    io.attach(typed.server);
    origin = await typed.listen({ host: '127.0.0.1', port: 0 });
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
      expect({ status: full.statusCode, body: full.json() }).toEqual({ status: 403, body: { error: 'present_user_required' } });

      // The read controller places the submission; E2EE seals it with that target.
      const target = { kind: 'machine' as const, machineId: read.json().controllerMachineId };
      const input = { serverId: f.serverId, environmentId: f.environmentId, sha: 'a'.repeat(40), requestKey: '1-1' };
      const payload = mode === 'plain' ? { v: 1, requestId: 'ci-run-1', target, input }
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
          binding: { serverIdentityId: f.serverId, accountId: f.account.id, credentialId: f.tokenId,
            actionId: 'deployments.deploy', requestId: 'ci-run-1', target },
          input, material: { type: 'dataKey', machineKey: f.accountKey },
          apiTokenContentAccess: f.apiTokenContentAccess,
          randomBytes: (length) => nacl.randomBytes(length) });
      await typed.inject({ method: 'POST', url: '/v1/actions/deployments.deploy', headers, payload });
      expect(forwarded).toEqual([{ v: mode === 'plain' ? 1 : 2, machineId: f.controller.id,
        environmentId: f.environmentId, accountEncryptionMode: mode }]);

      expect(custodyStep, JSON.stringify(statuses)).toBe('exact-SHA Receipt settled');
      expect(statuses).toEqual(expect.arrayContaining([
        { path: `/v1/artifacts/${f.artifactId}`, status: 200 },
        { path: '/v1/artifacts', status: 200 },
      ]));
      const keyAccess = statuses.filter(({ path }) => path === '/v1/auth/api-tokens/encryption-access');
      expect(keyAccess).toEqual(mode === 'e2ee' ? [{ path: '/v1/auth/api-tokens/encryption-access', status: 200 }] : []);
      await auth.revokeApiToken({ accountId: f.account.id, tokenId: f.tokenId });
      expect((await controllerRead(f.environmentId)).statusCode).toBe(401);
    } finally {
      await new Promise<void>((resolve) => { io.close(() => resolve()); });
      await typed.close();
    }
  });
});
