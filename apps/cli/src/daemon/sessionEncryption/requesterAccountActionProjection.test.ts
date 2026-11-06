import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { prepareRequesterOperationMaterial } from '@/daemon/connectedServices/purposeBindings/requesterOperationMaterial';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { bindRequesterSessionCredentialScope, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import * as persistence from '@/persistence';
import { projectRequesterAccountActionAuthorization } from './requesterSessionCredentials';
import { createExternalActionMachineRpcExecution, dispatchOriginalAccountAction, projectExternalActionRequesterHttpAuthorization, isReviewedSecondOpinionModelSpawnChild, createReviewedSecondOpinionSessionCreationAuthorization } from '@/api/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { buildDiscussionModelSessionCreationProofPayloadV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as requesterAccountOwner from './requesterAccountActionProjection';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeploymentTargetRoleAdmissionHost } from '@/deployments/targets/createDeploymentTargetRoleAdmissionHost';
import { createActionOperationRunner } from '../actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import * as installationStore from '@/daemon/identity/store';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { publishServerHttpRuntimeOrigin, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeStoredCredentials } from '@/persistence';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1,
  sealExternalActionRequestV2, openExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionRequestEnvelopeSchema, parseExternalActionDaemonDispatchResultV1,
  projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import type { RpcHandler } from '@/api/rpc/types';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });

const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-invocation', binding: {
  accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'alice',
  serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
  actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
  target: { kind: 'machine', machineId: 'machine' },
  grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['projects.context.update'] },
    targets: { sessions: [], machines: ['machine'] }, approve: false, origins: [], models: null,
    permissionModes: null, create: null }),
} });

function bootstrap(credentials: StoredCredentials, isCurrent = async () => true) {
  return { credentials, serverHttpBaseUrl: 'https://requester-home.test', isCurrent,
    attribution: { serverId: 'home-profile', accountId: 'bob', machineId: 'machine', installationId: 'installation' } };
}

describe('admitted requester Action projection', () => {
  it('prepares SOURCE projection with one source observation and no bracketing custody reads', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected SOURCE projection read');
    });
    const observations: string[] = [];
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-source-projection', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test',
      purpose: { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: 'installation' },
        request: { sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } },
      isCurrent: async () => { observations.push('source'); return true; },
      isCustodyCurrent: async () => { observations.push('custody'); return true; },
    });
    if (!admitted) throw new Error('Missing SOURCE projection');
    try {
      const sourceReads = observations.filter(value => value === 'source');
      // Admission and the completed SOURCE projection each observe the source once.
      expect(sourceReads).toHaveLength(2);
      const custodyReads = observations.filter(value => value === 'custody').length;
      expect(await admitted.isCurrent()).toBe(true);
      expect(observations.filter(value => value === 'source')).toHaveLength(sourceReads.length + 1);
      expect(observations.filter(value => value === 'custody'), 'no custody rereads around the SOURCE observation')
        .toHaveLength(custodyReads);
    } finally { await admitted.dispose(); }
  });

  it('does not inspect installed credentials from the parallel Settings floor before requester identity admission', async () => {
    // Credential storage and Home HTTP are system boundaries. Keep the real
    // currentness helper so its legacy-recovery branch remains observable.
    const storedCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'another-account' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 400, data: {
        error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
      } };
      throw new Error('Rejected identity must not open Settings');
    });
    await expect(requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true,
    })).resolves.toBeNull();
    expect(storedCredentials).not.toHaveBeenCalled();
  });

  it('takes one requester mode observation per parallel admitted request and retains each Settings floor', async () => {
    let modeReads = 0;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: ++modeReads,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 3 } };
      throw new Error(`Unexpected parallel requester read ${url}`);
    });
    const admitted = await Promise.all(Array.from({ length: 3 }, () => requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob', encryption: null }, serverId: 'parallel-home', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://parallel-requester-home.test', isCurrent: async () => true,
    })));
    try {
      expect(admitted.every(context => context !== null)).toBe(true);
      expect(admitted.map(context => context?.accountEncryptionCurrentness.settingsVersion)).toEqual([1, 2, 3]);
      expect(modeReads).toBe(admitted.length);
      for (const context of admitted) for (let read = 0; read < 5; read++) expect(await context!.isCurrent()).toBe(true);
      expect(modeReads).toBe(admitted.length);
      expect(get.mock.calls.filter(([url]) => String(url).endsWith('/v2/account/settings'))).toHaveLength(admitted.length);
    } finally { await Promise.all(admitted.map(context => context?.dispose())); }
  });


  it('admits requester identity before opening its observation and Settings floor', async () => {
    let releaseProfile!: () => void;
    const profileHeld = new Promise<void>(resolve => { releaseProfile = resolve; });
    let profileStarted = false;
    let floorStarted = false;
    let settingsReads = 0;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) {
        profileStarted = true;
        await profileHeld;
        return { status: 200, data: { id: 'bob' } };
      }
      if (url.endsWith('/v1/account/encryption/currentness')) {
        floorStarted = true;
        return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 2,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (url.endsWith('/v2/account/settings')) {
        settingsReads++;
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 2 } };
      }
      throw new Error(`Unexpected requester HTTP read ${url}`);
    });
    const input = { authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' as const } },
      credentials: { token: 'bob', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true };
    const pending = requesterAccountOwner.admitRequesterAccountActionContext(input);
    try {
      await vi.waitFor(() => expect(profileStarted).toBe(true));
      expect(floorStarted).toBe(false);
      expect(settingsReads).toBe(0);
    } finally {
      releaseProfile();
      const admitted = await pending;
      try { expect(admitted?.accountSettingsContext.settingsVersion).toBe(2); }
      finally { await admitted?.dispose(); }
    }
    settingsReads = 0;
    reads.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'another-account' } };
      if (url.endsWith('/v1/account/encryption/currentness')) throw new Error('Unavailable Settings floor');
      settingsReads++;
      throw new Error('Identity must be admitted before opening Settings');
    });
    await expect(requesterAccountOwner.admitRequesterAccountActionContext(input)).resolves.toBeNull();
    expect(settingsReads).toBe(0);
    expect(floorStarted).toBe(true);
  });

  it('cancels the held Settings HTTP read when finite requester admission is aborted', async () => {
    let settingsStarted!: () => void;
    const requested = new Promise<void>(resolve => { settingsStarted = resolve; });
    let releaseSettings: (() => void) | undefined;
    let settingsClosed = false;
    const home = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/profile') response.end(JSON.stringify({ id: 'bob' }));
      else if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain',
        version: 1, settingsVersion: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
      else if (request.url === '/v2/account/settings') {
        // A real Axios request owns this TCP response; no private body is released before abort.
        response.once('close', () => { settingsClosed = true; });
        response.flushHeaders();
        releaseSettings = () => { response.end(JSON.stringify({ content: { t: 'plain', v: {} }, version: 1 })); };
        settingsStarted();
      } else { response.statusCode = 404; response.end('{}'); }
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Missing finite requester Home address');
    const caller = new AbortController();
    const custody: { cleanup?: () => Promise<void> } = {};
    const admission = requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, signal: caller.signal, isCurrent: async () => true,
    }).then(result => { custody.cleanup = result?.dispose; return { admitted: result !== null }; },
      () => ({ admitted: false }));
    try {
      await Promise.race([requested, admission.then(() => { throw new Error('Admission ended before the held Settings request'); })]);
      caller.abort();
      await vi.waitFor(() => expect(settingsClosed).toBe(true));
      await expect(admission).resolves.toEqual({ admitted: false });
    } finally {
      caller.abort();
      releaseSettings?.();
      await admission;
      await custody.cleanup?.();
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  });

  it('opens the immutable opinion root and proves the creator-bound current model slot for public spawn and read-only preflight', async () => {
    const launch = { executionTarget: { serverId: 'home-profile', machineId: 'model-machine' },
      directory: { kind: 'path', path: '/reviewed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } as const;
    const source = { kind: 'session', message: { kind: 'session', session: { serverId: 'home-profile', sessionId: 'source-session' }, messageId: 'answer' } } as const;
    const reviewer = { selection: { kind: 'model', launch }, participantSlotId: 'reviewed-slot', sourceAccess: 'read' } as const;
    const input = { intent: 'ask', source, title: 'Review', question: 'Check this', reviewers: [reviewer],
      retry: { creationLocalId: 'opinion-create', quoteLocalId: 'opinion-quote', questionLocalId: 'opinion-question' },
      confirmedPreview: { source, sourceAudienceAccountIds: ['bob'], sourceContentReady: true,
        discussionAudienceAccountIds: ['bob'], missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true }, canGrantSource: true,
        reviewers: [{ ...reviewer, runtimeAccountId: 'bob', audienceAccountIds: ['bob'], missingSourceAccountIds: [],
          canGrantSource: true, disclosure: { ok: true } }] } };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'reviewed-opinion',
      target: { kind: 'machine', machineId: 'source-machine' }, input });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'opinion-root', binding: {
      accountId: 'bob', custodianAccountId: 'source-owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'stable-home', machineId: 'source-machine', installationId: 'source-installation', accountEncryptionMode: 'plain',
      actionId: 'discussion.second_opinion.start', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    let current = true, archivedAt: number | null = null, creationLocalId = input.retry.creationLocalId;
    let slotPath: string = launch.directory.path;
    const summary = () => ({ id: 'created-opinion', ownerAccountId: 'bob', encryptionMode: 'plain', anchor: null,
      access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId,
      titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
      latestMessage: { id: 'quote', localId: 'opinion-quote', seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
      messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
    // HTTP and current installed custody are the boundaries; original-envelope
    // opening, strict child derivation and the retained Account owner stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v1/discussions?creationLocalId=opinion-create')) return { status: 200, data: { discussions: [summary()], nextCursor: null } };
      if (url.endsWith('/v1/discussions/created-opinion')) return { status: 200, data: { discussion: summary() } };
      if (url.endsWith('/v1/discussions/created-opinion/participants')) return { status: 200, data: {
        discussionId: 'created-opinion', ownerAccountId: 'bob', access: 'owner', grants: [], participants: [{
          participant: { kind: 'model', participantSlotId: 'reviewed-slot' }, sessionId: null, createdAt: 1,
          answerPolicy: 'when_addressed', launch: { ...launch, directory: { kind: 'path', path: slotPath } } }] } };
      throw new Error(`Unexpected opinion custody HTTP ${url}`);
    });
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-private', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => current });
    if (!admitted) throw new Error('Missing opinion requester custody');
    const spawn = { ...launch, creationKey: 'reviewed-slot', initialTriggers: [],
      discussionParticipant: { discussionId: 'created-opinion', participantSlotId: 'reviewed-slot' } };
    const verify = (params: unknown = spawn, method: string = RPC_METHODS.SESSION_SPAWN_NEW, original: unknown = envelope) =>
      isReviewedSecondOpinionModelSpawnChild({ authorization: admitted.authorization, envelope: original,
        machineId: 'model-machine', actionId: 'session.spawn_new', params, method });
    try {
      expect(await verify()).toBe(true);
      expect(await verify({ directory: launch.directory }, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT)).toBe(true);
      expect(await verify({ ...spawn, initialInput: { text: 'unreviewed work' } })).toBe(false);
      expect(await verify({ ...spawn, creationKey: 'another-slot' })).toBe(false);
      expect(await verify({ directory: { kind: 'path', path: '/unreviewed' } }, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT)).toBe(false);
      expect(await verify(spawn, RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(false);
      expect(await verify(spawn, RPC_METHODS.SESSION_SPAWN_NEW, { ...envelope, requestId: 'another-root' })).toBe(false);
      creationLocalId = 'unrelated-opinion'; expect(await verify()).toBe(false); creationLocalId = input.retry.creationLocalId;
      archivedAt = 1; expect(await verify()).toBe(false); archivedAt = null;
      slotPath = '/changed'; expect(await verify()).toBe(false); slotPath = launch.directory.path;
      current = false; expect(await verify()).toBe(false);
      current = true;
      const [{ RpcHandlerManager }, machineAdmission] = await Promise.all([
        import('@/api/rpc/RpcHandlerManager'), import('@/api/machine/machineRpcAuthorization'),
      ]);
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
      const installation = { version: 1 as const, installationId: 'model-installation', createdAt: 1,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
      vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
      vi.spyOn(axios, 'post').mockImplementation(async url => {
        if (String(url).endsWith('/v1/machines/model-machine/admission/verify')) return { status: 200, data: { v: 1, ok: current } };
        throw new Error(`Unexpected native opinion admission ${url}`);
      });
      const nativeDiagnostics: unknown[] = [];
      const rpc = new RpcHandlerManager({ scopePrefix: 'model-machine', localMachineId: 'model-machine',
        encryptionMode: 'plain', logger: (_message, detail) => { nativeDiagnostics.push(detail); }, authorizeRequest: request => machineAdmission.authorizeMachineRpcRequest(request, {
          machineId: 'model-machine', resolveCustodianAccountId: async () => 'model-owner', resolveInstallationId: () => installation.installationId,
          verifyMachineAdmission: request => machineAdmission.verifyMachineRpcAdmissionCurrent({ ...request,
            privateKey: keys.secretKey, daemonToken: 'model-owner-token', serverHttpBaseUrl: 'https://requester-home.test' }),
        }), prepareRequesterAccountContext: request => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
          ...request, purpose: request.purpose ?? { kind: 'external_action' }, machineId: 'model-machine',
          serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'model-machine', serverIdentityId: 'stable-home' }),
          createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
        }) });
      let effects = 0;
      rpc.registerHandler(RPC_METHODS.SESSION_SPAWN_NEW, async (_value, context) => {
        if (!context) throw new Error('Missing native custody');
        const creation = createReviewedSecondOpinionSessionCreationAuthorization({ context: {
          ...context, externalActionExecutionAuthorization: context.callerInputAuthorization,
          originalActionEnvelope: context.workspaceSyncSourceExecution?.originalActionEnvelope,
        }, publicInput: SessionSpawnNewInputV2Schema.parse(_value), installationId: installation.installationId, privateKey: keys.secretKey });
        expect(creation?.token).toBe(root.token);
        const body = { originKind: 'discussion', discussionParticipant: spawn.discussionParticipant,
          discussionParticipantLaunch: launch, tag: deriveSessionCreationTagV1({
            callerCreationNamespace: JSON.stringify(['discussion-participant', spawn.discussionParticipant.discussionId]),
            creationKey: spawn.discussionParticipant.participantSlotId }) };
        const proof = await creation?.prepareRequestProof?.(body);
        expect(proof).toBeTruthy();
        if (!proof) throw new Error('Missing selected receiver proof');
        const payload = buildDiscussionModelSessionCreationProofPayloadV1({ ...proof, body });
        expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: proof.proof, payload })).toBe(true);
        expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: proof.proof,
          payload: buildDiscussionModelSessionCreationProofPayloadV1({ ...proof, body: { ...body, tag: 'another-session' } }) })).toBe(false);
        await expect(creation?.prepareRequestProof?.({ ...body, discussionParticipantLaunch: { ...launch,
          directory: { kind: 'path', path: '/unreviewed' } } })).rejects.toThrow();
        effects += 1;
        return { accepted: true, rootAction: context?.callerInputAuthorization?.binding.actionId };
      });
      const native = async (value: unknown) => {
        const method = `model-machine:${RPC_METHODS.SESSION_SPAWN_NEW}`;
        const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
          purpose: { kind: 'machine_rpc', method: RPC_METHODS.SESSION_SPAWN_NEW, params: value,
            recipient: { machineId: 'model-machine', installationId: installation.installationId } },
          credentials: { token: 'bob-private', secret: null, encryption: null },
          installationPublicKey: keys.publicKey, randomBytes: nacl.randomBytes });
        const execution = createExternalActionMachineRpcExecution({ context: { externalActionExecutionAuthorization: sealed,
          externalActionTarget: root.binding.target }, effectActionId: 'session.spawn_new', installationId: root.binding.installationId,
          method, requestId: 'native-opinion', params: value, privateKey: nacl.sign.keyPair().secretKey });
        if (!execution) throw new Error('Missing installed source proof');
        return rpc.handleRequest({ method, params: value, requestId: 'native-opinion', originalActionEnvelope: envelope,
          callerAuthority: 'present_user', callerInputAuthorization: sealed,
          workspaceSyncSourceExecution: { method, params: StrictJsonValueSchema.parse(value), requestId: 'native-opinion', originalActionEnvelope: envelope,
            externalActionExecution: execution }, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'model-owner',
            machineId: 'model-machine', installationId: installation.installationId, role: 'use', encryptionMode: 'plain' } });
      };
      expect(await native(spawn), JSON.stringify(nativeDiagnostics)).toEqual({ accepted: true, rootAction: 'discussion.second_opinion.start' });
      expect(await native({ ...spawn, initialInput: { text: 'unreviewed work' } })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(effects).toBe(1);
    } finally { await admitted.dispose(); }
  });
  it.each([
    { mode: 'plain', failure: 'network', expected: 'storage_unavailable' },
    { mode: 'e2ee', failure: 'network', expected: 'storage_unavailable' },
    { mode: 'plain', failure: 'authentication', expected: 'invalid_envelope' },
    { mode: 'e2ee', failure: 'authentication', expected: 'invalid_encrypted_envelope' },
  ] as const)('preserves unavailable Home admission without accepting refused custody ($mode/$failure)', async ({ mode, failure, expected }) => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(45));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token,
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(46) } };
    const target = { kind: 'session' as const, sessionId: 'c123456789012345678901234' };
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    const input = { sessionId: target.sessionId, message: 'Correction', localId: 'correction', modelOverride: 'claude-haiku-4-5' };
    const failures: string[] = [];
    // Only Home HTTP is substituted. The real CLI producer, strict envelope
    // consumer and private requester admission run together before any effect.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) {
        if (failure === 'authentication') return { status: 401, data: { error: 'invalid_token' } };
        throw new axios.AxiosError('Home read unavailable', 'ECONNRESET');
      }
      throw new Error('Unexpected Home read');
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
      const envelope = ExternalActionRequestEnvelopeSchema.parse(raw);
      expect(envelope.v).toBe(mode === 'plain' ? 1 : 2);
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'send-root', binding: {
        accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
        accountEncryptionMode: mode, serverIdentityId: 'srv_fx45_home', machineId: 'machine', installationId: 'installation',
        actionId: 'session.message.send', requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      if (envelope.v === 2) {
        if (credentials.encryption?.type !== 'legacy') throw new Error('Expected fixture encryption material');
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: { serverIdentityId: 'srv_fx45_home', accountId: 'bob',
          authentication: { kind: 'account', tokenEpoch: 7 }, actionId: 'session.message.send', requestId: 'correction', target },
          material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret) } }))
          .toEqual({ input });
      } else expect(envelope.input).toEqual(input);
      const result = await executeExternalAction({ actionId: root.binding.actionId, envelope,
        principal: { accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, authority: 'present_user' },
        currentMachineId: 'machine', currentServerId: 'home-profile', currentInstallationId: 'installation',
        executionAuthorization: root, externalActionMachineRequestPrivateKey: keys.secretKey,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
          installationId: 'installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://requester-home.test' }),
        prepareRequesterAccountContext: request => requesterAccountOwner.prepareRequesterAccountActionContext({
          authorization: request.authorization, purpose: { kind: 'external_action' }, machineId: 'machine',
          installationId: 'installation', installationPrivateKey: keys.secretKey, serverId: 'home-profile',
          serverIdentityId: 'srv_fx45_home', serverHttpBaseUrl: 'https://requester-home.test', ownCredentials: credentials,
          isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: request.authorization,
            effectActionId: root.binding.actionId, target, installationId: 'installation',
            privateKey: keys.secretKey, serverHttpBaseUrl: 'https://requester-home.test' }), createExecutor: () => executor,
        }), executor,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      });
      if (result.kind !== 'invalid_request') throw new Error('Unavailable admission must refuse before the effect');
      failures.push(result.errorCode);
      const projected = projectExternalActionHttpError(result.errorCode, envelope.requestId);
      return { status: projected.statusCode, data: projected.payload };
    });
    expect(await dispatchOriginalAccountAction({ actionId: 'session.message.send', input, requestId: 'correction', target,
      credentials, serverIdentityId: 'srv_fx45_home', serverHttpBaseUrl: 'https://requester-home.test' }))
      .toEqual({ ok: false, errorCode: expected, error: expected });
    expect(failures).toEqual([expected]);
  });
  it.each(['projects.prepare', 'projects.script.run', 'projects.compute.exec', 'projects.inspect', 'projects.worker.status', 'localServices.launcher.start',
    'machines.terminal.open', 'machines.terminal.restart', 'execution.run.start', 'execution.run.ensure', 'execution.run.send', 'execution.run.ensure_or_start'] as const)('uses retained requester custody only for private Project preparation reads on %s', async actionId => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId, requestId: 'finite-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected requester read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-preparation', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    if (!admitted) throw new Error('Missing admitted requester custody');
    const input = { serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: root.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey };
    try {
      const carrier = await projectExternalActionRequesterHttpAuthorization({ ...input, authorization: admitted.authorization });
      if (!carrier?.requesterHttpProjection) throw new Error('Missing requester HTTP port');
      if (actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart') {
        const workspace = { id: 'bob-checkout', serverId: input.serverId, machineId: 'machine', rootPath: '/bob/repo',
          projectKey: 'bob-project', createdAtMs: 1 };
        const rows = [createPlainProjectAccountRefRow(workspace)];
        // A terminal effect proof does not grant private Account-row reads.
        vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
          if (String(url).includes('/v1/account/project-rows/')) {
            if (options?.headers?.Authorization !== 'Bearer bob-preparation') return { status: 403, data: { error: 'forbidden' } };
            return projectAccountRowsReadHttpResponse(rows, String(url), body);
          }
          return { status: 200, data: { ok: true } };
        });
        const accepted = { authorization: carrier, effectActionId: actionId, serverId: input.serverId,
          serverHttpBaseUrl: input.serverHttpBaseUrl, address: { serverId: input.serverId,
            workspaceId: workspace.id, machineId: workspace.machineId, rootPath: workspace.rootPath } };
        await expect(resolveProjectSetupAcceptedWorkspace(accepted)).resolves.toEqual({ workspace,
          project: { serverId: workspace.serverId, projectId: workspace.projectKey } });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...accepted, address: { ...accepted.address, workspaceId: 'alice-checkout' } }))
          .rejects.toMatchObject({ code: 'project_workspace_unavailable' });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...accepted, address: { ...accepted.address, machineId: 'foreign-machine' } }))
          .rejects.toMatchObject({ code: 'project_workspace_changed' });
      }
      const headers = (method: string, path: string) => carrier.requesterHttpProjection!.createRequestHeaders({ effectActionId: actionId, method, path });
      const machineRead = await headers('GET', '/v1/machines/source-machine');
      if (actionId === 'projects.prepare' || actionId === 'projects.inspect'
        || actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart') {
        expect(machineRead).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      } else expect(machineRead).toEqual({ Authorization: 'Bearer bob-preparation' });
      for (const path of ['/v1/account/project-rows/read', '/v1/account/project-rows/list']) {
        if (actionId === 'localServices.launcher.start') {
          expect(await headers('POST', path)).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
        } else expect(await headers('POST', path)).toEqual({ Authorization: 'Bearer bob-preparation' });
        expect(await carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: 'projects.open', method: 'POST', path }))
          .toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
        expect(await headers('GET', path)).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      }
      for (const [method, path] of [['GET', '/v1/machines/machine'], ['POST', '/v1/machines/source-machine'],
        ['GET', '/v1/account/profile'], ['POST', '/v1/account/project-rows/mutate'],
        ['POST', '/v1/account/project-trust/read'], ['POST', '/v1/projects/execution/config/read']] as const) {
        const signed = await headers(method, path);
        if (actionId.startsWith('execution.run.') && (method === 'GET' && path === '/v1/machines/machine'
          || method === 'POST' && (path === '/v1/account/project-trust/read' || path === '/v1/projects/execution/config/read'))) {
          expect(signed).toEqual({ Authorization: 'Bearer bob-preparation' });
          continue;
        }
        expect(signed).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
        expect(signed).not.toHaveProperty('Authorization');
      }
      const wire = await projectExternalActionRequesterHttpAuthorization({ ...input, authorization: root });
      expect(await wire?.requesterHttpProjection?.createRequestHeaders({ effectActionId: actionId, method: 'GET', path: '/v1/machines/source-machine' }))
        .toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      expect(await wire?.requesterHttpProjection?.createRequestHeaders({ effectActionId: actionId, method: 'POST', path: '/v1/account/project-rows/list' }))
        .toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      const rpc = createExternalActionMachineRpcExecution({ context: { externalActionExecutionAuthorization: carrier, externalActionTarget: root.binding.target },
        installationId: input.installationId, privateKey: input.privateKey, effectActionId: actionId,
        method: 'machine:projects.worker.status', requestId: 'rpc-read', params: {} });
      expect(rpc).not.toBeNull();
      expect(JSON.stringify(rpc)).not.toContain('bob-preparation');
      expect(JSON.stringify(rpc)).not.toContain('requesterHttpProjection');
      await admitted.dispose();
      expect(await headers('GET', '/v1/machines/source-machine')).toBeNull();
      expect(await headers('POST', '/v1/account/project-rows/list')).toBeNull();
    } finally { await admitted.dispose(); }
  });
  it('publishes retained finite requester Settings over envelopes, hints and reconnect without per-Action reads', async () => {
    let version = 1;
    let settings = { experiments: false };
    let reads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) {
        reads++;
        return { status: 200, data: { content: { t: 'plain', v: settings }, version } };
      }
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    const context = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain', admittedMachineRole: 'use' } },
      credentials: { token: 'bob-settings', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true,
    });
    if (!context) throw new Error('Missing requester custody');
    // Native-source acquisition consumes the signed Machine grant (SEC-BATCH-1101 S1).
    expect(context.savedSecretOperationContext.machineAdmission)
      .toEqual({ actorAccountId: 'bob', custodianAccountId: 'alice', role: 'use' });
    const release = context.retain();
    try {
      expect(await context.refreshAccountSettings()).toBe(true);
      const initialReads = reads;
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(reads).toBe(initialReads);
      await context.dispose();
      settings = { experiments: true };
      version++;
      await channel.pushSettings('bob', settings, version);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(context.savedSecretOperationContext.readSnapshot()).toMatchObject({ settingsVersion: version, settings });
      expect(reads).toBe(initialReads);
      await channel.pushSettings('other-account', {}, version + 100);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(reads).toBe(initialReads);
      version++;
      await channel.hintSettings(version);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(context.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(version);
      expect(reads).toBe(initialReads + 1);
      const beforeInvalid = context.savedSecretOperationContext.readSnapshot();
      await channel.pushInvalidSettings('bob');
      expect(context.savedSecretOperationContext.readSnapshot()).toEqual(beforeInvalid);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(reads).toBe(initialReads + 2);
      expect(context.savedSecretOperationContext.readSnapshot()).toMatchObject({ settingsVersion: version, settings });
      await channel.pushSettings('bob', settings, ++version);
      expect(await context.refreshAccountSettings()).toBe(true);
      await channel.disconnect();
      await expect(context.refreshAccountSettings()).rejects.toMatchObject({ retryable: true });
      version++;
      await channel.reconnect();
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(context.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(version);
    } finally { await context.dispose(); await release(); }
    expect(await context.refreshAccountSettings()).toBe(false);
    expect(context.savedSecretOperationContext.readSnapshot()).toBeNull();
  });
  it.each([
    ['daemon', new URL('../startDaemon.ts', import.meta.url)],
    ['Machine Session handlers', new URL('../../api/apiMachine.ts', import.meta.url)],
  ])('admits installed E2EE custody through the %s runtime HTTP origin in a non-default home', async (_name, sourcePath) => {
    // Generated fixtures only: no installed user identity, Account or endpoint is read.
    const home = mkdtempSync(join(tmpdir(), 'happier-fx18-runtime-origin-'));
    const previous = { happyHomeDir: configuration.happyHomeDir,
      installationIdentityFile: configuration.installationIdentityFile,
      serverUrl: configuration.serverUrl, apiServerUrl: configuration.apiServerUrl };
    const secret = nacl.randomBytes(32);
    const credentials: StoredCredentials = { token: 'fx18-test-requester', encryption: { type: 'legacy', secret } };
    const settings = { experiments: true };
    const settingsContent = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
      material: { type: 'legacy', secret }, payload: settings, randomBytes: nacl.randomBytes }) };
    const currentness = { mode: 'e2ee', version: 1, signingKeyFingerprint: 'test-signing',
      contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
        deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey), updatedAt: 1 };
    const features = FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_fx18_test_home' } } });
    const requestedPaths: string[] = [];
    const http = createServer((request, response) => {
      requestedPaths.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      const data = request.url === '/v1/features' ? features
        : request.url === '/v1/account/profile' ? { id: 'bob' }
        : request.url === '/v1/account/encryption/currentness' ? currentness
        : request.url === '/v2/account/settings' ? { content: settingsContent, version: 1 }
        : request.url?.endsWith('/verify') ? { ok: true } : null;
      response.statusCode = data ? 200 : 404;
      response.end(JSON.stringify(data));
    });
    let release: (() => void) | undefined;
    let prepared: Awaited<ReturnType<typeof requesterAccountOwner.prepareInstalledRequesterAccountActionContext>> = null;
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      // Close an ephemeral listener to obtain a genuinely unreachable canonical address.
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const canonicalAddress = http.address();
      if (!canonicalAddress || typeof canonicalAddress === 'string') throw new Error('Missing test listener');
      const canonical = `http://127.0.0.1:${canonicalAddress.port}`;
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const runtimeAddress = http.address();
      if (!runtimeAddress || typeof runtimeAddress === 'string') throw new Error('Missing test listener');
      const runtime = `http://127.0.0.1:${runtimeAddress.port}`;
      Object.assign(configuration, { happyHomeDir: home, installationIdentityFile: join(home, 'installation-identity.json'),
        serverUrl: canonical, apiServerUrl: canonical });
      const installation = installationStore.readOrCreateInstallationIdentitySync();
      release = publishServerHttpRuntimeOrigin(runtime, 'iroh');
      const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
      const binding = { accountId: 'bob', credentialId: '00000000-0000-4000-8000-000000000018', actionId: 'browser.diagnostics.snapshot',
        requestId: 'fx18-test-request', serverIdentityId: 'srv_fx18_test_home', target: { kind: 'machine' as const, machineId: 'machine' } };
      const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes: nacl.randomBytes,
        input: { browserSessionId: 'test-browser', viewId: 'test-view' } });
      const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: [binding.actionId] },
        targets: { sessions: [], machines: ['machine'] }, approve: false, origins: [], models: null,
        permissionModes: null, create: null });
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: { ...authorization.binding,
        ...binding, grant, installationId: installation.installationId, accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
      const purpose = { kind: 'external_action' } as const;
      const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
        credentials: encodeStoredCredentials(credentials), installationPublicKey: Buffer.from(installation.publicKey, 'base64url'),
        randomBytes: nacl.randomBytes });
      // Exercise the exact production initializer without starting a daemon or its background services.
      // This remains sensitive to either call site being wired to the canonical identity address.
      const source = readFileSync(sourcePath, 'utf8');
      const initializer = source.match(/const resolveCurrentMachineExecutionOriginContext\s*=\s*(createCurrentMachineExecutionOriginContextResolver\(\{[\s\S]*?\}\));/u)?.[1];
      if (!initializer) throw new Error('Missing production origin composition');
      const homeTransportCancellation = new AbortController();
      const serverFeaturesSnapshotStore = createServerUrlServerFeaturesSnapshotStore({
        serverUrl: resolveServerHttpBaseUrl(), token: credentials.token,
      });
      await serverFeaturesSnapshotStore.refresh();
      const resolveOrigin = new Function('createCurrentMachineExecutionOriginContextResolver', 'configuration',
        'resolveServerHttpBaseUrl', 'machineId', 'homeTransportCancellation', 'homeTarget', 'serverFeaturesSnapshotStore',
        `return ${initializer};`).call({ machine: { id: 'machine' } },
          createCurrentMachineExecutionOriginContextResolver, configuration, resolveServerHttpBaseUrl, 'machine',
          homeTransportCancellation, { homeServerIdentityId: null }, serverFeaturesSnapshotStore) as
          ReturnType<typeof createCurrentMachineExecutionOriginContextResolver>;
      const executor = createActionExecutor(createUnavailableActionTransportDeps());
      prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
        machineId: 'machine', serverId: 'fx18-test-profile', serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        resolveCurrentMachineExecutionOriginContext: resolveOrigin, createExecutor: () => executor });
      const phases = phaseLog.mock.calls.map(([, value]) => (value as { phase?: string }).phase);
      expect(phases).not.toContain('requester_origin_unavailable');
      expect(Boolean(prepared)).toBe(true);
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      expect(custody?.accountSettingsContext.source).toBe('network');
      expect(custody?.accountSettingsContext.settings.experiments).toBe(true);
      expect(prepared?.authorization.requesterAccountProjection?.accountEncryptionMode).toBe('e2ee');
      expect(await custody?.isCurrent()).toBe(true);
      const result = await executeExternalAction({ actionId: binding.actionId, envelope,
        principal: { accountId: 'bob', principalId: 'bob', credentialId: binding.credentialId, grant, authority: 'account_automation' },
        currentMachineId: 'machine', currentServerId: 'fx18-test-profile', currentInstallationId: installation.installationId,
        executionAuthorization: sealed, externalActionMachineRequestPrivateKey: installation.privateKey,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
          installationId: installation.installationId, privateKey: installation.privateKey, serverHttpBaseUrl: resolveServerHttpBaseUrl() }),
        prepareRequesterAccountContext: request => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
          authorization: request.authorization, purpose, machineId: 'machine', serverId: 'fx18-test-profile',
          serverHttpBaseUrl: resolveServerHttpBaseUrl(), resolveCurrentMachineExecutionOriginContext: resolveOrigin,
          createExecutor: () => executor }),
        resolveTarget: async () => binding.target, executor });
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') throw new Error('Test diagnostics request failed before dispatch');
      // No Browser host is installed in this fixture: preserve the real, protected typed refusal.
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material }))
        .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      expect(requestedPaths).toContain('/v1/features');
      expect(requestedPaths).toContain('/v2/account/settings');
      expect(requestedPaths.some(path => path.endsWith('/verify'))).toBe(true);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({
        effectActionId: root.binding.actionId, method: 'POST', path: '/v1/account/project-rows/list',
      })).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
    } finally {
      await prepared?.dispose();
      release?.();
      Object.assign(configuration, previous);
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('identifies a missing installation without obscuring it as an origin refusal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happier-fx18-missing-installation-'));
    const previous = configuration.installationIdentityFile;
    Object.assign(configuration, { installationIdentityFile: join(home, 'installation-identity.json') });
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
        authorization, purpose: { kind: 'external_action' }, machineId: 'machine', serverId: 'home-profile',
        serverHttpBaseUrl: '', resolveCurrentMachineExecutionOriginContext: async () => null,
        createExecutor: () => { throw new Error('Missing installation cannot execute'); },
      })).toBeNull();
      expect(phaseLog).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
        machineId: 'machine', phase: 'requester_installation_missing',
      }));
    } finally {
      Object.assign(configuration, { installationIdentityFile: previous });
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('uses local Move custody for private reads without spending its fresh SOURCE proof', async () => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'local-move-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'source', installationId: 'source-installation',
      actionId: 'projects.service.relocate', requestId: 'move', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'source' },
    } });
    // Home HTTP and installed authority observations are the boundaries; custody stays real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    let sourceCurrent = true;
    let custodyCurrent = true;
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-local-private', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => sourceCurrent,
      isCustodyCurrent: async () => custodyCurrent });
    if (!admitted) throw new Error('Missing local Move custody');
    try {
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'source-installation', privateKey: nacl.sign.keyPair().secretKey });
      const http = carrier?.requesterHttpProjection;
      if (!http) throw new Error('Missing local Move HTTP port');
      const read = () => http.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' });
      sourceCurrent = false;
      expect(await admitted.isCurrent()).toBe(false);
      expect(await admitted.isCustodyCurrent?.()).toBe(true);
      expect(await read()).toEqual({ Authorization: 'Bearer bob-local-private' });
      custodyCurrent = false;
      expect(await read()).toBeNull();
    } finally { await admitted.dispose(); }
  });

  it('separates installed Move recipient custody from its fresh retained SOURCE proof', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
    const installed = { version: 1 as const, installationId: 'recipient-installation', createdAt: 1,
      publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
    const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'move-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'source', installationId: 'source-installation',
      actionId: 'projects.service.relocate', requestId: 'move', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'source' },
    } });
    const purpose = { kind: 'machine_rpc', method: 'projects.worker.status', params: {},
      recipient: { machineId: 'recipient', installationId: installed.installationId } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: keys.publicKey,
      randomBytes: nacl.randomBytes });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    let sourceCurrent = true;
    const prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
      machineId: 'recipient', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      verifyServiceMoveChildCurrent: async () => sourceCurrent,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'recipient', serverIdentityId: 'stable-home' }),
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
    expect(prepared).not.toBeNull();
    try {
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      expect(await custody?.isCustodyCurrent?.()).toBe(true);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'localServices.launcher.start',
        method: 'POST', path: '/v1/account/project-rows/list' })).toEqual({ Authorization: 'Bearer bob-private' });
      sourceCurrent = false;
      expect(await custody?.isCurrent()).toBe(false);
      expect(await custody?.isCustodyCurrent?.()).toBe(true);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'localServices.launcher.start',
        method: 'POST', path: '/v1/account/project-rows/list' })).toBeNull();
      sourceCurrent = true;
      installation.mockReturnValue({ ...installed, installationId: 'replaced' });
      expect(await custody?.isCustodyCurrent?.()).toBe(false);
      expect(await custody?.isCurrent()).toBe(false);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'localServices.launcher.start',
        method: 'POST', path: '/v1/account/project-rows/list' })).toBeNull();
    } finally { await prepared?.dispose(); }
  });

  it('brackets passive SOURCE preparation with fresh admission and keeps retained operations and Settings refresh fresh', async () => {
    const [{ RpcHandlerManager }, machineAdmission, { createWorkspaceSyncTargetContent }, { socketRpcCodec },
      { PROJECT_ACTION_INPUT_SCHEMAS_V1 }, { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema }] = await Promise.all([
      import('@/api/rpc/RpcHandlerManager'), import('@/api/machine/machineRpcAuthorization'),
      import('@/api/rpc/workspaceSyncTargetContent'), import('@happier-dev/sync-client'),
      import('@happier-dev/protocol/actions/projectActionFamily'), import('@happier-dev/protocol/socketRpc'),
    ]);
    const controller = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(61));
    const worker = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(62));
    const installation = { version: 1 as const, installationId: 'controller-installation', createdAt: 1,
      publicKey: Buffer.from(controller.publicKey).toString('base64url'), privateKey: Buffer.from(controller.secretKey).toString('base64url') };
    const installed = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
    const admission = { actorAccountId: 'bob', custodianAccountId: 'source-owner', machineId: 'source',
      installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'source-preparation',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({ workspace: {
        serverId: 'stable-home', workspaceId: 'source-ref', machineId: 'source', rootPath: '/source',
      }, selection: { kind: 'named', name: 'test' } }), target: { kind: 'machine', machineId: 'worker' } });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'source-root', binding: {
      accountId: 'bob', custodianAccountId: 'worker-owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'worker', installationId: 'worker-installation',
      actionId: 'projects.script.run', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
    } });
    const params = { sourceWorkspaceRefId: 'source-ref', targetWorkspaceRefId: 'worker-ref' };
    const purpose = { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: installation.installationId },
      request: params } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: controller.publicKey,
      randomBytes: nacl.randomBytes });
    const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'source-sync',
      accountServerId: 'stable-home', sourceMachineId: 'source', sourceRootPath: '/source', originalActionEnvelope: envelope,
      sourceContext: { machineAdmission: admission, callerAuthority: 'account_automation', workspaceWrites: 'allow' } });
    const method = `controller:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN}`;
    const content = createWorkspaceSyncTargetContent({ destination: { machineId: 'controller',
      installationId: installation.installationId, installationPublicKey: installation.publicKey }, method, routing });
    const callId = '0123456789abcdef0123456789abcdef';
    const encoded = await socketRpcCodec.encodeParams(content, params, { method, callId });
    const packet = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'source-packet', params: encoded,
      externalActionExecution: createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: sealed, externalActionTarget: root.binding.target },
        effectActionId: root.binding.actionId, installationId: root.binding.installationId,
        method, requestId: 'source-packet', params: encoded, privateKey: worker.secretKey, workspaceSyncSourceRouting: routing }) });
    let current = true;
    let afterSettings: (() => void) | undefined;
    let revokeAtOperation = false;
    let revokeAtSettingsRefresh = false;
    let proofs = 0;
    let effects = 0;
    let executors = 0;
    const preparationProofs: number[] = [];
    // Only Home HTTP and the installation file are substituted. The real
    // Manager verifies the exact SOURCE packet and owns each fresh admission.
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(new URL(String(url)).pathname).toBe('/v1/machines/controller/admission/verify');
      const body = raw as { proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(verifyMachineInstallationProof({ publicKey: controller.publicKey, proof: body.proof,
        payload: { version: 1, machineId: 'controller', installationId: installation.installationId,
          accountId: 'controller-owner', rpcAdmission: { context: admission, method, callerInputAuthorization: sealed,
            workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: packet } } })).toBe(true);
      proofs += 1;
      return { status: 200, data: { v: 1, ok: current } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v2/account/settings')) {
        const change = afterSettings;
        afterSettings = undefined;
        change?.();
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      }
      throw new Error(`Unexpected SOURCE preparation read: ${new URL(url).pathname}`);
    });
    const rpc = new RpcHandlerManager({ scopePrefix: 'controller', localMachineId: 'controller', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => machineAdmission.authorizeMachineRpcRequest(request, { machineId: 'controller',
        resolveCustodianAccountId: async () => 'controller-owner', resolveInstallationId: () => installation.installationId,
        verifyMachineAdmission: request => machineAdmission.verifyMachineRpcAdmissionCurrent({ ...request,
          privateKey: controller.secretKey, daemonToken: 'controller-token', serverHttpBaseUrl: 'https://requester-home.test',
          workspaceSyncSourceReceiver: { machineId: 'controller', installationId: installation.installationId, accountId: 'controller-owner' } }),
      }), prepareRequesterAccountContext: async request => {
        const before = proofs;
        try { return await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...request,
          purpose: request.purpose ?? { kind: 'external_action' }, machineId: 'controller', serverId: 'home-profile',
          serverHttpBaseUrl: 'https://requester-home.test',
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'stable-home' }),
          createExecutor: () => { executors += 1; return { execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }; },
        }); } finally { preparationProofs.push(proofs - before); }
      },
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN, async (_body, context) => {
      const custody = requesterAccountOwner.readRequesterAccountActionContext(context?.callerInputAuthorization);
      if (!custody) throw new Error('Missing admitted SOURCE custody');
      if (revokeAtSettingsRefresh) {
        current = false;
        const before = proofs;
        await channel.pushSettings('bob', {}, 2);
        expect(await custody.refreshAccountSettings()).toBe(false);
        expect(proofs).toBeGreaterThan(before);
        expect(custody.savedSecretOperationContext.readSnapshot()).toBeNull();
        return { prepared: false };
      }
      if (revokeAtOperation) current = false;
      const before = proofs;
      const allowed = await custody.isCurrent();
      expect(proofs - before).toBe(1);
      if (!allowed) return { prepared: false };
      effects += 1;
      return { prepared: true };
    });
    const invoke = async () => {
      const result = await rpc.handleRequest({ method, params: encoded, requestId: 'source-packet',
        machineAdmission: admission, callerAuthority: 'account_automation', callerInputAuthorization: sealed,
        workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: packet });
      if (result && typeof result === 'object' && 'errorCode' in result) return result;
      return await socketRpcCodec.decodeResult(content, { ok: true, result }, callId);
    };
    expect(await invoke()).toEqual({ prepared: true });
    expect(preparationProofs).toEqual([2]);
    expect(await invoke()).toEqual({ prepared: true });
    expect(preparationProofs).toEqual([2, 2]);
    expect(effects).toBe(2);

    afterSettings = () => { current = false; };
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(effects).toBe(2);
    expect(executors).toBe(2);
    expect(channel.clients.every(client => client.disconnected)).toBe(true);
    current = true;
    const beforeReplacement = proofs;
    afterSettings = () => installed.mockReturnValue({ ...installation, installationId: 'replacement' });
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(proofs - beforeReplacement).toBe(2); // Initial Manager admission and one preparation entry; no proof after retirement.
    expect(executors).toBe(2);
    installed.mockReturnValue(installation);

    revokeAtOperation = true;
    expect(await invoke()).toEqual({ prepared: false });
    expect(effects).toBe(2);
    revokeAtOperation = false;
    current = true;
    revokeAtSettingsRefresh = true;
    expect(await invoke()).toEqual({ prepared: false });
    expect(effects).toBe(2);
    expect(channel.clients.every(client => client.disconnected)).toBe(true);
  });

  it('opens finite preparation custody at its controller, keeps the worker root, and retires its private Account reads', async () => {
    const controller = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'controller-installation', createdAt: 1, publicKey: Buffer.from(controller.publicKey).toString('base64url'),
      privateKey: Buffer.from(controller.secretKey).toString('base64url') });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'terminal', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'worker', installationId: 'worker-installation',
      actionId: 'projects.compute.exec', requestId: 'run', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'worker' },
    } });
    const purpose = { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: 'controller-installation' },
      request: { sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: controller.publicKey,
      randomBytes: nacl.randomBytes });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    // The controller must never try spending the worker's effect as its own HTTP signature.
    const writes = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected controller effect proof'));
    let current = true;
    let installedCurrent = true;
    const input: Parameters<typeof requesterAccountOwner.prepareInstalledRequesterAccountActionContext>[0] = {
      authorization: sealed, purpose, machineId: 'controller', serverId: 'home-profile',
      serverHttpBaseUrl: 'https://requester-home.test', verifyWorkspaceSyncPrepareCurrent: async () => current,
      isRetainedCustodyCurrent: async () => installedCurrent,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'stable-home' }),
      ownCredentials: { token: 'alice-own', encryption: null },
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
    };
    const prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext(input);
    expect(prepared).not.toBeNull();
    let retained: ReturnType<NonNullable<import('./requesterAccountActionContext').RequesterAccountActionContext['retainCustody']>> | undefined;
    try {
      expect(prepared?.authorization.binding).toEqual(root.binding);
      expect(prepared?.authorization.requesterHttpProjection).toBeUndefined();
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      expect(custody?.credentials.token).toBe('bob-private');
      retained = custody?.retainCustody?.();
      expect(retained).toBeDefined();
      expect(await custody?.isCurrent()).toBe(true);
      current = false;
      expect(await custody?.isCurrent()).toBe(false);
      await prepared?.dispose();
      expect(await retained?.isCurrent()).toBe(true);
      installedCurrent = false;
      expect(await retained?.isCurrent()).toBe(false);
      expect(writes).not.toHaveBeenCalled();
    } finally { await retained?.release(); await prepared?.dispose(); }
    current = true;
    expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...input, authorization: root })).toBeNull();
    expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...input, authorization: {
      ...root, binding: { ...root.binding, custodianAccountId: 'bob' },
    }, ownCredentials: { token: 'bob-own', encryption: null } })).toBeNull();
    expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...input,
      verifyWorkspaceSyncPrepareCurrent: undefined })).toBeNull();
  });
  it('uses observed custody for signed HTTP and retains explicit fresh Home verification', async () => {
    const envelope = { v: 1 as const, requestId: authorization.binding.requestId,
      target: authorization.binding.target, input: {} };
    const root = { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' as const,
      serverIdentityId: 'srv_current_machine_fixture', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const actionsSettingsV1 = { v: 1, actions: { 'machines.setup.plan': { enabled: false } } };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected requester GET ${url}`);
    });
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const installation = nacl.sign.keyPair.fromSecretKey(privateKey);
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(privateKey).toString('base64url') });
    const purpose = { kind: 'external_action' } as const;
    let homeIdentity = 'srv_current_machine_fixture';
    const homeReads = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: homeIdentity } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-ordinary', secret: null, encryption: null }, installationPublicKey: installation.publicKey,
      randomBytes: nacl.randomBytes });
    // Use the installed owner; only HTTP and installation/origin OS boundaries
    // are substituted, including the real split of root and local custody.
    const prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed,
      purpose, machineId: 'machine', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: 'https://requester-home.test', resolveCurrentMachineId: () => 'machine',
      }),
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
    const admitted = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
    if (!admitted) throw new Error('Missing real private custody');
    try {
      expect(prepared?.actionsSettings).toEqual(admitted.accountSettingsContext.settings.actionsSettingsV1);
      expect(prepared?.actionsSettings).toMatchObject(actionsSettingsV1);
      // One admission decision opens this operation's custody. Constructing
      // its HTTP ports must reuse that decision; native effects reverify below.
      expect(posts.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
      posts.mockClear();
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: admitted.isCustodyCurrent });
      if (!carrier?.requesterHttpProjection) throw new Error('Missing real HTTP projection');
      expect(posts).not.toHaveBeenCalled();
      const substituted = Object.defineProperty({ ...admitted.authorization, token: 'different-operation-root' },
        'requesterAccountProjection', { value: admitted.authorization.requesterAccountProjection });
      expect(await projectExternalActionRequesterHttpAuthorization({ authorization: substituted,
        serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: admitted.isCustodyCurrent })).toBeNull();
      expect(posts).not.toHaveBeenCalled();
      reads.mockClear(); posts.mockClear(); homeReads.mockClear();
      expect(await admitted.isCurrent()).toBe(true);
      expect(homeReads.mock.calls).toHaveLength(1);
      expect({ encryption: reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness')).length,
        verify: posts.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length }).toEqual({ encryption: 0, verify: 1 });
      posts.mockClear(); homeReads.mockClear();
      posts.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { status: 200, data: { ok: true } };
      });
      const headerStarted = performance.now();
      const headers = await carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' });
      const headerMeasurement = { elapsedMs: Math.round(performance.now() - headerStarted),
        verify: posts.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length };
      expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
      // Home validates the signed effect at its destination; local signing
      // consumes this operation's admitted custody and pushed invalidation.
      expect(headerMeasurement.verify).toBe(0);
      expect(homeReads.mock.calls).toHaveLength(0);
      const handlers = new Map<string, RpcHandler>();
      const executor = createActionExecutor(createUnavailableActionTransportDeps());
      registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        machineId: 'machine', currentServerId: 'home-profile', currentServerHttpBaseUrl: 'https://requester-home.test',
        resolveAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
        externalActionMachineRequestPrivateKey: privateKey, executor,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'unused-custodian', encryption: null } }),
        verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
          installationId: 'installation', privateKey, serverHttpBaseUrl: 'https://requester-home.test' }),
        prepareRequesterAccountContext: input => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
          ...input, purpose, machineId: 'machine', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
          resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://requester-home.test', resolveCurrentMachineId: () => 'machine',
          }), createExecutor: () => executor }),
      });
      if (!('grant' in root.binding)) throw new Error('Fixture requires a scoped API principal');
      posts.mockClear();
      const dispatch = {
        actionId: root.binding.actionId, envelope, executionAuthorization: sealed,
        principal: { accountId: 'bob', principalId: 'bob', credentialId: 'pat', grant: root.binding.grant, authority: 'account_automation' },
        placement: { machineId: 'machine', target: root.binding.target },
      };
      const relay = () => handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(dispatch,
        { authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal });
      const relayed = parseExternalActionDaemonDispatchResultV1(await relay());
      expect(relayed?.kind).toBe('response');
      if (relayed?.kind !== 'response') throw new Error('Registered ingress did not reach the Action owner');
      expect(relayed.prepared.response).toMatchObject({ execution: { ok: false, errorCode: 'invalid_parameters' } });
      // Private custody admission owns the pre-open root proof. The resolved
      // effect is checked separately after preparation and target resolution.
      expect(posts.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(2);
      posts.mockResolvedValueOnce({ status: 403, data: { ok: false } });
      reads.mockClear();
      expect(await relay())
        .toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
      // The canonical custody admission must refuse a retired root before
      // requester profile/settings reads, without a redundant outer verifier.
      expect(reads).not.toHaveBeenCalled();
      posts.mockClear();
      homeIdentity = 'srv_replaced_machine_fixture';
      expect(await admitted.isCurrent()).toBe(false);
      expect(posts).not.toHaveBeenCalled();
      homeIdentity = root.binding.serverIdentityId;
      // A different Machine/local guard is a separate fact, even with the same
      // Account facet. It must still veto headers before any Home request.
      let installedCurrent = true;
      const distinct = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: async () => installedCurrent });
      expect(distinct).not.toBeNull();
      installedCurrent = false;
      reads.mockClear(); posts.mockClear();
      expect(await distinct?.requesterHttpProjection?.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' })).toBeNull();
      expect(reads).not.toHaveBeenCalled();
      expect(posts).not.toHaveBeenCalled();
    } finally {
      await admitted.dispose();
      reads.mockClear(); posts.mockClear();
      expect(await admitted.isCurrent()).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(posts).not.toHaveBeenCalled();
    }
  });

  it.each(['mode', 'signing key', 'content key', 'retirement'] as const)('refuses headers and projection output when %s changes during Home verification', async change => {
    const secret = new Uint8Array(32).fill(8);
    const mode = change === 'signing key' || change === 'content key' ? 'e2ee' : 'plain';
    const signingKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey);
    const contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
      deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey);
    const changedKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
    let currentness = { mode: mode as 'plain' | 'e2ee', version: 1, updatedAt: 1,
      signingKeyFingerprint: mode === 'e2ee' ? signingKeyFingerprint : null,
      contentKeyFingerprint: mode === 'e2ee' ? contentKeyFingerprint : null };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'e2ee'
        ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
      throw new Error(`Unexpected private requester read ${url}`);
    });
    let holdVerify = false;
    let entered!: () => void;
    let release!: () => void;
    const awaited = new Promise<void>(resolve => { entered = resolve; });
    const pendingVerify = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (!url.endsWith('/verify')) throw new Error(`Unexpected private requester write ${url}`);
      if (holdVerify) { entered(); await pendingVerify; }
      return { status: 200, data: { ok: true } };
    });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, accountEncryptionMode: mode } });
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-ordinary', encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null },
      serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: () => change === 'retirement'
        ? verifyExternalActionExecutionAuthorizationCurrent({ authorization: root, effectActionId: root.binding.actionId,
          target: root.binding.target, installationId: 'installation', privateKey, serverHttpBaseUrl: 'https://requester-home.test' })
        : Promise.resolve(true) });
    if (!admitted) throw new Error('Missing real private custody');
    const input = { authorization: admitted.authorization, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', target: root.binding.target, installationId: 'installation',
      privateKey, isCurrent: admitted.isCurrent };
    const carrier = await projectExternalActionRequesterHttpAuthorization(input);
    if (!carrier?.requesterHttpProjection) throw new Error('Missing real HTTP projection');
    holdVerify = true;
    try {
      const headers = carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list', body: { keys: [] } });
      const projection = projectExternalActionRequesterHttpAuthorization(input);
      const local = change === 'retirement' ? admitted.isCurrent() : null;
      await awaited;
      if (change === 'retirement') await admitted.dispose();
      else {
        currentness = { ...currentness, ...(change === 'mode' ? { mode: 'e2ee' as const, signingKeyFingerprint, contentKeyFingerprint }
          : change === 'signing key' ? { signingKeyFingerprint: changedKeyFingerprint } : { contentKeyFingerprint: changedKeyFingerprint }) };
        await channel.push('bob', currentness);
      }
      release();
      expect(await headers).toBeNull();
      expect(await projection).toBeNull();
      if (local) expect(await local).toBe(false);
    } finally { release(); await admitted.dispose(); }
  });

  it.each(['plain', 'e2ee'] as const)('scopes borrowed own-Account credentials without retiring installed custody (%s)', async mode => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-account-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: mode, serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: 'own-account', credentialProvenance: 'stored_session',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    const installed = { ...credentials };
    // HTTP is the system boundary; admission, provenance, scoping and projection stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'plain'
        ? { content: { t: 'plain', v: {} }, version: 0 } : { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected own-Account read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const input: Parameters<typeof requesterAccountOwner.prepareRequesterAccountActionContext>[0] = {
      authorization: root, purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
      installationPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      ownCredentials: credentials, isCurrent: async () => true,
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
    };
    const prepared = await requesterAccountOwner.prepareRequesterAccountActionContext(input);
    expect(prepared).not.toBeNull();
    expect(sameStoredCredentials(credentials, installed)).toBe(true);
    expect(credentials.requesterSessionCredentialScope).toBeUndefined();
    const requester = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
    expect(requester?.credentials).toMatchObject({ credentialProvenance: 'stored_session', requesterSessionCredentialScope: {
      serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
    } });
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(prepared?.authorization)).toEqual(root);
    await prepared?.dispose?.();
    expect(await requester?.isCurrent()).toBe(false);
    // Existing private scope remains binding; borrowing must not strip it.
    bindRequesterSessionCredentialScope(credentials, { serverId: 'other-home', serverHttpBaseUrl: 'https://other-home.test' });
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext(input)).toBeNull();
    expect(credentials.requesterSessionCredentialScope?.serverId).toBe('other-home');
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext({ ...input, isCurrent: async () => false })).toBeNull();
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext({ ...input, authorization: {
      ...root, binding: { ...root.binding, custodianAccountId: 'alice' },
    } })).toBeNull();
  });

  it.each(['plain', 'e2ee'] as const)('binds scoped Project Open ports to the observed Home before private HTTP effects (%s)', async mode => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-open', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'terminal', tokenEpoch: 0 },
      serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', accountEncryptionMode: mode,
      actionId: 'projects.open', requestId: 'open', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: 'bob', encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    // Account mode and Home root verification are HTTP boundaries; both projection owners stay real.
    const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    let current = true;
    const accountInput = { authorization: root, serverIdentityId: 'stable-home', bootstrap: bootstrap(credentials, async () => current) };
    const account = await projectRequesterAccountActionAuthorization(accountInput);
    expect(account?.requesterAccountProjection).toMatchObject({ accountId: 'bob', accountEncryptionMode: mode });
    if (!account) throw new Error('Expected admitted Project Open Account custody');
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const seal = account.requesterAccountProjection?.sealRequesterAccountContext;
    if (!seal) throw new Error('Expected admitted requester sealing port');
    const sealInput = { authorization: root, purpose: { kind: 'external_action' as const }, installationPublicKey: installation.publicKey };
    const sealed = await seal(sealInput);
    if (!sealed) throw new Error('Expected same-destination requester custody');
    const openInput = { authorization: sealed, purpose: sealInput.purpose, machineId: 'machine', installationId: 'installation',
      serverIdentityId: 'stable-home', installationPrivateKey: installation.secretKey };
    expect(openExternalActionRequesterAccountContextV1(openInput)).toEqual({
      ...encodeStoredCredentials(credentials), token: credentials.token,
    });
    expect(openExternalActionRequesterAccountContextV1({ ...openInput, installationId: 'another-installation' })).toBeNull();
    for (const binding of [{ ...root.binding, accountId: 'alice' }, { ...root.binding, serverIdentityId: 'another-home' }]) {
      expect(await seal({ ...sealInput, authorization: { ...root, binding } })).toBeNull();
    }
    const httpInput = { authorization: account, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', target: root.binding.target, installationId: 'installation',
      privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey };
    const carrier = await projectExternalActionRequesterHttpAuthorization(httpInput);
    expect(carrier?.requesterHttpProjection).toMatchObject({ accountId: 'bob', serverIdentityId: 'stable-home',
      accountEncryptionMode: mode });
    const custody = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root, credentials,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => current });
    if (!custody) throw new Error('Expected admitted installed Account custody');
    try {
      const installed = await projectExternalActionRequesterHttpAuthorization({ ...httpInput, authorization: custody.authorization });
      if (!installed) throw new Error('Expected installed HTTP projection');
      const deploymentHost = await createDeploymentTargetRoleAdmissionHost({ externalActionExecutionAuthorization: installed }, {
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        readCurrentMachineId: () => 'machine',
      });
      expect(deploymentHost).toMatchObject({ serverId: 'stable-home', credentialOwnerAccountId: 'bob' });
    } finally { await custody.dispose(); }
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(carrier)).toEqual(root);
    expect(Object.isFrozen(carrier?.requesterHttpProjection)).toBe(true);
    reads.mockClear(); posts.mockClear();
    expect(await projectRequesterAccountActionAuthorization({ ...accountInput, serverIdentityId: 'another-home' })).toBeNull();
    expect(await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root, credentials,
      serverId: 'home-profile', serverIdentityId: 'another-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => true })).toBeNull();
    expect(await projectExternalActionRequesterHttpAuthorization({ ...httpInput, serverIdentityId: 'another-home' })).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(posts).not.toHaveBeenCalled();
    expect(ExternalActionExecutionAuthorizationV1Schema.safeParse({ ...root,
      requesterHttpProjection: { ...carrier?.requesterHttpProjection, serverIdentityId: 'another-home' } }).success).toBe(false);
    current = false;
    expect(await seal(sealInput)).toBeNull();
  });

  it('keeps private custody current across unrelated Account sequence updates but retires it on encryption transitions', async () => {
    let version = 1;
    let updatedAt = 1;
    // Home root verification is the network boundary; Account custody remains real.
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      mode: 'plain', version: version++, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt,
    } }));
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob', encryption: null }) });
    expect(projected?.requesterAccountProjection).toBeDefined();
    expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(true);
    const http = projected && await projectExternalActionRequesterHttpAuthorization({ authorization: projected,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey,
      isCurrent: async () => true });
    expect(http).not.toBeNull();
    updatedAt = 2;
    expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(false);
  });
  it.each(['retained', 'denied'] as const)('retires Session input source custody at its Account Action lifetime boundary (%s)', async outcome => {
    const sessionId = 'requester-input-session';
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'session-input-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'session.message.send', requestId: 'session-input', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'session', sessionId },
    } });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    // Use another genuine Account context as source custody: its private ports
    // prove retirement without replacing the lifecycle owner with a spy.
    const source = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-session-input', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    if (!source) throw new Error('Missing real Session input source custody');
    let prepared: Awaited<ReturnType<typeof requesterAccountOwner.prepareRequesterAccountActionContext>> = null;
    let release: (() => Promise<void>) | undefined;
    try {
      prepared = await requesterAccountOwner.prepareRequesterAccountActionContext({
        authorization: outcome === 'denied' ? { ...root, binding: { ...root.binding, installationId: 'other-installation' } } : root,
        purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
        installationPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey,
        serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
        requesterSessionBootstrap: { ...bootstrap(source.credentials, source.isCurrent), getBoundSessionId: () => sessionId,
          release: source.dispose },
        isCurrent: source.isCurrent,
        createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
      });
      if (outcome === 'denied') {
        expect(prepared).toBeNull();
        expect(await source.isCurrent()).toBe(false);
        return;
      }
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      if (!prepared || !custody) throw new Error('Missing real Account Action custody');
      release = custody.retain();
      await prepared.dispose();
      expect(await custody.isCurrent()).toBe(true);
      expect(await source.isCurrent()).toBe(true);
      await release();
      expect(await custody.isCurrent()).toBe(false);
      expect(await source.isCurrent()).toBe(false);
    } finally { await prepared?.dispose(); await release?.(); await source.dispose(); }
  });
  it('retains Sync Account custody beyond Open cancellation without replaying root admission', async () => {
    const ingress = new AbortController();
    let installedCurrent = true;
    let rootCurrent = true;
    const credentials = { token: 'bob-retained-sync', encryption: null } as const;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected retained requester read');
    });
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials, serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => rootCurrent, isRetainedCustodyCurrent: async () => installedCurrent, signal: ingress.signal,
    });
    if (!admitted) throw new Error('Missing admitted requester custody');
    const retained = admitted.retainCustody?.();
    let material: Awaited<ReturnType<typeof prepareRequesterOperationMaterial>> | undefined;
    try {
      expect(retained).toBeDefined();
      material = await prepareRequesterOperationMaterial({ requesterAccount: admitted, retainedCustody: retained,
        requesterIdentity: { kind: 'isolated', separationRequired: true, homeServerIdentityId: 'stable-home', requester: {
          serverId: 'home-profile', accountId: 'bob', machineId: 'machine', installationId: 'installation' } },
        reloadController: createPluginReloadController(), signal: new AbortController().signal });
      expect(retained?.savedSecretOperationContext).toBeDefined();
      expect(material.operationContext).toBe(retained?.savedSecretOperationContext);
      ingress.abort();
      rootCurrent = false;
      await admitted.dispose();
      expect(await admitted.isCurrent()).toBe(false);
      const before = reads.mock.calls.length;
      expect(await retained?.isCurrent()).toBe(true);
      expect(await retained?.isCurrent()).toBe(true);
      expect(await material.operationContext.isCurrent()).toBe(true);
      expect(material.credentials).toBe(credentials);
      expect(reads.mock.calls).toHaveLength(before);
      expect(admitted.credentials).toBe(credentials);
      expect(admitted.authorization.binding.accountId).toBe('bob');
      installedCurrent = false;
      expect(await retained?.isCurrent()).toBe(false);
      expect(await material.isCurrent()).toBe(false);
      installedCurrent = true;
      expect(await retained?.isCurrent()).toBe(true);
      await channel.push('bob', { mode: 'e2ee', version: 2, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 2 });
      expect(await retained?.isCurrent()).toBe(false);
    } finally { await material?.dispose(); await retained?.release(); await admitted.dispose(); }
    expect(await retained?.isCurrent()).toBe(false);
    expect(await retained?.savedSecretOperationContext.isCurrent()).toBe(false);
  });

  it('keeps accepted private work current after the ingress releases custody and retires it on actual settlement', async () => {
    const admit = Reflect.get(requesterAccountOwner, 'admitRequesterAccountActionContext');
    expect(typeof admit).toBe('function');
    if (typeof admit !== 'function') throw new Error('Missing standalone requester Account admission');
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    const admitted = await admit({ authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    expect(admitted).not.toBeNull();
    if (!admitted?.authorization.requesterAccountProjection) throw new Error('Missing admitted requester projection');
    const scope = { accountId: 'bob', machineId: 'machine' };
    const runner = createActionOperationRunner({ store: createActionOperationStore(), generateOperationId: () => 'private-operation',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }) });
    let settle!: () => void;
    const nativeSettlement = new Promise<void>(resolve => { settle = resolve; });
    await runner.observe({ actionId: 'projects.script.run', scope, execute: async context => {
      const release = admitted.retain();
      try {
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home-profile',
          machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
        await nativeSettlement;
        return { ok: true, result: { requesterCurrent: await admitted.isCurrent() } };
      } finally { await release(); }
    } });
    await admitted.dispose();
    expect(await admitted.isCurrent()).toBe(true);
    settle();
    expect(await runner.waitForTerminal(scope, 'private-operation')).toMatchObject({ state: 'succeeded', result: { requesterCurrent: true } });
    expect(await admitted.authorization.requesterAccountProjection.isCurrent()).toBe(false);
  });
  it('admits an arbitrary-Machine Account invocation without creating a Session or changing daemon settings', async () => {
    const admit = Reflect.get(requesterAccountOwner, 'admitRequesterAccountActionContext');
    expect(typeof admit).toBe('function');
    if (typeof admit !== 'function') throw new Error('Missing standalone requester Account admission');
    const before = getActiveAccountSettingsSnapshot();
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
      expect(config?.headers?.Authorization).toBe('Bearer bob-ordinary');
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    let live = true;
    const context = await admit({ authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => live });
    expect(context?.authorization.requesterAccountProjection?.accountId).toBe('bob');
    expect(context?.accountSettingsContext.source).toBe('network');
    if (!context?.authorization.requesterAccountProjection) throw new Error('Missing admitted requester projection');
    const readContext = Reflect.get(requesterAccountOwner, 'readRequesterAccountActionContext');
    expect(typeof readContext).toBe('function');
    if (typeof readContext !== 'function') throw new Error('Missing admitted private custody consumer port');
    expect(readContext(context.authorization)).toBe(context);
    expect(readContext(ExternalActionExecutionAuthorizationV1Schema.parse(context.authorization))).toBeNull();
    expect(JSON.stringify(context.authorization)).not.toContain('bob-ordinary');
    expect(getActiveAccountSettingsSnapshot()).toBe(before);
    expect(reads.mock.calls.some(([url]) => String(url).includes('/sessions'))).toBe(false);
    await context.dispose();
    expect(await context.authorization.requesterAccountProjection.isCurrent()).toBe(false);
    live = false;
    expect(await admit({ authorization, credentials: { token: 'bob-ordinary', encryption: null },
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => live })).toBeNull();
  });
  it('refuses stale requester E2EE material against the published Home content fingerprint before first private writes', async () => {
    const secret = new Uint8Array(32).fill(12);
    const fingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
      deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey);
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: fingerprint, updatedAt: 1,
      } };
      throw new Error('Unexpected private requester read');
    });
    const admit = requesterAccountOwner.admitRequesterAccountActionContext;
    const input = { authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'e2ee' as const } },
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true };
    const admitted = await admit({ ...input, credentials: { token: 'bob-private', encryption: { type: 'legacy', secret } } });
    expect(admitted).not.toBeNull();
    await admitted?.dispose();
    expect(await admit({ ...input, credentials: { token: 'bob-private', encryption: {
      type: 'legacy', secret: new Uint8Array(32).fill(13),
    } } })).toBeNull();
  });
  it('uses the exact admitted source Session for a Home-proved remote Project Action', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const sourceAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      ...authorization, binding: { ...authorization.binding, machineId: 'destination', installationId: 'destination-installation',
        target: { kind: 'machine', machineId: 'destination' },
        sessionActionSource: { machineId: 'machine', installationId: 'installation' },
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'bob-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'request' } },
    });
    const admitted = { ...bootstrap({ token: 'bob-ordinary', encryption: null }), getBoundSessionId: () => 'bob-session' };
    expect((await projectRequesterAccountActionAuthorization({ authorization: sourceAuthorization,
      serverIdentityId: 'stable-home', bootstrap: admitted }))?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await projectRequesterAccountActionAuthorization({ authorization: sourceAuthorization,
      serverIdentityId: 'stable-home', bootstrap: { ...admitted, getBoundSessionId: () => 'another-session' } })).toBeNull();
  });
  it.each(['continuation', 'preflight'] as const)('projects the verified handoff %s to its exact admitted target Session without replacing the original source', async phase => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const child = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId: phase === 'preflight' ? 'session.handoff' : 'session.handoff.prepare',
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'original-caller', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'request' },
      sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
      handoffAdmission: { sessionId: 'transferred-session', sourceMachineId: 'source', targetMachineId: 'machine',
        sourceInstallationId: 'source-installation', targetInstallationId: 'installation' },
      ...(phase === 'preflight'
        ? { handoffPreflight: { rootRequestId: 'request', rootRequestEnvelopeDigest: 'b'.repeat(43) } }
        : { handoffContinuation: { handoffId: 'handoff', rootRequestId: 'request', rootRequestEnvelopeDigest: 'b'.repeat(43) } }),
    } });
    const admitted = { ...bootstrap({ token: 'bob-ordinary', encryption: null }), getBoundSessionId: () => 'transferred-session' };
    expect((await projectRequesterAccountActionAuthorization({ authorization: child,
      serverIdentityId: 'stable-home', bootstrap: admitted }))?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await projectRequesterAccountActionAuthorization({ authorization: child,
      serverIdentityId: 'stable-home', bootstrap: { ...admitted, getBoundSessionId: () => 'other-session' } })).toBeNull();
  });

  it('retains the original requester HTTP proof while attaching private Account ports on the same carrier', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    let live = true;
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: live ? 200 : 403,
      data: live ? { ok: true } : {} }));
    const original = await projectExternalActionRequesterHttpAuthorization({ authorization,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: keys.secretKey });
    if (!original?.requesterHttpProjection) throw new Error('Expected the original Home HTTP proof');
    const carrier = await projectRequesterAccountActionAuthorization({ authorization: original,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }) });
    expect(carrier?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toMatchObject({
      [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
    });
    expect(JSON.parse(JSON.stringify(carrier))).toEqual(authorization);
    live = false;
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toBeNull();
  });

  it('uses the admitted requester Artifact owner at the original Home and withholds a read after access loss', async () => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    let live = true;
    let loseAdmissionDuringRead = false;
    const header = { kind: 'prompt_doc.v2', title: 'Bob private doc' };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/access/grants')) return { status: 200, data: { artifactId, ownerAccountId: 'bob', access: 'owner', grants: [] } };
      if (loseAdmissionDuringRead) live = false;
      return { status: 200, data: { id: artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: 'private body' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }, async () => live) });
    if (!projected?.requesterAccountProjection) throw new Error('Expected admitted reader');
    const ref = { kind: 'doc' as const, serverId: 'home-profile', artifactId };
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toMatchObject({ artifactId, header,
      promptLibraryArtifact: { id: artifactId, header, body: 'private body', revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://requester-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    loseAdmissionDuringRead = true;
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toBeNull();
  });

  it('supplies Bob private-row crypto on the existing carrier without serializing private ports', async () => {
    const secret = new Uint8Array(32).fill(7);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', version: 1,
      signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1 } });
    const result = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: { type: 'legacy', secret } }) });
    const projection = result?.requesterAccountProjection;
    expect(projection).toBeDefined();
    const key = { kind: 'project-organization', serverId: 'home-profile', projectKey: 'project' } as const;
    const payload = { key, value: { pinned: true } };
    const sealed = projection!.projectAccountRowCipher.seal(payload);
    expect(createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret },
      randomBytes: length => new Uint8Array(length) }).open(key, sealed)).toEqual(payload);
    expect(() => createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
      randomBytes: length => new Uint8Array(length) }).open(key, sealed)).toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(authorization);
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(result)).toEqual(authorization);
    expect(await projection!.readArtifact({ kind: 'doc', serverId: 'another-home', artifactId: 'artifact' })).toBeNull();
  });

  it('refuses wrong requester, Home, installation and lost admission before opening any private content', async () => {
    const read = vi.spyOn(axios, 'get');
    const admitted = bootstrap({ token: 'bob', encryption: null });
    for (const binding of [
      { ...authorization.binding, accountId: 'alice' },
      { ...authorization.binding, installationId: 'replaced' },
      { ...authorization.binding, machineId: 'another-machine' },
    ]) {
      expect(await projectRequesterAccountActionAuthorization({ authorization: { ...authorization, binding },
        serverIdentityId: 'stable-home', bootstrap: admitted })).toBeNull();
    }
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'another-home', bootstrap: admitted })).toBeNull();
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'stable-home',
      bootstrap: bootstrap(admitted.credentials, async () => false) })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not turn missing E2EE material into plaintext, or expose a read that loses current admission', async () => {
    let live = true;
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      live = false;
      return { status: 200, data: { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1 } };
    });
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'stable-home',
      bootstrap: bootstrap({ token: 'bob', encryption: null }, async () => live) })).toBeNull();
  });

  it('refuses private ports when the authenticated Account mode no longer matches the Home proof', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 2,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 } });
    const e2eeProof = { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'e2ee' as const } };
    expect(await projectRequesterAccountActionAuthorization({ authorization: e2eeProof,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob', encryption: null }) })).toBeNull();
  });
});
