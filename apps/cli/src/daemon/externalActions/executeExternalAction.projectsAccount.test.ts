import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { computeExternalActionRequestEnvelopeDigestV1, type SignedRootActionId } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1, type ExternalActionExecutionAuthorizationV1 }
  from '@happier-dev/protocol/actions/externalActionApi';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectAccountRowV1Schema, ProjectAccountRowMutationRequestV1Schema,
  buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { auth } from '../../../../server/sources/app/auth/auth';
import { verifyExternalActionDomainExecutionRequest, verifyExternalActionExecutionAuthorizationCurrentness,
  resolveExternalActionExecutionMachineAdmissionInTx }
  from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { db } from '../../../../server/sources/storage/db';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { updateSettings } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { prepareRequesterAccountActionContext } from "../sessionEncryption/requesterAccountActionProjection";
import { type RequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import type { JsonValue } from '@happier-dev/protocol';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployments';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1 } from '@happier-dev/protocol';
import { ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionMachineRpcParamsDigestV1, decodeDeploymentChildExecutionV1,
  encodeExternalActionResolvedTargetV1, verifyExternalActionMachineRequestV1,
  verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from '@/deployments/targets/ownServer/ownServerDeploymentHostRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import * as installationStore from '@/daemon/identity/store';

// Only database, HTTP, socket endpoints and installation I/O are substituted.
// Home token minting, signed verification, custody and Action semantics stay real.
const storage = vi.hoisted(() => {
  const account = { id: 'project-owner', status: 'active', tokenEpoch: 1, encryptionMode: 'plain' };
  const state: { publicKey: Uint8Array; revokedAt: Date | null; deploymentEnvironment: Readonly<{
    id: string; projectSourceId: string; controllerMachineId: string; deletedAt: null; deployerMode: 'members';
  }> | null } = { publicKey: new Uint8Array(), revokedAt: null, deploymentEnvironment: null };
  const machine = () => ({ id: 'project-machine', accountId: account.id, kind: 'persistent', active: true,
    installationId: 'project-installation', installationPublicKey: state.publicKey, revokedAt: state.revokedAt,
    metadata: encodePlainMachineStoredContent({}), daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    replacedByMachineId: null, account, accountGrants: [], teamGrants: [], groupGrants: [] });
  const reader = { $executeRaw: async () => 0,
    $queryRaw: async () => [{ statement_timeout: '0' }],
    $executeRawUnsafe: async () => 0,
    account: { findUnique: async () => account },
    deploymentEnvironment: { findUnique: async ({ where }: { where: { id: string } }) =>
      state.deploymentEnvironment?.id === where.id ? state.deploymentEnvironment : null },
    projectSource: { findUnique: async ({ where }: { where: { id: string } }) =>
      state.deploymentEnvironment?.projectSourceId === where.id
        ? { ...source, id: where.id, owner: { kind: 'account', accountId: account.id },
          defaultRef: null, subdir: null, attachments: [] } : null },
    machine: { findUnique: async () => machine(), findFirst: async () => machine(), findMany: async () => [machine()] },
    simpleCache: { findUnique: async () => ({ value: 'srv_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP' }) } };
  return { state, account, db: { ...reader, $transaction: async <T>(run: (tx: typeof reader) => Promise<T>) => run(reader) } };
});
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(), db: storage.db,
}));

const homeId = 'srv_PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP';
const profileId = 'project-local-profile';
const serverUrl = 'https://project-home.test';
const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'project-owner' })).toString('base64url')}.signature`;
const credentials = { token, encryption: null };
const target = { kind: 'machine' as const, machineId: 'project-machine' };
const source = { id: 'source/a', revision: 2, name: 'App', repository: {
  provider: { id: 'happier.scm.forge.github/github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git', visibility: 'public' as const },
  protocol: 'https' as const }, audience: [], createdByAccountId: 'project-owner' };

beforeAll(async () => {
  vi.stubEnv('HANDY_MASTER_SECRET', 'project-account-test-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
  storage.state.publicKey = installation.publicKey;
  await auth.init();
});
afterEach(() => { vi.restoreAllMocks(); storage.state.revokedAt = null; storage.state.deploymentEnvironment = null; storage.account.tokenEpoch = 1; });
afterAll(() => vi.unstubAllEnvs());

async function withHome(run: (currentness: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>) => Promise<void>) {
  await withTempDir('project-terminal-home-', async home => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    const currentness = await createRequesterCurrentnessSocketHarness();
    try {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
      reloadConfiguration();
      await updateSettings(settings => ({ ...settings, activeServerId: profileId, servers: { [profileId]: {
        id: profileId, name: 'Project Home', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({
          v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
          endpoints: [{ kind: 'https', url: serverUrl }] }),
      } } }));
      await run(currentness);
    } finally { await currentness.close(); env.restore(); reloadConfiguration(); }
  });
}

function httpBoundary(additionalResponse?: (method: string, path: string, body: unknown,
  headers: Readonly<Record<string, unknown>>) => Readonly<{ status: number; data: unknown }> | undefined) {
  const workspace = { id: 'workspace', serverId: homeId, machineId: target.machineId,
    rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
  const key = { kind: 'workspace-ref' as const, serverId: homeId, id: workspace.id };
  const rows = [ProjectAccountRowV1Schema.parse({ key, revision: 2, content: { t: 'plain', v: { key, value: workspace } } })];
  const admitted: { actionId: string; path: string; authority: string; kind: string }[] = [];
  async function request(method: string, url: string, body: unknown, headers: unknown) {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const record = headers && typeof headers === 'object' ? headers as Readonly<Record<string, unknown>> : {};
    const additional = additionalResponse?.(method, path, body, record);
    if (additional) return additional;
    if ('Authorization' in record) {
      expect(record.Authorization).toBe(`Bearer ${token}`);
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'project-owner' } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.workspace.forget': ['cli'] } },
      } }, version: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Ambient credential reached Project effect: ${path}`);
    }
    const field = (name: string) => typeof record[name] === 'string' ? record[name] as string : '';
    const proof = { authorizationToken: field(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER),
      effectActionId: field(EXTERNAL_ACTION_EFFECT_ACTION_HEADER), machineSignature: field(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER),
      encodedTarget: field(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER), method, path, body };
    const currentness = path.endsWith('/execution-authorization/verify');
    const verified = currentness ? await verifyExternalActionExecutionAuthorizationCurrentness({ ...proof, outerActionId: proof.effectActionId })
      : await verifyExternalActionDomainExecutionRequest(proof);
    if (!verified) return { status: 401, data: { error: 'invalid_token' } };
    expect(verified.principal.accountId).toBe('project-owner');
    if (currentness) return { status: 200, data: { ok: true } };
    expect('authentication' in verified.principal).toBe(true);
    admitted.push({ actionId: verified.binding.actionId, path, authority: verified.principal.authority,
      kind: 'authentication' in verified.principal ? verified.principal.authentication.kind : 'pat' });
    if (path === '/v1/account/project-rows/list') return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    if (path === '/v1/account/project-rows/read') return projectAccountRowReadResponse(rows, body);
    if (path === '/v1/account/project-rows/mutate') {
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = mutation.mutations.map(value => {
        const index = rows.findIndex(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(value.key));
        const revision = index < 0 ? -1 : rows[index]!.revision;
        expect(value.expectedRevision).toBe(revision < 0 ? 'absent' : revision);
        const row = ProjectAccountRowV1Schema.parse({ key: value.key, revision: revision + 1, content: value.content });
        if (index < 0) rows.push(row); else rows[index] = row;
        return row;
      });
      return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
    }
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (path === '/v1/machines') return { status: 200, data: [] };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/projects/execution/config/read') return { status: 200, data: { status: 'absent' } };
    if (parsed.pathname === '/v1/projects/sources') return { status: 200,
      data: method === 'GET' ? { ok: true, sources: [source], coverage: { complete: true, nextCursor: null } } : { ok: true, source, canManage: true } };
    if (parsed.pathname === '/v1/projects/sources/source%2Fa') return { status: 200,
      data: method === 'DELETE' ? { ok: true, sourceId: source.id, revision: 3 } : { ok: true, source, canManage: true } };
    throw new Error(`Unexpected signed Project effect: ${path}`);
  }
  vi.spyOn(axios, 'get').mockImplementation((url, config) => request('GET', String(url), undefined, config?.headers));
  vi.spyOn(axios, 'post').mockImplementation((url, body, config) => request('POST', String(url), body, config?.headers));
  vi.spyOn(axios, 'request').mockImplementation(config => request(String(config.method).toUpperCase(), String(config.url), config.data, config.headers));
  return { rows, admitted, request };
}

async function original(actionId: SignedRootActionId, input: Readonly<Record<string, JsonValue>>, kind: 'account' | 'terminal' = 'terminal',
  admittedMachineRole?: 'use' | 'manage') {
  const envelope = { v: 1 as const, requestId: `request-${actionId}`, target, input };
  const authentication = { kind, tokenEpoch: 1 };
  const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: 'project-owner', authentication,
    serverIdentityId: homeId, machineId: target.machineId, actionId, requestId: envelope.requestId,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target,
    ...(admittedMachineRole ? { admittedMachineRole } : {}) }, { input: envelope.input });
  return { envelope, authorization, principal: { accountId: 'project-owner', authentication,
    authority: kind === 'terminal' ? 'account_automation' as const : 'present_user' as const } };
}

async function run(actionId: SignedRootActionId, input: Readonly<Record<string, JsonValue>>, kind: 'account' | 'terminal' = 'terminal') {
  const request = await original(actionId, input, kind);
  expect(await verifyExternalActionExecutionAuthorizationCurrentness({ ...signedProof(request.authorization,
    'POST', bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId), { v: 1, effectActionId: actionId, target }),
    outerActionId: actionId }), 'fixture must have real current Home and Machine admission').not.toBeNull();
  const executor = (context?: RequesterAccountActionContext) => {
    const accountInput = { token, credentials: context?.credentials ?? credentials,
      serverId: profileId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: 'project-installation' };
    return createCliActionExecutorHarness({ ...accountInput, sessionId: 'cli-global', mode: 'plain', ctx: null,
      actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'project-fixture',
        getAccountSettings: () => context?.savedSecretOperationContext.readSnapshot()?.settings ?? null }),
      ...(context ? { savedSecretOperationContext: context.savedSecretOperationContext } : {}),
      projectWorkerAccountAction: createAccountServerActionDeps(accountInput).projectWorkerAction }).executor;
  };
  return executeExternalAction({ actionId, ...request, executionAuthorization: request.authorization,
    currentMachineId: target.machineId, currentServerId: profileId, currentServerHttpBaseUrl: serverUrl,
    currentInstallationId: 'project-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
    surface: kind === 'terminal' ? 'cli' : 'ui', resolveTarget: async () => target,
    verifyExecutionAuthorization: async () => storage.state.revokedAt === null, executor: executor(),
    prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
      purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'project-installation',
      installationPrivateKey: installation.secretKey, serverId: profileId, serverIdentityId: homeId,
      serverHttpBaseUrl: serverUrl, ownCredentials: credentials, isCurrent: async () => storage.state.revokedAt === null,
      createExecutor: executor }),
  });
}

function signedProof(authorization: ExternalActionExecutionAuthorizationV1, method: string, path: string, body?: unknown) {
  const headers = createExternalActionAuthorizedRequestHeaders({ authorization, effectActionId: authorization.binding.actionId,
    target, installationId: 'project-installation', privateKey: installation.secretKey, method, path, body });
  return { authorizationToken: headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]!,
    effectActionId: headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]!, machineSignature: headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]!,
    encodedTarget: headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]!, method, path, body };
}

describe('paired terminal Project Account Actions through CLI custody and signed Home verification', () => {
  it.each([
    ['account', 'published'], ['terminal', 'published'], ['account', 'unknown'], ['terminal', 'unknown'],
  ] as const)('retains the admitted %s deployment root through real review-child signing with %s content mode', async (kind, contentMode) => withHome(async currentness => {
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment.serverId = homeId;
    environment.environment.controllerMachineId = target.machineId;
    environment.environment.buildMachineId = 'deployment-member';
    storage.state.deploymentEnvironment = { id: environment.environment.id,
      projectSourceId: environment.environment.projectSourceId, controllerMachineId: target.machineId,
      deletedAt: null, deployerMode: 'members' };
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['deployment-member'];
    link.members = [{ machineId: 'deployment-member', installationId: 'member-installation', state: 'active' }];
    // Private content from another retained target is not part of this native
    // runtime demand. No Artifact response is installed for this reference.
    environment.targetLinks.push({ targetLink: { ...link, id: 'unrelated-target', contentArtifactId: 'unrelated-private-content' }, content: {} });
    const candidate = createDeploymentReceiptDetailV1();
    candidate.content.machines = [...link.machines];
    candidate.content.buildMachineId = 'deployment-member';
    candidate.content.machineResults = [];
    const input = { serverId: homeId, environmentId: environment.environment.id, targetLinkId: link.id,
      expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
      requestKey: 'review-child', contentArtifactId: candidate.deployment.contentArtifactId,
      contentHeaderVersion: candidate.deployment.contentHeaderVersion, contentBodyVersion: candidate.deployment.contentBodyVersion };
    const machineAdmission = await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: storage.account.id,
      machineId: target.machineId, actionId: 'deployments.deploy',
      callerAuthority: kind === 'terminal' ? 'account_automation' : 'present_user' });
    if (machineAdmission.kind !== 'admitted') throw new Error(`Deployment fixture Machine admission: ${machineAdmission.code}`);
    const request = await original('deployments.deploy', input, kind, machineAdmission.role);
    const reviewJob = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.deploy',
      input, machineId: 'deployment-member', installationId: 'member-installation' });
    const documents = new Map<string, Readonly<{ header: unknown; content: unknown }>>([
      [environment.environment.contentArtifactId, { header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Deployment' }, content: environment.content }],
      [link.contentArtifactId, { header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Runtime' }, content: environment.targetLinks[0].content }],
      [input.contentArtifactId, { header: createDeploymentReceiptArtifactHeaderV1('Candidate', candidate.content), content: candidate.content }],
    ]);
    const memberKeys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
    const deploymentHttpPaths: string[] = [];
    const codecAdmissions: boolean[] = [];
    httpBoundary((method, path, _body, headers) => {
      deploymentHttpPaths.push(path);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      // A generic Account lookup could resolve this legacy response, but a
      // deployment child may not borrow ambient requester authority for it.
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path.startsWith(`/v1/deployments/environments/${environment.environment.id}?`)) return { status: 200,
        data: { ok: true, environment: environment.environment, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
      if (path === '/v1/machines/deployment-member') {
        const header = headers[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER];
        const proof = typeof header === 'string' ? decodeDeploymentChildExecutionV1(header,
          String(headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] ?? '')) : null;
        const execution = proof?.externalActionExecution;
        const admitted = !Object.keys(headers).some(name => name.toLowerCase() === 'authorization')
          && headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === request.authorization.token
          && headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] === 'deployments.deploy'
          && headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER] === encodeExternalActionResolvedTargetV1(target)
          && proof !== null && proof.archiveOrigin === undefined && proof.paramsPresent
          && proof.paramsDigest === computeExternalActionMachineRpcParamsDigestV1(reviewJob)
          && execution !== undefined && execution.authorization.token === request.authorization.token
          && sameStrictJsonValue(execution.authorization.binding, request.authorization.binding)
          && sameStrictJsonValue(execution.deploymentChildRouting, projectDeploymentChildRoutingV1(reviewJob))
          && execution.installationId === 'project-installation'
          && verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
            target: execution.target, installationId: execution.installationId, method: proof.method, requestId: proof.requestId,
            paramsPresent: proof.paramsPresent, paramsDigest: proof.paramsDigest,
            deploymentChildRouting: execution.deploymentChildRouting, signature: execution.machineSignature, publicKey: installation.publicKey })
          && verifyExternalActionMachineRequestV1({ authorizationToken: request.authorization.token, effectActionId: 'deployments.deploy',
            target, installationId: 'project-installation', requestId: request.envelope.requestId, method, path,
            deploymentChildExecution: proof, signature: String(headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''),
            publicKey: installation.publicKey });
        codecAdmissions.push(admitted);
        if (!admitted) return { status: 403, data: { error: 'access_denied' } };
        return { status: 200, data: { machine: {
        id: 'deployment-member', kind: 'persistent', active: true, installationId: 'member-installation',
        revokedAt: null, replacedByMachineId: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        installationPublicKey: Buffer.from(memberKeys.publicKey).toString('base64'),
        ...(contentMode === 'published' ? { storageMode: 'plain', access: {
          custodian: { accountId: 'project-owner', displayName: 'Project Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
        } } : {}),
        } } };
      }
      const document = documents.get(decodeURIComponent(new URL(path, serverUrl).pathname.split('/').at(-1)!));
      if (path.startsWith('/v1/artifacts/') && document) return { status: 200, data: {
        id: decodeURIComponent(new URL(path, serverUrl).pathname.split('/').at(-1)!), ownerAccountId: 'project-owner', access: 'owner',
        publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(document.header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      } };
      return undefined;
    });
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'project-installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(installation.secretKey).toString('base64url') });
    const signedChildren: unknown[] = [];
    currentness.server.on('connection', socket => socket.on('rpc-call', (raw: Readonly<{
      method: string; requestId: string; params: unknown; externalActionExecution: unknown }>, acknowledge: (result: unknown) => void) => {
      const execution = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
      const job = DeploymentChildRpcV1Schema.parse(raw.params);
      const valid = verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
        requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
        target: execution.target, installationId: execution.installationId, event: SOCKET_RPC_EVENTS.CALL, method: raw.method, requestId: raw.requestId,
        params: raw.params, deploymentChildRouting: execution.deploymentChildRouting,
        publicKey: installation.publicKey, signature: execution.machineSignature });
      signedChildren.push({ valid, job, method: raw.method, rootRequestId: execution.authorization.binding.requestId });
      acknowledge({ ok: true, result: { ok: false, errorCode: 'deployment_executor_unavailable', error: 'deployment_executor_unavailable' } });
    }));
    const executor = (context?: RequesterAccountActionContext) => {
      const runtime = createOwnServerDeploymentRuntimeForHost({
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
        credentials: context?.credentials ?? credentials,
        serverId: homeId, serverHttpBaseUrl: serverUrl, machineId: target.machineId,
        async acquirePluginRuntimeRegistryLease() {
          const lease = pluginReloadController.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('No installed plugin runtime');
          return lease;
        } });
      const deployment = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
        credentials: context?.credentials ?? credentials,
        serverId: homeId, serverHttpBaseUrl: serverUrl, machineId: target.machineId, runtime,
        ...(context ? { savedSecretOperationContext: context.savedSecretOperationContext } : {}) });
      return createCliActionExecutorHarness({ token, credentials: context?.credentials ?? credentials, sessionId: 'cli-global',
        mode: 'plain', ctx: null, serverId: profileId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
        externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: 'project-installation',
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'deployment-root-fixture',
          getAccountSettings: () => context?.savedSecretOperationContext.readSnapshot()?.settings ?? null }),
        ...(context ? { savedSecretOperationContext: context.savedSecretOperationContext } : {}),
      }, deployment).executor;
    };
    const result = await executeExternalAction({ actionId: 'deployments.deploy', ...request,
      executionAuthorization: request.authorization, currentMachineId: target.machineId, currentServerId: profileId,
      currentServerHttpBaseUrl: serverUrl, currentInstallationId: 'project-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
      surface: kind === 'terminal' ? 'cli' : 'ui', resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      verifyExecutionAuthorization: async ({ authorization }) => await verifyExternalActionExecutionAuthorizationCurrentness({
        ...signedProof(authorization, 'POST', bindExternalActionExecutionAuthorizationVerifyHttpPathV1(authorization.binding.actionId),
          { v: 1, ...(authorization.binding.admittedMachineRole
            ? { admittedMachineRole: authorization.binding.admittedMachineRole } : {}) }), outerActionId: authorization.binding.actionId,
      }) !== null, executor: executor(),
      prepareRequesterAccountContext: value => prepareRequesterAccountActionContext({ ...value, purpose: { kind: 'external_action' },
        machineId: target.machineId, installationId: 'project-installation', installationPrivateKey: installation.secretKey,
        serverId: profileId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: credentials,
        isCurrent: async () => storage.state.revokedAt === null, createExecutor: executor }),
    });
    expect(result, JSON.stringify({ result, deploymentHttpPaths, signedChildren, codecAdmissions })).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: contentMode === 'published' ? 'deployment_executor_unavailable' : 'machine_content_key_unavailable',
    } } });
    expect(codecAdmissions.length).toBeGreaterThan(0);
    expect(codecAdmissions.every(Boolean)).toBe(true);
    expect(deploymentHttpPaths).not.toContain('/v1/account/encryption');
    if (contentMode === 'unknown') {
      expect(signedChildren).toEqual([]);
      return;
    }
    expect(signedChildren).toEqual([{ valid: true, method: `deployment-member:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`,
      rootRequestId: request.envelope.requestId,
      job: { v: 1, kind: 'review', actionId: 'deployments.deploy', input, machineId: 'deployment-member', installationId: 'member-installation' } }]);
  }));

  it('reads Sources as the original paired terminal actor', async () => withHome(async () => {
    const boundary = httpBoundary();
    const result = await run('projects.sources.read', { serverId: homeId, sourceId: source.id });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: {
      execution: { ok: true, result: { ok: true, source } } } });
    expect(boundary.admitted).toContainEqual({ actionId: 'projects.sources.read', path: `/v1/projects/sources/source%2Fa?serverId=${homeId}`,
      kind: 'terminal', authority: 'account_automation' });
  }));

  it('pins an accepted workspace with portable Home through the real Action executor', async () => withHome(async () => {
    const boundary = httpBoundary();
    const result = await run('projects.workspace.update', { serverId: homeId, workspaceId: 'workspace', pinned: true });
    expect(result, JSON.stringify(result))
      .toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { ok: true, organization: { pinned: true } } } } });
    expect(boundary.rows.find(row => row.key.kind === 'project-organization')?.content).toMatchObject({ t: 'plain', v: { value: { pinned: true } } });
  }));

  it('lists private Projects with current signed requester custody', async () => withHome(async () => {
    const boundary = httpBoundary();
    const result = await run('projects.list', { serverId: homeId });
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { items: [{ workspaceAddress: { serverId: homeId, workspaceId: 'workspace' } }] } } } });
    expect(boundary.admitted.map(row => row.path)).toContain('/v1/account/authoring-memory');
  }));

  it('keeps visibility, personal context and Forget on the original private Account row owner', async () => withHome(async () => {
    const boundary = httpBoundary();
    const key = { kind: 'project-organization' as const, serverId: homeId, projectKey: 'project' };
    boundary.rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 2, content: { t: 'plain', v: { key, value: {
      hidden: false, pinned: true, promptStack: [{ id: 'entry', ref: { kind: 'doc', artifactId: 'doc', serverId: homeId }, enabled: true,
        placement: 'system_append' }],
    } } } }));
    const visibility = await run('projects.visibility.set', { target: { serverId: homeId, projectKey: 'project' }, expectedRevision: 2, hidden: true });
    expect(visibility, JSON.stringify(visibility)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { ok: true, row: { hidden: true, pinned: true }, revision: 3 } } } });
    const context = await run('projects.context.update', { target: { serverId: homeId, projectKey: 'project' }, expectedRevision: 3,
      intent: { kind: 'detach', entryId: 'entry' } });
    expect(context, JSON.stringify(context)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { ok: true, row: { hidden: true, pinned: true, promptStack: [] }, revision: 4 } } } });
    const forget = await run('projects.workspace.forget', { serverId: homeId, workspaceId: 'workspace' });
    expect(forget, JSON.stringify(forget)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { ok: true, workspaceId: 'workspace' } } } });
    expect(boundary.rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
    expect(boundary.rows.find(row => row.key.kind === 'project-organization')?.content).toMatchObject({ t: 'plain', v: { value: { pinned: true } } });
    expect(boundary.admitted.every(row => row.kind === 'terminal' && row.authority === 'account_automation')).toBe(true);
  }));

  it('reads worker and desired service preferences through their original signed config-row client', async () => withHome(async () => {
    const boundary = httpBoundary();
    for (const actionId of ['projects.worker.preferences.get', 'projects.service.placement.get'] as const) {
      const result = await run(actionId, { workspace: { serverId: homeId, refId: 'workspace' },
        ...(actionId === 'projects.service.placement.get' ? { serviceName: 'web' } : {}) });
      expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { status: 'ready' } } } });
    }
    expect(boundary.admitted.map(row => row.path)).toContain('/v1/projects/execution/config/read');
    expect(boundary.admitted.every(row => row.kind === 'terminal')).toBe(true);
  }));

  it('translates an admitted local Source Home to the signed portable Home', async () => withHome(async () => {
    const boundary = httpBoundary();
    expect(await run('projects.sources.read', { serverId: profileId, sourceId: source.id }))
      .toMatchObject({ kind: 'response', response: { execution: { ok: true, result: { ok: true, source } } } });
    expect(boundary.admitted[0]?.path).toBe(`/v1/projects/sources/source%2Fa?serverId=${homeId}`);
  }));

  it('spends each Source root only on its own metadata method and Home', async () => {
    const cases = [
      ['projects.sources.list', 'GET', `/v1/projects/sources?serverId=${homeId}`, { serverId: homeId }, undefined],
      ['projects.sources.read', 'GET', `/v1/projects/sources/source%2Fa?serverId=${homeId}`, { serverId: homeId, sourceId: source.id }, undefined],
      ['projects.sources.create', 'POST', '/v1/projects/sources', { serverId: homeId, requestKey: 'create', name: source.name, repository: source.repository }],
      ['projects.sources.update', 'PATCH', '/v1/projects/sources/source%2Fa', { serverId: homeId, sourceId: source.id, expectedRevision: 2, patch: { name: 'Renamed' } }],
      ['projects.sources.delete', 'DELETE', '/v1/projects/sources/source%2Fa', { serverId: homeId, sourceId: source.id, expectedRevision: 2 }],
    ] as const;
    for (const [actionId, method, path, input] of cases) {
      const { authorization } = await original(actionId, input);
      const body = method === 'GET' ? undefined : input;
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, method, path, body)))
        .toMatchObject({ binding: { actionId }, principal: { accountId: 'project-owner', authority: 'account_automation',
          authentication: { kind: 'terminal' } } });
      const foreignPath = method === 'GET' ? path.replace(homeId, 'srv_foreign') : path;
      const foreignBody = method === 'GET' ? undefined : { ...input, serverId: 'srv_foreign' };
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, method, foreignPath, foreignBody))).toBeNull();
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, 'GET', '/v2/account/settings'))).toBeNull();
      expect(await verifyExternalActionDomainExecutionRequest(signedProof(authorization, 'POST', '/v1/account/project-rows/mutate', {}))).toBeNull();
      const tampered = { ...signedProof(authorization, method, path, body), method: method === 'GET' ? 'DELETE' : 'GET' };
      expect(await verifyExternalActionDomainExecutionRequest(tampered)).toBeNull();
    }
  });

  it('refuses foreign Home before any private Project or Source effect', async () => withHome(async () => {
    const boundary = httpBoundary();
    for (const actionId of ['projects.sources.read', 'projects.workspace.update', 'projects.list'] as const) {
      const input = { serverId: 'srv_foreign', ...(actionId === 'projects.sources.read' ? { sourceId: source.id }
        : actionId === 'projects.workspace.update' ? { workspaceId: 'workspace', pinned: true } : {}) };
      expect(await run(actionId, input)).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'server_scope_mismatch' } } });
    }
    expect(await run('projects.worker.preferences.get', { workspace: { serverId: 'srv_foreign', refId: 'workspace' } }))
      .toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'server_target_mismatch' } } });
    expect(boundary.admitted).toEqual([]);
  }));

  it('limits worker and service roots to strict config requests without lending generic Account authority', async () => {
    const address = { serverId: homeId, refId: 'workspace' };
    const mutation = { address, expectedRevision: 'absent', content: { t: 'plain', v: {
      enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {},
    } } };
    for (const actionId of ['projects.worker.preferences.get', 'projects.worker.preferences.set', 'projects.worker.preferences.reset',
      'projects.service.placement.get', 'projects.service.placement.set'] as const) {
      const { authorization } = await original(actionId, { workspace: address });
      const verify = (method: string, path: string, body?: unknown) =>
        verifyExternalActionDomainExecutionRequest(signedProof(authorization, method, path, body));
      expect(await verify('GET', '/v1/account/encryption')).not.toBeNull();
      expect(await verify('POST', '/v1/projects/execution/config/read', { address })).not.toBeNull();
      const write = await verify('POST', '/v1/projects/execution/config/mutate', mutation);
      if (actionId.endsWith('.get')) expect(write).toBeNull(); else expect(write).not.toBeNull();
      expect(await verify('POST', '/v1/projects/execution/config/read', { address, unrelated: true })).toBeNull();
      expect(await verify('POST', '/v1/projects/execution/config/mutate', { ...mutation, expectedRevision: -1 })).toBeNull();
      expect(await verify('GET', '/v2/account/settings')).toBeNull();
      expect(await verify('GET', '/v1/account/encryption?unrelated=true')).toBeNull();
      expect(await verify('POST', '/v1/account/project-rows/mutate', {})).toBeNull();
    }
  });

  it('rejects retired credential and Machine custody on a correctly signed Source read', async () => {
    const { authorization } = await original('projects.sources.read', { serverId: homeId, sourceId: source.id });
    const proof = signedProof(authorization, 'GET', `/v1/projects/sources/source%2Fa?serverId=${homeId}`);
    expect(await verifyExternalActionDomainExecutionRequest(proof)).not.toBeNull();
    storage.account.tokenEpoch = 2;
    expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
    storage.account.tokenEpoch = 1;
    storage.state.revokedAt = new Date();
    expect(await verifyExternalActionDomainExecutionRequest(proof)).toBeNull();
  });
});
