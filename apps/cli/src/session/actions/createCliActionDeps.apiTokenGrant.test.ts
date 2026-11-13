import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { API_TOKEN_FULL_GRANT_V1, type ActionExecutorContext } from '@happier-dev/protocol';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture,
  createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createCliActionDeps, projectCliAccountCallerContext } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { configuration } from '@/configuration';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

describe('CLI grant source attribution', () => {
  afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

  it('reads the exact Session owner using requester-signed HTTP, never the daemon bearer', async () => {
    const sessionId = 'c' + '1'.repeat(24);
    const actionId = 'session.transcript.get' as const;
    const target = { kind: 'machine' as const, machineId: 'reader-machine' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: ['reader-machine', 'source-machine'] } };
    const envelope = { v: 1 as const, requestId: 'source-read', target, input: { sessionId } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: 'home', machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const context: ActionExecutorContext = { surface: 'api', authority: 'account_automation', externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization };
    const network = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path,
        publicKey: keys.publicKey, signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'source-machine' }),
      }) } };
      throw new Error(`Unexpected network path: ${path}`);
    });
    const deps = createCliActionDeps({ token: 'daemon-bearer', credentials: { token: 'daemon-bearer', encryption: null },
      sessionId: 'bound-session', mode: 'plain', ctx: null, serverIdentityId: 'home',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    expect(await deps.resolveApiTokenGrantSessionMachineId!({ actionId, sessionId, context })).toBe('source-machine');
    expect(network).toHaveBeenCalled();
    network.mockClear();
    await expect(deps.resolveApiTokenGrantSessionMachineId!({ actionId, sessionId,
      context: { ...context, externalActionExecutionAuthorization: undefined } })).rejects.toThrow('authorization unavailable');
    expect(network).not.toHaveBeenCalled();
  });

  it('reads a Copy PAT requester-owned Bot Session for memory without private requester projections', async () => {
    const actionId = 'template.instantiate' as const;
    const serverId = configuration.activeServerId;
    const sessionId = 'c' + '5'.repeat(24);
    const target = { kind: 'machine' as const, machineId: 'writer-machine' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
      targets: { sessions: [], machines: [target.machineId] } };
    const envelope = { v: 1 as const, requestId: 'copy-memory', target, input: { source: { kind: 'draft', draftId: 'draft-1' } } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'copy-memory-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: serverId, machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(28));
    const context: ActionExecutorContext = projectCliAccountCallerContext({ surface: 'cli', authority: 'account_automation',
      externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization }, 'custodian');
    const metadata = { host: 'host', path: '/repo', machineId: target.machineId };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid owner metadata fixture');
    const row = createSessionRecordFixture({ ...createSessionNotificationContextFixture(sessionId),
      id: sessionId, ownerAccountId: 'requester', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) });
    const assertSigned = (path: string, headers: Readonly<Record<string, string>> | undefined) => {
      expect(headers).not.toHaveProperty('Authorization');
      expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path,
        publicKey: keys.publicKey, signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    };
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        assertSigned(path, config?.headers as Readonly<Record<string, string>> | undefined);
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (path === `/v2/sessions/${sessionId}`) {
        assertSigned(path, config?.headers as Readonly<Record<string, string>> | undefined);
        return { status: 200, data: { session: row } };
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const daemonToken = `header.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
    const deps = createCliActionDeps({ token: daemonToken, credentials: { token: daemonToken, encryption: null },
      sessionId: 'bound-session', mode: 'plain', ctx: null, serverId, serverHttpBaseUrl: resolveServerHttpBaseUrl(), serverIdentityId: serverId, admittedAccountEncryptionMode: 'plain',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    const read = await invokeHostReviewedChildV1({ parent: { actionId, input: envelope.input }, context,
      child: { action: 'memory.remember', role: 'memory:rule',
        input: { sessionRef: { serverId, sessionId }, expectedMetadataRevision: row.metadataVersion, text: 'Remember this.' } },
      admittedReview: { action: 'memory.remember', role: 'memory:rule', surface: 'cli' },
      execute: (_input, childContext) => deps.memoryLibrary!.readSession!({ serverId, sessionId }, childContext),
    });
    expect(read).toMatchObject({ metadata, revision: row.metadataVersion });
  });

  it('spends a scoped PAT Copy parent for a reviewed prompt create without borrowing the daemon bearer', async () => {
    const actionId = 'template.instantiate' as const;
    const target = { kind: 'machine' as const, machineId: 'writer-machine' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
      targets: { sessions: [], machines: [target.machineId] } };
    const envelope = { v: 1 as const, requestId: 'copy-prompt', target, input: { source: { kind: 'draft', draftId: 'draft-1' } } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'scoped-pat-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: 'home', machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(24));
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation',
      externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization };
    let captured: Readonly<Record<string, string>> | undefined;
    let writtenBody: unknown;
    let writtenPath: string | undefined;
    let reviewedContext: ActionExecutorContext | undefined;
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture() });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      captured = config?.headers as Readonly<Record<string, string>> | undefined;
      writtenBody = body;
      writtenPath = new URL(String(url)).pathname;
      throw new Error('captured_artifact_write');
    });
    const daemonToken = `header.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey({ token: daemonToken, encryption: null }) });
    const executor = createCliActionExecutor({ token: daemonToken, credentials: { token: daemonToken, encryption: null },
      sessionId: 'bound-session', mode: 'plain', ctx: null, serverIdentityId: 'home', admittedAccountEncryptionMode: 'plain',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    const childResult = await invokeHostReviewedChildV1({ parent: { actionId, input: envelope.input },
      context: projectCliAccountCallerContext(context, 'custodian'),
      child: { action: 'prompt_doc.create', role: 'create_instructions', input: { title: 'Bot instructions', markdown: 'Content' } },
      admittedReview: { action: 'prompt_doc.create', role: 'create_instructions', surface: 'cli' },
      execute: async (input, childContext, childActionId) => {
        reviewedContext = childContext;
        return executor.execute(childActionId, input, childContext);
      } });
    expect(captured, JSON.stringify(childResult)).toBeDefined();
    expect(captured).not.toHaveProperty('Authorization');
    expect(captured?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
      target, installationId: 'installation', requestId: envelope.requestId, method: 'POST', path: writtenPath!, body: writtenBody,
      publicKey: keys.publicKey, signature: String(captured?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    const exposurePath = '/v1/artifacts/instructions/grants';
    const nested = resolveExternalActionServerRequestHeaders({ context: reviewedContext,
      effectActionId: 'artifact.access.grants.list', method: 'GET', path: exposurePath,
      daemonToken: 'daemon-bearer', serverIdentityId: 'home', privateKey: keys.secretKey, installationId: 'installation' });
    expect(nested.ok).toBe(true);
    if (nested.ok) {
      expect(nested.headers).not.toHaveProperty('Authorization');
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path: exposurePath,
        publicKey: keys.publicKey, signature: String(nested.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    }
    const skillReads: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/v1/artifacts')) {
        skillReads.push({ path, headers: config?.headers as Readonly<Record<string, string>> });
        if (path === '/v1/artifacts/new-skill') return { status: 200, data: {
          id: 'new-skill', ownerAccountId: 'requester', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
          header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'New skill', bundleSchemaId: 'skills.skill_md_v1' }),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1,
            entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: new-skill\ndescription: Useful\n---\nUse it.').toString('base64') }] }) }),
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
          seq: 1, createdAt: 1, updatedAt: 1,
        } };
        throw new Error(`Unexpected skill Artifact path: ${path}`);
      }
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    });
    const deps = createCliActionDeps({ token: daemonToken, credentials: { token: daemonToken, encryption: null },
      sessionId: 'bound-session', mode: 'plain', ctx: null, serverIdentityId: 'home', admittedAccountEncryptionMode: 'plain',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    expect(await deps.sessionCapabilities!.resolveItem({ kind: 'skill', id: 'new-skill', sessionId: 'bound-session' }, reviewedContext!)).toBe('new-skill');
    expect(skillReads.length).toBeGreaterThan(0);
    for (const read of skillReads) {
      expect(read.headers).not.toHaveProperty('Authorization');
      expect(read.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path: read.path,
        publicKey: keys.publicKey, signature: String(read.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    }
  });

  it('signs a reviewed template Release share as the PAT parent', async () => {
    const actionId = 'template.release' as const;
    const target = { kind: 'machine' as const, machineId: 'writer-machine' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
      targets: { sessions: [], machines: [target.machineId] } };
    const envelope = { v: 1 as const, requestId: 'release-share', target, input: { draftId: 'draft-1' } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'release-pat-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: 'home', machineId: target.machineId, custodianAccountId: 'requester', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(25));
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: 'requester',
      externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization };
    const path = '/v1/artifacts/artifact-1/public-links';
    const result = await invokeHostReviewedChildV1({ parent: { actionId, input: envelope.input }, context,
      child: { action: 'artifact.public_link.create', role: 'signed_in_link', input: { artifactId: 'artifact-1' } },
      admittedReview: { action: 'artifact.public_link.create', role: 'signed_in_link', surface: 'cli' },
      execute: async (_input, childContext, childActionId) => resolveExternalActionServerRequestHeaders({
        context: childContext, effectActionId: childActionId, method: 'POST', path, body: { scope: 'signed_in' },
        daemonToken: 'daemon-bearer', serverIdentityId: 'home', privateKey: keys.secretKey, installationId: 'installation',
      }) });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.headers).not.toHaveProperty('Authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
      target, installationId: 'installation', requestId: envelope.requestId, method: 'POST', path,
      body: { scope: 'signed_in' }, publicKey: keys.publicKey,
      signature: String(result.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
  });

  it('uses the Update PAT parent for a direct prompt document preflight read', async () => {
    const actionId = 'template.updates.apply' as const;
    const target = { kind: 'machine' as const, machineId: 'writer-machine' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
      targets: { sessions: [], machines: [target.machineId] } };
    const envelope = { v: 1 as const, requestId: 'update-prompt', target, input: { sessionId: 'bot-session' } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'update-pat-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: 'home', machineId: target.machineId, custodianAccountId: 'requester', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(26));
    const context: ActionExecutorContext = { surface: 'cli', authority: 'account_automation', runtimeAccountId: 'requester',
      externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization };
    let captured: Readonly<Record<string, string>> | undefined;
    const path = '/v1/artifacts/instructions';
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      if (new URL(String(url)).pathname === path) {
        captured = config?.headers as Readonly<Record<string, string>> | undefined;
        throw new Error('captured_artifact_read');
      }
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    });
    const deps = createCliActionDeps({ token: 'daemon-bearer', credentials: { token: 'daemon-bearer', encryption: null },
      sessionId: 'bound-session', mode: 'plain', ctx: null, serverIdentityId: 'home', admittedAccountEncryptionMode: 'plain',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    await deps.promptDocGet!({ artifactId: 'instructions' }, context).catch(() => null);
    expect(captured).toBeDefined();
    expect(captured).not.toHaveProperty('Authorization');
    expect(captured?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
      target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path,
      publicKey: keys.publicKey, signature: String(captured?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
  });
});
