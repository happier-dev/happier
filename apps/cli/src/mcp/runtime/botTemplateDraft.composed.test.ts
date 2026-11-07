import axios from 'axios';
import nacl from 'tweetnacl';
import { createExternalActionHomeProcessForTests } from '../../../../server/sources/testkit/externalActionExecution.testkit.mjs';
import { prepareExternalActionRequesterAccountAuthorizationWithEnvelope } from '@/api/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { AccountSettingsSchema, ArtifactJsonUpdateHttpInputV1Schema, decodePlainArtifactStoredContent,
  FeaturesResponseSchema, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { ArtifactAccessGrantsListResponseV1Schema, ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1, SessionMetadataOwnerPatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createDaemonSessionAccountActionExecutor } from '@/daemon/agentRuntime/createDaemonSessionAccountActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonExternalActionExecution } from '@/daemon/externalActions/execution';
import { createDaemonShutdownCancellationDomains } from '@/daemon/startup/shutdownCancellationDomains';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareRequesterSessionBootstrap, type RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as credentialStorage from '@/persistence';
import type { StoredCredentials } from '@/persistence';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createAccountEncryptionCurrentnessFixture, createMutableApiSessionClientFixture,
  createSessionRecordFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { configuration } from '@/configuration';
import { createSessionDaemonAuthorityFixture } from './sessionDaemonAuthority.testkit';

afterEach(() => vi.restoreAllMocks());

// Unmounted daemon capabilities must fail loudly if this Account-only path
// reaches them. No internal implementation is replaced on the exercised path.
function unmounted<T>(name: string): T {
  const unavailable = () => { throw new Error(`Unexpected daemon capability: ${name}`); };
  return new Proxy(unavailable, { get: unavailable }) as T;
}

it.each(['credentialed_host', 'installed_daemon', 'requester_daemon', 'requester_e2ee', 'signed_daemon'] as const)('saves a private template from the restricted Agent Session tool through %s', async host => {
  const accountId = 'template-author';
  const sessionId = 'c000000000000000000000007';
  const serverId = configuration.activeServerId;
  const origin = 'https://template-agent.test';
  let token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const encryption = host === 'requester_e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } : null;
  const mode = encryption ? 'e2ee' : 'plain';
  const settings = AccountSettingsSchema.parse({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1 }) });
  const policy = { getAccountSettings: () => settings, getActionsSettings: () => settings.actionsSettingsV1 };
  const metadata = { host: 'author', path: '/workspace' };
  const owner = createSessionOwnerMetadataV1({ metadata });
  if (!owner.ok) throw new Error('Invalid owner fixture');
  const sharedMetadata = projectSessionSharedMetadataV1({ metadata, agentState: null });
  let row = createSessionRecordFixture({ id: sessionId, ownerAccountId: accountId, encryptionMode: mode,
    share: null, metadataLayoutVersion: 1, dataEncryptionKey: null,
    metadata: encryption ? encodeBase64(encryptLegacy(sharedMetadata, encryption.secret)) : JSON.stringify(sharedMetadata),
    ownerMetadata: encryption ? sealSessionOwnerMetadataEnvelopeV1({ material: encryption, ownerMetadata: owner.ownerMetadata,
      randomBytes: length => new Uint8Array(length).fill(23) }) : createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) });
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
  const installation = { version: 1 as const, installationId: 'template-installation', createdAt: 1,
    publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') };
  const home = host === 'signed_daemon' ? await createExternalActionHomeProcessForTests({
    accountId, machineId: 'template-machine', serverIdentityId: 'srv_template_home',
    installationId: installation.installationId, installationPublicKey: keys.publicKey, authentication: 'present_user',
    session: { id: sessionId, metadataLayoutVersion: 1, metadata: row.metadata!, ownerMetadata: row.ownerMetadata,
      agentState: row.agentState ?? null, metadataVersion: row.metadataVersion, agentStateVersion: row.agentStateVersion ?? 0 },
    dispatch: async () => { throw new Error('Unexpected Home dispatch'); },
  }) : null;
  if (home) token = home.token;
  const credentials: StoredCredentials = { token, encryption };
  if (host === 'installed_daemon' || host === 'signed_daemon') vi.spyOn(credentialStorage, 'readStoredCredentialsForServerId')
    .mockImplementation(async requestedServerId => { expect(requestedServerId).toBe(serverId); return credentials; });
  const artifacts = new Map<string, Record<string, unknown>>();
  const homeObservation: { mintStatus?: number; verifyStatus?: number; patchStatus?: number; requestError?: string } = {};
  // Only Home HTTP and OS process identity are substituted; the Session tool,
  // capability transport, daemon admission and credentialed Action host are real.
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    if (!home) expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: encryption
      ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: encryption, payload: settings,
        randomBytes: length => new Uint8Array(length).fill(29) }) } : { t: 'plain', v: settings }, version: 1 } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
    if (path.endsWith('/access/grants')) return { status: 200,
      data: ArtifactAccessGrantsListResponseV1Schema.parse({ artifactId: path.split('/')[3], ownerAccountId: accountId,
        access: 'owner', grants: [] }) };
    if (path.endsWith('/access/recipients')) {
      const artifactId = path.split('/')[3]!;
      const stored = artifacts.get(artifactId);
      return stored ? { status: 200, data: ArtifactAccessRecipientCensusResponseV1Schema.parse({
        artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey,
        provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
        callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [],
      }) } : { status: 404, data: null };
    }
    if (path.startsWith('/v1/artifacts/')) return { status: artifacts.has(path.split('/').at(-1)!) ? 200 : 404,
      data: artifacts.get(path.split('/').at(-1)!) ?? null };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, input, config) => {
    const path = new URL(String(url)).pathname;
    if (home && path.startsWith('/v1/actions/')) {
      try {
        const response = await home.request('POST', path, input, config?.headers as Readonly<Record<string, string>>);
        if (path.endsWith('/verify')) homeObservation.verifyStatus = response.status;
        else homeObservation.mintStatus = response.status;
        return response;
      } catch (error) {
        homeObservation.requestError = error instanceof Error ? error.message : 'home_request_failed';
        throw error;
      }
    }
    if (!home) expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
    if (path === '/v2/sessions/read-batch') return { status: 200,
      data: createSessionReadBatchResponseFixture({ request: input, sessions: [row] }) };
    if (path === '/v1/artifacts') {
      if (!input || typeof input !== 'object') throw new Error('Expected Artifact HTTP input');
      const id = String(Reflect.get(input, 'id'));
      artifacts.set(id, { ...input, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
        publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return { status: 200, data: artifacts.get(id) };
    }
    if (path.startsWith('/v1/artifacts/')) {
      const id = path.split('/').at(-1)!;
      const stored = artifacts.get(id);
      if (!stored) return { status: 404, data: null };
      const mutation = ArtifactJsonUpdateHttpInputV1Schema.parse(input);
      if (mutation.expectedHeaderVersion !== stored.headerVersion || mutation.expectedBodyVersion !== stored.bodyVersion) {
        return { status: 200, data: { success: false, error: 'version-mismatch' } };
      }
      const headerVersion = mutation.expectedHeaderVersion + 1;
      const bodyVersion = mutation.expectedBodyVersion + 1;
      artifacts.set(id, { ...stored, ...mutation, headerVersion, bodyVersion });
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    }
    throw new Error(`Unexpected POST ${path}`);
  });
  vi.spyOn(axios, 'patch').mockImplementation(async (url, input, config) => {
    if (home) {
      // The admitted requester root uses ordinary Account metadata writes
      // (createCliBotTemplateActionDeps.metadataHeaders), not a second signed root.
      expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
      expect(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBeUndefined();
      const response = await home.request('PATCH', new URL(String(url)).pathname, input,
        config?.headers as Readonly<Record<string, string>>);
      homeObservation.patchStatus = response.status;
      if (response.status === 200) {
        // This HTTP fixture serves subsequent reads; retain only acknowledged
        // Session state after the real Home authorizes and persists the patch.
        const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
        const acknowledged = SessionMetadataTuplePatchSuccessV1Schema.parse(response.data);
        row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
          metadataVersion: acknowledged.sharedMetadata.version, agentState: patch.agentState.ciphertext,
          agentStateVersion: acknowledged.agentState.version };
      }
      return response;
    }
    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
    const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
    row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
      metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext,
      agentStateVersion: (row.agentStateVersion ?? 0) + 1 };
    return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
  });
  const features = { status: 'ready' as const, provenance: 'authenticated' as const,
    // template.draft requires the canonical server Bots feature; Account Action
    // settings keep their defaults, including discoverable-only tool exposure.
    features: FeaturesResponseSchema.parse({ features: { bots: { enabled: true } }, capabilities: {} }) };
  const requesterHost = host === 'requester_daemon' || host === 'requester_e2ee' || host === 'signed_daemon';
  const channel = requesterHost ? await createRequesterCurrentnessSocketHarness() : null;
  const directory = await mkdtemp(join(tmpdir(), 'template-agent-bootstrap-'));
  const prepared = requesterHost ? await prepareRequesterSessionBootstrap({ credentials,
    attribution: { serverId, accountId, machineId: 'template-machine', installationId: 'template-installation' },
    ...(home ? { homeServerIdentityId: 'srv_template_home' } : {}),
    boundSessionId: sessionId, boundary: { serverId, serverHttpBaseUrl: origin, happyHomeDir: directory },
    verifyMachineAdmissionCurrent: async () => true }) : null;
  if (requesterHost && !prepared) throw new Error('Requester bootstrap was not admitted');
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl: origin, token, credentials,
    machineId: 'template-machine',
    ...(home ? { prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent }) => {
      const target = { kind: 'machine' as const, machineId: 'template-machine' };
      const minted = await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({
        actionId: operation.actionId, input: operation.input, requestId: operation.requestId,
        target, machineId: target.machineId, sourceMachineId: target.machineId, accountId,
        accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId, serverIdentityId: 'srv_template_home',
        serverHttpBaseUrl: origin, installationId: installation.installationId, privateKey: installation.privateKey,
        sessionActionOrigin, isCurrent: isCallerCurrent,
      });
      if (!minted) throw new Error('Real Session Home mint refused');
      const authorization = await prepared?.admitted.projectExternalActionAuthorization(
        minted.authorization, 'srv_template_home');
      if (!authorization) throw new Error('Admitted requester Account projection unavailable');
      return { authorization, target, originalActionEnvelope: minted.envelope };
    } } satisfies Pick<Parameters<typeof createDaemonSessionAccountActionExecutor>[0], 'prepareExternalActionAuthorization'> : {}),
    createExecutor: (getCurrentTurnWorkDepth, isCallerCurrent) => {
      if (host !== 'credentialed_host') {
        const bootstrap = prepared?.admitted;
        const requester = bootstrap ? { bootstrap, isCurrent: bootstrap.isCurrent,
          readAccountSettingsSnapshot: () => {
            const snapshot = bootstrap.savedSecretOperationContext.readSnapshot();
            if (!snapshot) throw new Error('Requester snapshot unavailable');
            return snapshot;
          },
        } : null;
        // Only bootstrap/currentness/settings are consumed by this Action;
        // unrelated runtime services remain unmounted and throw if reached.
        const requesterRuntime = requester ? new Proxy(requester, { get: (target, key) => key in target
          ? Reflect.get(target, key) : unmounted(String(key)) }) as RequesterSessionRuntimeContext : null;
        const createExternal = createDaemonExternalActionExecution({
          params: { machineId: 'template-machine', serverId, serverBaseUrl: origin, credentials,
            getApiMachineForSessions: () => null, resolveServerFeaturesSnapshot: () => features,
            ...(home ? { resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'template-machine', serverIdentityId: 'srv_template_home' }) } : {}) },
          requiresPortableSessionSpawnServerIdentity: actionId => { expect(actionId).toBe('template.draft'); return false; },
          requesterAccountOperationContext: unmounted('requesterAccountOperationContext'),
          acquireDaemonPluginRuntimeRegistryLease: unmounted('pluginRegistry'),
          shutdownCancellationDomains: createDaemonShutdownCancellationDomains(),
          isSessionCallerCurrent: isCallerCurrent,
          externalActionApprovalExecutionOriginCurrentness: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
            credentials, serverId, serverApiUrl: origin, machineId: 'template-machine', isSessionCallerCurrent: isCallerCurrent }),
          externalActionIngressOwner: undefined, externalActionContributedApprovalReplay: null,
          observeContributedPluginExecution: unmounted('pluginExecution'), relayDiscussionAgentPublication: unmounted('discussion'),
          externalActionInstallationIdentity: home ? installation : null, ownerRemainder: unmounted('processRemainder'),
          isRuntimePublicationQuiescing: unmounted('publication'), pluginRuntimeController: unmounted('plugins'),
          connectedAccountRequestAuthRegistry: unmounted('connectedAccounts'), requireConnectedAccountRequestAuthHttpPort: unmounted('connectedAccountHttp'),
          localServicesActionFeatureGate: unmounted('localServicesGate'), localServicesRuntimeActionRoutes: unmounted('localServicesRoutes'),
          localServicesRuntime: unmounted('localServices'), externalActionContributedInvoker: null,
          externalActionContributedDefinitionLister: null, externalActionTranscriptFollowLeaseRegistry: null,
        });
        return createExternal(bootstrap?.credentials ?? credentials, getCurrentTurnWorkDepth, isCallerCurrent, undefined, requesterRuntime);
      }
      return createCliActionExecutorFromCredentials({
      credentials, serverId, serverApiUrl: origin, actionsSettingsProvider: policy, getCurrentTurnWorkDepth,
      isApprovalExecutionOriginCurrent: async () => await isCallerCurrent(), resolveServerFeaturesSnapshot: () => features,
    }); } });
  const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
    execute: operation => execute(operation, { sessionId, isCurrent: async () => true }) });
  const witness = { turnId: 'draft-turn', inputId: 'draft-input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default', causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'default' as const },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const session = createMutableApiSessionClientFixture({ sessionId, overrides: {
    getServerBinding: () => ({ serverId, serverUrl: origin }), getMetadataSnapshot: () => metadata,
    getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getActiveTurnAdmissionWitness: () => witness,
    getActiveTurnPermissionWitness: () => witness, getServerFeaturesSnapshot: () => features,
  } });
  const runtime = createHappierMcpServer(session, { authorityScope: 'session', credentials: null,
    sessionCredentials: { token: 'restricted-session-bearer', encryption: null }, actionsSettingsProvider: policy });
  try {
    const result = await runtime.executeTool({ toolName: 'action_execute', toolCallId: 'draft-tool', args: { actionId: 'template.draft', input: {
      sourceSessionRef: { serverId, sessionId }, content: { v: 1, identity: { name: 'Helper', description: 'Reusable helper' },
        instructions: { markdown: 'Help with work.' }, memoryRules: [], skills: [],
        needs: { software: [], connectedAccounts: [], mcpServers: [] } },
    } } });
    expect(result, JSON.stringify({ result, homeObservation })).toMatchObject({ ok: true, result: { draftArtifactId: expect.any(String) } });
    if (home) expect(homeObservation).toMatchObject({ mintStatus: 200, verifyStatus: 200, patchStatus: 200 });
    expect(artifacts.size).toBe(1);
    expect(daemon.actionRequestCount).toBe(1);
    const incumbentId = [...artifacts.keys()][0]!;
    const refreshedContent = { v: 1, identity: { name: 'Updated helper', description: 'Reusable helper' },
      instructions: { markdown: 'Help with the next task.' }, memoryRules: [], skills: [],
      needs: { software: [], connectedAccounts: [], mcpServers: [] } };
    // The same ordinary agent request updates its pre-existing draft without
    // knowing its Artifact id or revision. The current revision belongs to the host.
    const updated = await runtime.executeTool({ toolName: 'action_execute', toolCallId: 'draft-tool-again', args: {
      actionId: 'template.draft', input: { sourceSessionRef: { serverId, sessionId }, content: refreshedContent },
    } });
    expect(updated, JSON.stringify({ updated, homeObservation })).toMatchObject({ ok: true, result: {
      draftArtifactId: incumbentId, revision: { headerVersion: 2, bodyVersion: 2 },
      summary: { identity: refreshedContent.identity },
    } });
    expect(artifacts.size).toBe(1);
    expect(artifacts.get(incumbentId)).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
    if (!encryption) {
      const carrier = z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(String(artifacts.get(incumbentId)!.body)));
      expect(JSON.parse(carrier.body)).toMatchObject({ content: refreshedContent });
    }
    const revisionFromAgent = await runtime.executeTool({ toolName: 'action_execute', toolCallId: 'draft-tool-with-revision', args: {
      actionId: 'template.draft', input: { sourceSessionRef: { serverId, sessionId }, content: refreshedContent,
        expectedRevision: { headerVersion: 2, bodyVersion: 2 } },
    } });
    expect(revisionFromAgent).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(artifacts.get(incumbentId)).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
  } finally { await runtime.mcp.close(); await session.close(); await daemon.close();
    await prepared?.cleanupOnFailure(); await channel?.close(); await home?.close(); await rm(directory, { recursive: true, force: true }); }
}, 300_000);
