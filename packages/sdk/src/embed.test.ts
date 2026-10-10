import { afterEach, describe, expect, it, vi } from 'vitest';

// HTTP is the system boundary; SDK grant composition, identity binding and
// result admission stay real beneath this adapter.
vi.mock('undici', () => ({
  Agent: class { async destroy() {} },
  request: async (url: URL, options: RequestInit) => {
    const response = await fetch(url, options);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { statusCode: response.status, headers: {}, body: {
      destroy() {}, async *[Symbol.asyncIterator]() { yield bytes; },
    } };
  },
}));

import { connect } from './index.js';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import {
  deriveBoxPublicKeyFromSeed, openBoxBundle, openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1, wrapApiTokenEncryptionAccessV1, V2SessionByIdResponseSchema,
} from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxSecretKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { sealSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions';
import { EmbedSessionOptionsV1Schema } from '@happier-dev/protocol/embed';

const TOKEN_ID = '123e4567-e89b-42d3-a456-426614174000';
const TOKEN = `hap_v1_${TOKEN_ID}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`;
const config = { v: 1, ui: { attachments: true }, newChat: { enabled: true },
  organization: { folderId: 'leads', tagIds: ['inbound', 'hot'] }, style: null };
const grant = { v: 1, actions: { families: ['session_transcripts', 'session_targeting', 'messaging'],
  ids: ['session.spawn_new', 'session.model.set'] }, targets: null, approve: true,
  origins: ['https://crm.example'], models: null, permissionModes: ['default'],
  create: { machineId: 'machine-1', agentTargetKey: 'agent:happier.agent.claude/claude', directory: 'managed',
    placement: config.organization } };
const self = { accountId: 'account-1', accountEncryptionMode: 'plain', credentialId: TOKEN_ID, parentTokenId: null,
  expiresAt: null, grant, embedConfig: config };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
// The real HTTP owner validates this recipient projection before returning it.
const plainSession = V2SessionByIdResponseSchema.parse({ session: { id: 'session-1', seq: 0, createdAt: 0, updatedAt: 0,
  active: false, activeAt: 0, encryptionMode: 'plain', metadata: '{}', metadataVersion: 0,
  agentState: null, agentStateVersion: 0, dataEncryptionKey: null } }).session;
function mintResponse(body: Record<string, unknown>) {
  const id = String(body.tokenId);
  return json({ token: `hap_v1_${id}_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    apiToken: { tokenId: id, label: String(body.label), displayPrefix: `hap_v1_${id.slice(0, 8)}`,
      createdAt: '2026-09-30T00:00:00.000Z', lastUsedAt: null, expiresAt: body.expiresAt,
      hasEncryptionAccess: false, hasUnattendedTeamAccess: false, grant: body.grant,
      parentTokenId: TOKEN_ID, activeChildCount: 0, embedConfig: null } });
}

afterEach(() => vi.unstubAllGlobals());

describe('SDK embed helpers', () => {
  it('reads the authenticated embed configuration and refuses an ordinary API key', async () => {
    const fetchBoundary = vi.fn(async (_url: URL | RequestInfo, _options?: RequestInit) => json(self));
    vi.stubGlobal('fetch', fetchBoundary);
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      await expect(client.embed.get()).resolves.toEqual(config);
      expect(String(fetchBoundary.mock.calls[0]?.[0])).toBe('https://happier.example/v1/auth/api-tokens/self');
      fetchBoundary.mockImplementation(async () => json({ ...self, embedConfig: null }));
      await expect(client.embed.get()).rejects.toMatchObject({ code: 'not_an_embed_key' });
    } finally { await client.close(); }
  });

  it('attenuates session and new-chat children and sends attribution to the mint owner', async () => {
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      const path = url.pathname;
      const body = options.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
      requests.push({ path, body });
      if (path.endsWith('/self')) return json(self);
      if (path.endsWith('/children/create')) {
        return mintResponse(body ?? {});
      }
      return json({ session: plainSession });
    }));
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      const created = await client.embed.createCredential({ sessionId: 'session-1',
        embedPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
        expiresInSeconds: 900, requireCreatedBy: TOKEN_ID });
      expect(created).toEqual({ token: expect.stringContaining('hap_v1_'), tokenId: expect.any(String),
        expiresAt: expect.any(String) });
      const sessionMint = requests.find((r) => r.path.endsWith('/children/create'))?.body;
      expect(sessionMint?.requireCreatedByChildTokenId).toBe(TOKEN_ID);
      expect(sessionMint?.grant).toEqual({ ...grant, actions: {
        families: ['session_transcripts', 'messaging'], ids: ['session.model.set'] },
        targets: { sessions: ['session-1'], machines: [] }, create: null });
      requests.length = 0;
      const newChat = await client.embed.createCredential({
        embedPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw', expiresInSeconds: 900 });
      expect(newChat.tokenId).toEqual(expect.any(String));
      expect(requests.find((r) => r.path.endsWith('/children/create'))?.body?.grant).toEqual({
        ...grant, actions: { families: [], ids: ['session.spawn_new'] }, approve: false,
        targets: { sessions: [], machines: ['machine-1'] } });
      expect(requests.some((r) => r.path.endsWith('/revoke'))).toBe(false);
    } finally { await client.close(); }
  });

  it('refuses an empty listing filter before it could list the whole account', async () => {
    const fetchBoundary = vi.fn(async () => json({ ...self, embedConfig: {
      ...config, organization: { folderId: null, tagIds: [] } } }));
    vi.stubGlobal('fetch', fetchBoundary);
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      await expect(client.embed.listSessions()).rejects.toMatchObject({ code: 'listing_filter_required' });
      expect(fetchBoundary).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });

  it('uses independent organization defaults and passes ANY tags to the canonical listing owner', async () => {
    const queries: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      if (url.pathname.endsWith('/self')) return json({ ...self, grant: { ...grant, create: null } });
      const body = JSON.parse(String(options.body)) as { requestId: string; input: { query: unknown } };
      queries.push(body.input.query);
      return json({ v: 1, actionId: 'session.list', requestId: body.requestId, execution: { ok: true,
        result: { queryVersion: 1, sessions: [], nextCursor: null, hasNext: false,
          attentionNextCursor: null, attentionHasNext: false } } });
    }));
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      await expect(client.embed.listSessions()).resolves.toMatchObject({ sessions: [] });
      expect(queries[0]).toMatchObject({ folderIds: ['leads'], tagIds: ['hot', 'inbound'] });
      await client.embed.listSessions({ folderId: null, tagIds: ['other'], includeInactive: false });
      expect(queries[1]).toMatchObject({ folderIds: [], tagIds: ['other'], includeInactive: false });
      await expect(client.embed.listSessions({ folderId: null, tagIds: [] })).rejects.toMatchObject({ code: 'listing_filter_required' });
      expect(queries).toHaveLength(2);
    } finally { await client.close(); }
  });

  it('reuses the spawn owner and its retry identity with all grant bounds', async () => {
    const spawns: Array<Record<string, unknown>> = [];
    const model = { agentTargetKey: grant.create.agentTargetKey, providerConnectionId: null, modelId: 'model-safe' };
    let refuseInitialInput = false;
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      if (url.pathname.endsWith('/self')) return json({ ...self, grant: { ...grant, models: [model] },
        embedConfig: { ...config, newChat: { enabled: false } } });
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      const actionId = url.pathname.split('/').at(-1);
      let result: unknown;
      // The embed's creation grant permits spawn, not unrelated Agent discovery.
      // Its qualified target already supplies the identity; the real spawn owner
      // remains responsible for installed/enabled admission.
      if (actionId === 'agents.backends.list') return new Response(
        JSON.stringify({ error: 'credential_scope_denied' }), { status: 403 },
      );
      else {
        spawns.push(body);
        result = { type: 'success', disposition: spawns.length === 1 ? 'created' : 'rejoined',
          sessionId: 'session-1', executionTarget: { serverId: 'home', machineId: 'machine-1' },
          organizationPlacement: config.organization, initialInput: refuseInitialInput
            ? { status: 'rejected', code: 'session_input_archived' } : { status: 'accepted', localId: 'first' } };
      }
      return json({ v: 1, actionId, requestId: body.requestId, execution: { ok: true, result } });
    }));
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      const input = { title: 'Lead', initialMessage: 'Analyse this lead', permissionMode: 'bypassPermissions' as const };
      expect((await client.embed.createSession(input, { requestId: 'lead-creation' })).id).toBe('session-1');
      expect((await client.embed.createSession(input, { requestId: 'lead-creation' })).id).toBe('session-1');
      expect(spawns[0]).toEqual({ v: 1, requestId: 'lead-creation', target: { kind: 'machine', machineId: 'machine-1' },
        input: { directory: { kind: 'managed' },
          organizationPlacement: config.organization, permissionMode: 'default',
          modelSelection: { v: 1, ref: model, updatedAt: 0 },
          title: 'Lead', initialInput: { text: 'Analyse this lead' },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } });
      expect(spawns[1]).toEqual(spawns[0]);
      refuseInitialInput = true;
      await expect(client.embed.createSession(input, { requestId: 'another-lead' })).rejects.toMatchObject({
        name: 'HappierSessionInitialInputError', session: { id: 'session-1' },
        result: { initialInput: { status: 'rejected', code: 'session_input_archived' } } });
    } finally { await client.close(); }
  });

  it('refuses unavailable creation and disabled new chats without minting a child', async () => {
    let currentSelf: unknown = { ...self, grant: { ...grant, create: null,
      actions: { ...grant.actions, ids: ['session.model.set'] } } };
    const fetchBoundary = vi.fn(async () => json(currentSelf));
    vi.stubGlobal('fetch', fetchBoundary);
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      const input = { embedPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw', expiresInSeconds: 900 };
      await expect(client.embed.createSession({})).rejects.toMatchObject({ code: 'create_not_granted' });
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'create_not_granted' });
      currentSelf = { ...self, embedConfig: { ...config, newChat: { enabled: false } } };
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'new_chat_disabled' });
      expect(fetchBoundary.mock.calls).toHaveLength(3);
    } finally { await client.close(); }
  });

  it('passes a server attribution refusal through with no revoke or session read', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      paths.push(url.pathname);
      return url.pathname.endsWith('/self') ? json(self) : json({ error: 'api_token_child_invalid' }, 400);
    }));
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      await expect(client.embed.createCredential({ sessionId: 'session-1',
        embedPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw',
        expiresInSeconds: 900, requireCreatedBy: TOKEN_ID })).rejects.toMatchObject({
        code: 'api_token_child_invalid', status: 400 });
      expect(paths).toEqual(['/v1/auth/api-tokens/self', '/v1/auth/api-tokens/children/create']);
    } finally { await client.close(); }
  });

  it('seals only the bounded composer projection and DEK for an E2EE frame, preserving the root key for reuse', async () => {
    const accountSeed = new Uint8Array(32).fill(19);
    const accountKey = deriveBoxSecretKeyFromSeed(accountSeed);
    const wrappingSecret = new Uint8Array(32).fill(7);
    const frameKey = new Uint8Array(32).fill(23);
    const dataKey = new Uint8Array(32).fill(29);
    const context = { serverIdentityId: 'srv_embed', accountId: self.accountId, tokenId: TOKEN_ID,
      contentPublicKey: encodeBase64(deriveBoxPublicKeyFromSeed(accountSeed), 'base64') };
    const hapc = formatAccountApiTokenCredentialV1({
      bearer: `hap_v1_${TOKEN_ID}_${encodeBase64(new Uint8Array(32).fill(8), 'base64url')}`,
      serverIdentityId: context.serverIdentityId, accountId: context.accountId, contentPublicKey: context.contentPublicKey,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url') });
    const randomness = (length: number) => new Uint8Array(length).fill(31);
    const encryptionAccess = wrapApiTokenEncryptionAccessV1({ context, wrappingSecret,
      contentPrivateKey: accountKey, randomBytes: randomness });
    const modelOverrideV1 = { v: 1, updatedAt: 123, modelId: 'model-safe' };
    const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'dataKey', machineKey: accountKey },
      ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1, nativeSession: { claudeSessionId: 'private-native-id' },
        runtime: { modelOverrideV1, archiveReason: 'private archive reason' } }), randomBytes: randomness });
    let session = V2SessionByIdResponseSchema.parse({ session: { ...plainSession,
      metadataLayoutVersion: 1, share: null, encryptionMode: 'e2ee', ownerMetadata,
      dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
        recipientPublicKey: deriveBoxPublicKeyFromSeed(accountSeed), randomBytes: randomness }), 'base64') } }).session;
    let bootstraps = 0;
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      paths.push(url.pathname);
      if (url.pathname.endsWith('/self')) return json({ ...self, accountEncryptionMode: 'e2ee' });
      if (url.pathname.endsWith('/children/create')) return mintResponse(JSON.parse(String(options.body)) as Record<string, unknown>);
      if (url.pathname.endsWith('/children/revoke')) return json({ revoked: true });
      if (url.pathname.endsWith('/encryption-access')) {
        bootstraps++;
        return json({ v: 1, accountId: context.accountId, tokenId: TOKEN_ID, encryptionAccess });
      }
      return json({ session });
    }));
    const client = connect({ endpoint: 'https://happier.example', token: hapc });
    try {
      const standaloneEnvelope = session.dataEncryptionKey;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt === 2) session = { ...session, encryptionMode: 'plain', dataEncryptionKey: null };
        if (attempt === 3) {
          const { ownerMetadata: _ownerMetadata, ...layoutZero } = session;
          session = V2SessionByIdResponseSchema.parse({ session: { ...layoutZero, metadataLayoutVersion: 0,
            encryptionMode: 'e2ee', dataEncryptionKey: standaloneEnvelope } }).session;
        }
        const issued = await client.embed.createCredential({ sessionId: session.id, expiresInSeconds: 900,
          embedPublicKey: encodeBase64(deriveBoxPublicKeyFromSeed(frameKey), 'base64url') });
        if (attempt === 2) expect(issued.sessionKey).toBeUndefined();
        else expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(issued.sessionKey!, 'base64'),
          recipientSecretKeyOrSeed: frameKey })).toEqual(dataKey);
        if (attempt === 3) {
          expect(issued.sessionOptions).toBeUndefined();
          continue;
        }
        const plaintext = openBoxBundle({ bundle: decodeBase64(issued.sessionOptions!, 'base64url'),
          recipientSecretKeyOrSeed: frameKey });
        expect(plaintext).not.toBeNull();
        expect(EmbedSessionOptionsV1Schema.parse(JSON.parse(new TextDecoder().decode(plaintext!)))).toEqual({
          v: 1, sessionId: session.id, owner: { modelOverrideV1 } });
      }
      expect(bootstraps).toBe(1);
      expect(paths.some((path) => path.endsWith('/revoke'))).toBe(false);
      session = { ...session, metadataLayoutVersion: 1, ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(43) },
        ownerMetadata: SessionOwnerMetadataV1Schema.parse({ v: 1 }), randomBytes: randomness }) };
      await expect(client.embed.createCredential({ sessionId: session.id, expiresInSeconds: 900,
        embedPublicKey: encodeBase64(deriveBoxPublicKeyFromSeed(frameKey), 'base64url') }))
        .rejects.toMatchObject({ code: 'session_options_unavailable' });
      expect(paths.at(-1)).toBe('/v1/auth/api-tokens/children/revoke');
    } finally { await client.close(); }
  });

  it('fails unavailable E2EE key and credential material closed without treating the row as plain', async () => {
    let session: unknown = { ...plainSession, encryptionMode: 'e2ee' };
    let accountEncryptionMode: 'plain' | 'e2ee' = 'e2ee';
    const activeChildren = new Set<string>();
    vi.stubGlobal('fetch', vi.fn(async (url: URL, options: RequestInit) => {
      if (url.pathname.endsWith('/self')) return json({ ...self, accountEncryptionMode });
      if (url.pathname.endsWith('/children/create')) {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>;
        activeChildren.add(String(body.tokenId));
        return mintResponse(body);
      }
      if (url.pathname.endsWith('/children/revoke')) {
        activeChildren.delete(String((JSON.parse(String(options.body)) as Record<string, unknown>).tokenId));
        return json({ revoked: true });
      }
      return json({ session });
    }));
    const client = connect({ endpoint: 'https://happier.example', token: TOKEN });
    try {
      const input = { sessionId: 'session-1', expiresInSeconds: 900,
        embedPublicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw' };
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'session_key_not_transferable' });
      session = { ...plainSession, encryptionMode: 'e2ee', dataEncryptionKey: 'invalid-envelope' };
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'session_key_not_transferable' });
      session = { ...plainSession, encryptionMode: 'e2ee', dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
        dataKey: new Uint8Array(32).fill(29), recipientPublicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(19)),
        randomBytes: (length) => new Uint8Array(length).fill(31),
      }), 'base64') };
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'encryption_credential_required' });
      session = { ...plainSession, encryptionMode: undefined };
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'invalid_session_snapshot' });
      session = plainSession;
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'encryption_credential_required' });
      accountEncryptionMode = 'plain';
      session = { ...plainSession, encryptionMode: 'e2ee' };
      await expect(client.embed.createCredential(input)).rejects.toMatchObject({ code: 'account_mode_mismatch' });
      expect(activeChildren.size).toBe(0);
    } finally { await client.close(); }
  });
});
