import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalRequestV2Schema, type ApprovalRequesterConfirmationV1, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { ArtifactRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createAccountArtifactStore } from './accountArtifactStore';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { StrictJsonValueSchema } from '@happier-dev/protocol';

const { get, put, post } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
// Only the authenticated Home transport is mocked; codecs, binding verification and recipient preparation are real.
beforeEach(() => {
  vi.spyOn(axios, 'get').mockImplementation(get);
  vi.spyOn(axios, 'put').mockImplementation(put);
  vi.spyOn(axios, 'post').mockImplementation(post);
});
afterEach(() => vi.restoreAllMocks());

const token = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;

async function fixture(mode: 'plain' | 'e2ee', recipientAccessAccountId: string | null = 'bob') {
  const ownerKey = new Uint8Array(randomBytes(32));
  const requesterKey = new Uint8Array(randomBytes(32));
  const publicKey = libsodiumPublicKeyFromSecretKey(requesterKey);
  const signingSeed = new Uint8Array(randomBytes(32));
  const signingPublicKey = ed25519.getPublicKey(signingSeed);
  const signingSecretKey = new Uint8Array([...signingSeed, ...signingPublicKey]);
  const binding = signAccountContentKeyBindingV1({ accountSigningSecretKey: signingSecretKey, contentPublicKey: publicKey });
  const credentials: StoredCredentials = { token: token('alice'), encryption: mode === 'plain' ? null : {
    type: 'dataKey', machineKey: ownerKey, publicKey: libsodiumPublicKeyFromSecretKey(ownerKey),
  } };
  const resource = await createResourceDataKey({ credentials, mode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey), 'base64');
  const actionId = 'session.title.set' as const;
  const actionArgs = { sessionId: 'bot-session', title: 'Request title' };
  const machineSeed = new Uint8Array(randomBytes(32));
  const machineSecretKey = new Uint8Array([...machineSeed, ...ed25519.getPublicKey(machineSeed)]);
  const actionRequestAttributionV1 = { requestRef: 'bob-input', requester: { serverId: 'home', accountId: 'bob' },
    persona: { serverId: 'home', sessionId: 'bot-session' }, origin: null };
  const signedOrigin = (actionId: ApprovalRequestV2['actionId'], input: unknown, requesterConfirmation: ApprovalRequesterConfirmationV1) => {
    const caller = { kind: 'session' as const, sessionId: 'bot-session', starterDepth: 0, turnDepth: 0 };
    const target = { kind: 'session' as const, sessionId: 'bot-session' };
    const origin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: 'bot-session', requesterConfirmation,
      context: { surface: 'agent', authority: 'account_automation', runtimeAccountId: 'alice',
        serverId: 'home', serverIdentityId: 'stable-home', actionRequestId: 'action-request',
        defaultSessionId: 'bot-session', actionCaller: caller, callerPermissionMode: 'yolo',
        sessionInputSource: { sourceSessionId: 'bot-session', sourceTurnId: 'turn-1', via: 'action' },
        actionRequestAttributionV1,
        externalActionTarget: target,
        externalActionExecutionAuthorization: { v: 1, token: 'home-admitted-source', binding: {
          serverIdentityId: 'stable-home', accountId: 'alice', custodianAccountId: 'alice',
          machineId: 'machine-1', installationId: 'installation', actionId, requestId: 'action-request', target,
          authentication: { kind: 'account', tokenEpoch: 0 },
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'action-request', target, input: StrictJsonValueSchema.parse(input) }),
          sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', requestId: 'action-request',
            actionRequestAttributionV1 },
          sessionActionSource: { machineId: 'machine-1', installationId: 'installation' },
        } },
        signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
          actionId: args.actionId, input: args.input, target: args.target, privateKey: machineSecretKey,
          requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
      } });
    if (!origin) throw new Error('Expected signed approval origin');
    return origin;
  };
  const requesterConfirmation = { requestRef: 'bob-input', requesterAccountId: 'bob', executionAccountId: 'alice',
    personaSessionRef: { serverId: 'home', sessionId: 'bot-session' },
    inputDigest: computeActionInputApprovalDigestV1(actionId, actionArgs) };
  const request = {
    v: 2 as const, status: 'open' as const, createdAtMs: 100, updatedAtMs: 100,
    createdBy: { surface: 'agent' as const, sessionId: 'bot-session' }, actionId, actionArgs, summary: 'Set title',
    executionOriginV1: signedOrigin(actionId, actionArgs, requesterConfirmation), requesterConfirmation,
  };
  const stored = { id: 'approval', ownerAccountId: 'alice', access: 'owner' as 'owner' | 'view', encryptionMode: mode,
    publicAudience: 'none', header: encode(buildApprovalRequestArtifactHeaderV1(request)),
    body: encode({ body: JSON.stringify(request) }), headerVersion: 1, bodyVersion: 1,
    dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
    seq: 1, createdAt: 100, updatedAt: 100 };
  const grants: string[] = [];
  let recipientAccessLevel: 'edit' | 'view' | null = 'edit';
  let envelope: ArtifactRecipientKeyEnvelopeCommitInputV1['recipientKeyEnvelopes'][number] | undefined;
  get.mockImplementation(async (url: string, config: { headers: { Authorization: string } }) => {
    const accountId = config.headers.Authorization === `Bearer ${token('alice')}` ? 'alice'
      : config.headers.Authorization === `Bearer ${token('bob')}` ? 'bob' : 'carol';
    if (url.endsWith('/recipients')) return { status: 200, data: { artifactId: stored.id, ownerAccountId: 'alice', access: accountId === 'alice' ? 'owner' : 'view',
      encryptionMode: mode, dataEncryptionKey: resource.mode === 'plain' ? null : stored.dataEncryptionKey,
      callerDataEncryptionKey: resource.mode === 'plain' ? null : accountId === 'alice' ? stored.dataEncryptionKey : envelope?.encryptedDataKey,
      recipients: grants.map(recipientAccountId => ({ recipientAccountId,
        contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signingPublicKey).toString('hex'),
          contentPublicKey: encodeBase64(publicKey), contentPublicKeySignature: encodeBase64(binding) },
        contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey), encryptedDataKey: envelope?.encryptedDataKey ?? null,
        recipientContentPublicKeyFingerprint: envelope?.recipientContentPublicKeyFingerprint ?? null })) } };
    if (!url.endsWith(`/v1/artifacts/${encodeURIComponent(stored.id)}`)) {
      return { status: 404, data: { error: 'artifact_not_found' } };
    }
    if (accountId !== 'alice' && !grants.includes(accountId)) return { status: 404, data: { error: 'artifact_not_found' } };
    return { status: 200, data: { ...stored, access: accountId === 'alice' ? stored.access : 'view',
      ...(accountId !== 'alice' && resource.mode === 'e2ee' ? { dataEncryptionKey: envelope?.encryptedDataKey } : {}) } };
  });
  put.mockImplementation(async (_url: string, input: { principal: { accountId: string }; accessLevel: string }) => {
    expect(input.accessLevel).toBe('view');
    grants.push(input.principal.accountId);
    return { status: 200, data: { artifactId: stored.id, ownerAccountId: 'alice', access: 'owner', changed: true,
      grants: [{ principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'alice', createdAt: 100, display: { name: null } }] } };
  });
  post.mockImplementation(async (url: string, input: ArtifactRecipientKeyEnvelopeCommitInputV1) => {
    if (url.endsWith('/v2/sessions/access-grants/list')) {
      expect(input).toEqual({ sessionId: 'bot-session', recipientAccountId: 'bob' });
      return { status: 200, data: { visibility: 'complete', owner: { kind: 'account', accountId: 'alice', name: null,
          firstName: null, lastName: null, username: null, avatarUrl: null },
        primaryTeamId: null, grants: [], effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
          capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
        ...(recipientAccessAccountId === null ? {} : { recipientAccess: { accountId: recipientAccessAccountId, effectiveAccess: recipientAccessLevel === null ? null : {
          v: 1, level: recipientAccessLevel, sources: [{ kind: 'direct', shareId: 'share-bob' }],
          capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: recipientAccessLevel, canApprovePermissions: false }] }),
        } } }) } };
    }
    if (url.endsWith('/v1/artifacts')) {
      stored.id = String(Reflect.get(input, 'id'));
      stored.header = String(Reflect.get(input, 'header'));
      stored.body = String(Reflect.get(input, 'body'));
      stored.dataEncryptionKey = String(Reflect.get(input, 'dataEncryptionKey'));
      return { status: 200, data: { id: stored.id, headerVersion: 1, bodyVersion: 1 } };
    }
    expect(input.recipientKeyEnvelopes.map(item => item.recipientAccountId)).toEqual(['bob']);
    envelope = input.recipientKeyEnvelopes[0];
    return { status: 200, data: { appliedRecipientAccountIds: ['bob'], skippedRecipientAccountIds: [] } };
  });
  const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => mode });
  return { store, stored, request, encode, grants, requesterKey, credentials, signedOrigin,
    setRecipientAccess: (level: typeof recipientAccessLevel) => { recipientAccessLevel = level; } };
}

describe('approval requester Artifact recipient', () => {
  beforeEach(() => { get.mockReset(); put.mockReset(); post.mockReset(); });

  it.each([null, 'carol'])('refuses absent or mismatched current recipient evidence (%s)', async accountId => {
    const f = await fixture('plain', accountId);
    await expect(f.store.prepareApprovalRequesterRecipient({ artifactId: 'approval', requesterAccountId: 'bob', sessionId: 'bot-session' }))
      .rejects.toMatchObject({ code: 'artifact_approval_requester_invalid' });
    expect(f.grants).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(post.mock.calls.every(([url]) => String(url).endsWith('/v2/sessions/access-grants/list'))).toBe(true);
  });

  it.each(['plain', 'e2ee'] as const)('refuses a revoked or View-only requester before granting a %s preview', async mode => {
    const f = await fixture(mode);
    const approvals = createCliApprovalsArtifactStore({ credentials: f.credentials,
      serverId: 'home', getAccountEncryptionMode: async () => mode });
    for (const level of [null, 'view'] as const) {
      f.setRecipientAccess(level);
      await expect(approvals.approvalsCreate({ request: f.request, serverId: 'home' }))
        .rejects.toMatchObject({ code: 'artifact_approval_requester_invalid' });
      expect(f.grants).toEqual([]);
      expect(put).not.toHaveBeenCalled();
      expect(post.mock.calls.filter(([url]) => !String(url).endsWith('/v1/artifacts')
        && !String(url).endsWith('/v2/sessions/access-grants/list'))).toEqual([]);
    }
  });

  it('refuses an unsigned requester subject before preparing its preview recipient', async () => {
    const f = await fixture('plain');
    const { externalActionExecutionAuthorization: _authorization, externalActionInputSignature: _signature, ...origin } =
      ApprovalRequestV2Schema.parse(f.request).executionOriginV1;
    f.stored.body = f.encode({ body: JSON.stringify({ ...f.request, executionOriginV1: origin }) });
    await expect(f.store.prepareApprovalRequesterRecipient({ artifactId: 'approval', requesterAccountId: 'bob', sessionId: 'bot-session' }))
      .rejects.toMatchObject({ code: 'artifact_approval_requester_invalid' });
    expect(f.grants).toEqual([]);
  });

  it('prepares the requester preview through the production approval Artifact creator', async () => {
    const f = await fixture('plain');
    const approvals = createCliApprovalsArtifactStore({ credentials: f.credentials,
      serverId: 'home', getAccountEncryptionMode: async () => 'plain' });
    const created = await approvals.approvalsCreate({ request: f.request, serverId: 'home' });
    expect(f.grants).toEqual(['bob']);
    const bob = createAccountArtifactStore({ credentials: { token: token('bob'), encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const preview = await bob.read(created.artifactId, { includeSharedAudience: false });
    expect(preview).toMatchObject({ ownerAccountId: 'alice', access: 'view' });
    expect(preview?.body && JSON.parse(preview.body)).toEqual(f.request);
  });

  it.each(['plain', 'e2ee'] as const)('opens Alice’s exact %s approval read-only for Bob and refuses Carol', async mode => {
    const f = await fixture(mode);
    await f.store.prepareApprovalRequesterRecipient({ artifactId: 'approval', requesterAccountId: 'bob', sessionId: 'bot-session' });
    expect(f.grants).toEqual(['bob']);
    const bob = createAccountArtifactStore({ credentials: { token: token('bob'), encryption: mode === 'plain' ? null : {
      type: 'dataKey', machineKey: f.requesterKey, publicKey: libsodiumPublicKeyFromSecretKey(f.requesterKey),
    } }, getAccountEncryptionMode: async () => mode });
    const preview = await bob.read('approval', { includeSharedAudience: false });
    expect(preview).toMatchObject({ ownerAccountId: 'alice', access: 'view', body: JSON.stringify(f.request) });
    const carol = createAccountArtifactStore({ credentials: { token: token('carol'), encryption: null }, getAccountEncryptionMode: async () => 'plain' });
    expect(await carol.read('approval')).toBeNull();
    expect(ApprovalRequestV2Schema.parse(JSON.parse(String(preview?.body))).requesterConfirmation).toEqual(f.request.requesterConfirmation);
  });

  it('prepares the same requester recipient for the existing plugin target-action carrier', async () => {
    const f = await fixture('plain');
    const input = { title: 'Post the update' };
    const invocation = { action: { pluginId: 'acme.example', localId: 'post' }, input };
    const requesterConfirmation = { ...f.request.requesterConfirmation,
      inputDigest: computeActionInputApprovalDigestV1('action.invoke', invocation) };
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1 as const, kind: 'plugin_target_action' as const, status: 'open' as const,
      createdAtMs: 100, updatedAtMs: 100, createdBy: f.request.createdBy, requestedSurface: 'agent',
      qualifiedActionId: 'acme.example/actions/post', input,
      sourceCustody: { kind: 'development' as const, registeredRootId: 'example-source' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Post update',
      executionOriginV1: f.signedOrigin('action.invoke', invocation, requesterConfirmation), requesterConfirmation,
    });
    const approvals = createCliApprovalsArtifactStore({ credentials: f.credentials,
      serverId: 'home', getAccountEncryptionMode: async () => 'plain' });
    await approvals.targetActionApprovalsCreate({ request });
    expect(f.grants).toEqual(['bob']);
  });

  it.each(['requester', 'session', 'execution', 'header', 'digest', 'extra', 'missing', 'view'] as const)('rejects a mismatched %s before preparing any recipient', async mismatch => {
    const f = await fixture('plain');
    const input = { artifactId: 'approval', requesterAccountId: 'bob', sessionId: 'bot-session' };
    if (mismatch === 'requester') input.requesterAccountId = 'carol';
    if (mismatch === 'session') input.sessionId = 'other-session';
    if (mismatch === 'execution') f.request.requesterConfirmation.executionAccountId = 'carol';
    if (mismatch === 'header') f.stored.header = f.encode({ ...buildApprovalRequestArtifactHeaderV1(f.request), sessionId: 'other-session' });
    if (mismatch === 'digest') f.request.actionArgs.title = 'Changed title';
    if (mismatch === 'extra') Reflect.set(f.request.requesterConfirmation, 'recipientAccountId', 'carol');
    if (mismatch === 'missing') Reflect.deleteProperty(f.request, 'requesterConfirmation');
    if (mismatch === 'view') f.stored.access = 'view';
    f.stored.body = f.encode({ body: JSON.stringify(f.request) });
    await expect(f.store.prepareApprovalRequesterRecipient(input)).rejects.toMatchObject({ code: 'artifact_approval_requester_invalid' });
    expect(f.grants).toEqual([]);
  });
});
