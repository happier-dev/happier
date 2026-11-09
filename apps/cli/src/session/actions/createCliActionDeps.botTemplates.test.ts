import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { BotTemplateFollowResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1, projectSessionOwnerCompatibilityViewV1,
  SessionMetadataOwnerPatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture,
  createSessionReadBatchResponseFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps, projectCliAccountCallerContext } from './createCliActionDeps';
import { configuration } from '@/configuration';

afterEach(() => vi.restoreAllMocks());

describe('CLI template private Session transport', () => {
  it('reads a PAT requester-owned recipient Session through the signed parent without borrowing the daemon Account', async () => {
    const serverId = configuration.activeServerId;
    const sessionId = 'c' + '4'.repeat(24);
    const target = { kind: 'machine' as const, machineId: 'writer-machine' };
    const actionId = 'template.updates.skip' as const;
    const grant = { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: [actionId] },
      targets: { sessions: [], machines: [target.machineId] } };
    const input = { sessionRef: { serverId, sessionId }, version: '1.0.0' };
    const envelope = { v: 1 as const, requestId: 'requester-owned-recipient', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-pat-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: serverId, machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
    const context: ActionExecutorContext = projectCliAccountCallerContext({ surface: 'cli', authority: 'account_automation',
      serverId, externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization }, 'custodian');
    const owner = createSessionOwnerMetadataV1({ metadata: { host: 'host', path: '/repo' } });
    if (!owner.ok) throw new Error('Invalid owner metadata fixture');
    const row = createSessionRecordFixture({ ...createSessionNotificationContextFixture(sessionId),
      id: sessionId, ownerAccountId: 'requester', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: { host: 'host', path: '/repo' }, agentState: null })),
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
    const deps = createCliActionDeps({ token: daemonToken,
      credentials: { token: daemonToken, encryption: null }, sessionId: 'bound-session', serverId, serverIdentityId: serverId,
      serverHttpBaseUrl: configuration.apiServerUrl, mode: 'plain', ctx: null,
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    expect(await deps.botTemplateAction!({ actionId, input, context })).toMatchObject({ ok: false, errorCode: 'template_instance_unavailable' });
  });

  it('reads an admitted same-Account template recipient Session with the installed Account credential', async () => {
    const serverId = configuration.activeServerId;
    const sessionId = 'c' + '5'.repeat(24);
    const actionId = 'template.updates.skip' as const;
    const target = { kind: 'machine' as const, machineId: 'writer-machine' };
    const input = { sessionRef: { serverId, sessionId }, version: '1.0.0' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'ordinary-template-root', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: serverId,
      machineId: target.machineId, custodianAccountId: 'owner', installationId: 'installation', actionId,
      requestId: 'ordinary-template', target, requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain',
    } });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
    const context: ActionExecutorContext = projectCliAccountCallerContext({ surface: 'cli', authority: 'account_automation',
      serverId, externalActionTarget: target, externalActionExecutionAuthorization: authorization }, 'owner');
    const owner = createSessionOwnerMetadataV1({ metadata: { host: 'host', path: '/repo' } });
    if (!owner.ok) throw new Error('Invalid owner metadata fixture');
    const row = createSessionRecordFixture({ ...createSessionNotificationContextFixture(sessionId), id: sessionId,
      ownerAccountId: 'owner', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: { host: 'host', path: '/repo' }, agentState: null })),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) });
    const reads: string[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      if (path !== '/v1/account/encryption/currentness' && path !== `/v2/sessions/${sessionId}`)
        throw new Error(`Unexpected GET ${path}`);
      reads.push(path);
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      expect(config?.headers).not.toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
      return path === `/v2/sessions/${sessionId}` ? { status: 200, data: { session: row } }
        : { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'bound-session',
      serverId, serverIdentityId: serverId, serverHttpBaseUrl: configuration.apiServerUrl, mode: 'plain', ctx: null });
    expect(await deps.botTemplateAction!({ actionId, input, context }))
      .toMatchObject({ ok: false, errorCode: 'template_instance_unavailable' });
    expect(reads).toContain(`/v2/sessions/${sessionId}`);
  });

  it('stops following through the private field writer while preserving instructions and other owner work', async () => {
    const accountId = 'template-recipient';
    const serverId = configuration.activeServerId;
    const sessionId = 'c000000000000000000000003';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const instance = BotTemplateFollowResultV1Schema.shape.instance.parse({ v: 1,
      source: { kind: 'artifact', serverId, artifactId: '80f7dabe-1f05-44b7-8e44-d98f2127f523' }, acceptedVersion: '1.0.0',
      acceptedBase: { serverId, artifactId: '70f7dabe-1f05-44b7-8e44-d98f2127f523' }, skillIds: {}, mcpServerIds: {}, follow: true });
    const metadata = { host: 'host', path: '/repo', machineId: 'machine', work: { templateInstance: instance,
      promptStack: [{ id: 'session.instructions', ref: { kind: 'doc' as const, serverId,
        artifactId: '60f7dabe-1f05-44b7-8e44-d98f2127f523' }, enabled: true, placement: 'system_append' as const }] } };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid owner metadata fixture');
    let row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: false,
      ownerAccountId: accountId, metadataLayoutVersion: 1, share: null,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata) });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
      throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
      if (new URL(String(url)).pathname === '/v2/sessions/read-batch') return { status: 200,
        data: createSessionReadBatchResponseFixture({ request: input, sessions: [row] }) };
      throw new Error('Unexpected POST');
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (_url, input) => {
      const patch = SessionMetadataOwnerPatchV1Schema.parse(input);
      expect(patch.expectedOwnerMetadata).toEqual(row.ownerMetadata);
      row = { ...row, ownerMetadata: patch.ownerMetadata, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: row.metadataVersion + 1, agentState: patch.agentState.ciphertext,
        agentStateVersion: (row.agentStateVersion ?? 0) + 1 };
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
    });
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId, serverId, serverHttpBaseUrl: configuration.apiServerUrl, mode: 'plain', ctx: null }));
    expect(await executor.execute('template.follow.stop', { sessionRef: { serverId, sessionId } },
      { surface: 'cli', authority: 'present_user', serverId })).toMatchObject({ ok: true, result: { changed: true } });
    if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain private metadata');
    const persisted = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata!), ownerMetadata: row.ownerMetadata.v });
    expect(persisted.work).toEqual({ ...metadata.work, templateInstance: { ...instance, follow: false } });
  });
});
