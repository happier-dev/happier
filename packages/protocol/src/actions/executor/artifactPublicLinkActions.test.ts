import { ArtifactActionInputSchemasV1 } from '../../artifacts/artifactActionsV1.js';
import { sealPublicShareDataKeyV1 } from '../../crypto/publicShareEncryptedDataKeyEnvelopeV0.js';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { signAccountContentKeyBindingV1 } from '../../crypto/accountContentKeyBindingV1.js';
import { encodeBase64, decodeBase64 } from '../../crypto/base64.js';
import { openEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { describe, expect, it } from 'vitest';
import { createArtifactPublicLinkActionsV1, createArtifactSignedInLinkJoinActionV1, type ArtifactPublicLinkActionIdV1, type ArtifactPublicLinkIssuedV1, type ArtifactPublicLinkKeyholdingResourceV1 } from './artifactPublicLinkActions.js';
import { openPublicShareDataKeyV1 } from '../../crypto/publicShareEncryptedDataKeyEnvelopeV0.js';
import { StoredContentPublicShareV1Schema } from '../../sharing/storedContentPublicShareV1.js';

const publicShare = StoredContentPublicShareV1Schema.parse({ id: 'share-1', subject: { kind: 'artifact', id: 'artifact-1' }, expiresAt: null,
  maxUses: null, useCount: 0, isConsentRequired: false, networkOff: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' });

describe('keyholding Artifact public-link Actions', () => {
  it('refuses signed-in publication without transient delivery before any host effects', async () => {
    const effects: unknown[] = [];
    const execute = createArtifactPublicLinkActionsV1({ read: async () => { effects.push('read'); return null; },
      randomBytes: length => new Uint8Array(length), request: async request => { effects.push(request); return {}; } });
    await expect(execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact', audience: 'signed_in' } }))
      .rejects.toMatchObject({ code: 'unsupported_action' });
    expect(effects).toEqual([]);
  });
  it('rejects private or malformed opened template bytes before granting access or presenting them', async () => {
    const requests: string[] = [], opened: unknown[] = [];
    const execute = createArtifactSignedInLinkJoinActionV1({ consumeSecret: async () => 'a'.repeat(43),
      resolveRecipient: async () => ({ accountId: 'recipient', mode: 'plain', contentPublicKey: null }),
      randomBytes: length => new Uint8Array(length), onOpened: value => { opened.push(value); },
      openContent: async () => ({ artifactId: 'artifact', ownerAccountId: 'author', header: { kind: 'bot_template.v1', state: 'draft' },
        body: 'private draft', revision: { headerVersion: 1, bodyVersion: 1 } }),
      request: async request => { requests.push(request.method); return request.method === 'POST'
        ? { artifactId: 'artifact', ownerAccountId: 'author', access: 'view' }
        : { subject: { kind: 'artifact', id: 'artifact' }, artifactId: 'artifact', authorAccountId: 'author', recipientAccountId: 'recipient',
          recipientContentKey: { status: 'unavailable', reason: 'plain_account' }, encryptionMode: 'plain', encryptedDataKey: null,
          keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
          content: { kind: 'artifact', header: 'header', body: 'body', headerVersion: 1, bodyVersion: 1 } }; },
    });
    await expect(execute({ input: { lookupId: 'lookup' } })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    expect(requests).toEqual(['GET']);
    expect(opened).toEqual([]);
  });
  it('rejects anonymous-only settings on a signed-in link before any host effects', async () => {
    const effects: unknown[] = [];
    const execute = createArtifactPublicLinkActionsV1({ read: async () => { effects.push('read'); return null; },
      randomBytes: length => new Uint8Array(length), request: async request => { effects.push(request); return {}; } });
    for (const option of [{ expiresAt: 100 }, { maxUses: 1 }, { isConsentRequired: true }, { networkOff: false }]) {
      await expect(execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1', audience: 'signed_in', ...option } })).rejects.toThrow();
    }
    expect(effects).toEqual([]);
    expect(ArtifactActionInputSchemasV1['artifact.public_link.audit'].safeParse({ artifactId: 'artifact-1', shareId: 'artifact-1', audience: 'signed_in' }).success).toBe(false);
  });
  it.each(['known', 'wrong_account', 'substituted_key'] as const)('binds the encrypted join envelope to local Account custody (%s)', async identity => {
    const signingSecret = new Uint8Array(32).fill(3);
    const signingPublic = ed25519.getPublicKey(signingSecret);
    const contentSecret = new Uint8Array(32).fill(4);
    const contentPublic = x25519.getPublicKey(contentSecret);
    const recipientContentKey = { status: 'available', accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'),
      contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
        accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic })) };
    const dataKey = new Uint8Array(32).fill(9), secret = 'a'.repeat(43);
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const artifact = { artifactId: 'artifact-1', ownerAccountId: 'author', header: {}, body: 'release', revision: { headerVersion: 1, bodyVersion: 1 } };
    const opened: unknown[] = [];
    const execute = createArtifactSignedInLinkJoinActionV1({ consumeSecret: async () => secret,
      resolveRecipient: async () => ({ accountId: identity === 'wrong_account' ? 'someone-else' : 'recipient', mode: 'e2ee' as const,
        contentPublicKey: identity === 'substituted_key' ? x25519.getPublicKey(new Uint8Array(32).fill(6)) : contentPublic }),
      randomBytes: length => new Uint8Array(length).fill(2), onOpened: value => { opened.push(value); }, openContent: async () => artifact,
      request: async request => {
        requests.push(request);
        if (request.method === 'POST') return { artifactId: 'artifact-1', ownerAccountId: 'author', access: 'view' };
        return { subject: { kind: 'artifact', id: 'artifact-1' }, artifactId: 'artifact-1', authorAccountId: 'author', recipientAccountId: 'recipient', recipientContentKey,
          encryptionMode: 'e2ee', encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret, randomBytes: length => new Uint8Array(length).fill(1) }),
          keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
          content: { kind: 'artifact', header: 'encrypted', body: 'encrypted', headerVersion: 1, bodyVersion: 1 } };
      },
    });
    if (identity !== 'known') {
      await expect(execute({ input: { lookupId: 'lookup' } })).rejects.toMatchObject({ code: 'recipient_key_unavailable' });
      expect(requests).toHaveLength(1);
      expect(opened).toEqual([]);
      return;
    }
    await expect(execute({ input: { lookupId: 'lookup' } })).resolves.toEqual({ artifactId: 'artifact-1', authorAccountId: 'author', follow: true });
    const body = requests[1]!.body as { keyEnvelope: { recipientAccountId: string; encryptedDataKey: string } };
    expect(body.keyEnvelope.recipientAccountId).toBe('recipient');
    expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(body.keyEnvelope.encryptedDataKey), recipientSecretKeyOrSeed: contentSecret })).toEqual(dataKey);
    expect(JSON.stringify(requests)).not.toContain(secret);
    expect(opened).toEqual([{ artifact, source: { artifactId: 'artifact-1', authorAccountId: 'author' }, follow: true }]);
  });
  it('opens an encrypted link once for a Plain Account without creating a grant or retaining a secret', async () => {
    const secret = 'a'.repeat(43);
    const dataKey = new Uint8Array(32).fill(9);
    const requests: unknown[] = [];
    const opened: unknown[] = [];
    const artifact = { artifactId: 'artifact-1', ownerAccountId: 'author', header: {}, body: 'content', revision: { headerVersion: 1, bodyVersion: 1 } };
    const execute = createArtifactSignedInLinkJoinActionV1({ consumeSecret: async () => secret,
      randomBytes: length => new Uint8Array(length).fill(1), onOpened: value => { opened.push(value); },
      resolveRecipient: async () => ({ accountId: 'recipient', mode: 'plain', contentPublicKey: null }),
      openContent: async input => { expect(input.dataKey).toEqual(dataKey); return artifact; },
      request: async request => { requests.push(request); return { subject: { kind: 'artifact', id: 'artifact-1' },
        artifactId: 'artifact-1', authorAccountId: 'author', recipientAccountId: 'recipient',
        recipientContentKey: { status: 'unavailable', reason: 'plain_account' }, encryptionMode: 'e2ee',
        encryptedDataKey: sealPublicShareDataKeyV1({ dataKey, secret, randomBytes: length => new Uint8Array(length).fill(2) }),
        keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
        content: { kind: 'artifact', header: 'ciphertext', body: 'ciphertext', headerVersion: 1, bodyVersion: 1 } }; },
    });
    await expect(execute({ input: { lookupId: 'lookup' } })).resolves.toEqual({ artifactId: 'artifact-1', authorAccountId: 'author', follow: false, followUnavailableReason: 'plain_account' });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(secret);
    expect(opened).toEqual([{ artifact, source: { authorAccountId: 'author', artifactId: 'artifact-1' }, follow: false, followUnavailableReason: 'plain_account' }]);
  });
  it('creates and manages signed-in links independently of anonymous publications', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const signedIn = { ...publicShare, id: 'artifact-1', audience: 'signed_in' };
    let materialCounter = 1;
    const execute = createArtifactPublicLinkActionsV1({
      onPublicLinkIssued: link => { issued.push(link); },
      shareableServerUrl: 'https://api.home.example.test/prefix',
      read: async () => ({ artifactId: 'artifact-1', access: 'owner', header: {}, encryptionMode: 'plain', dataKey: null }),
      randomBytes: length => new Uint8Array(length).fill(materialCounter++), request: async request => {
        requests.push(request);
        return request.method === 'GET' ? { publicShares: [signedIn] }
          : request.method === 'POST' ? { publicShare: signedIn, viewerOrigin: 'https://home.example.test/ui' } : { success: true };
      },
    });
    const created = await execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1', audience: 'signed_in' } });
    expect(created).toMatchObject({ publicShare: signedIn, url: expect.not.stringContaining('#') });
    const issuedUrl = new URL(issued[0]!.url);
    expect(issuedUrl.pathname).toBe(`/ui/share/artifact/${issued[0]!.lookupId}`);
    expect(issuedUrl.searchParams.get('server')).toBe('https://api.home.example.test/prefix');
    expect(issuedUrl.hash).toBe(`#k=${issued[0]!.secret}`);
    expect(JSON.stringify(created)).not.toContain(issued[0]!.secret);
    expect(requests[0]).toMatchObject({ path: '/v1/artifact-signed-in-links', body: { artifactId: 'artifact-1' } });
    expect(requests[0]!.body).not.toHaveProperty('subject');
    await expect(execute({ actionId: 'artifact.public_link.list', input: { artifactId: 'artifact-1', audience: 'signed_in' } }))
      .resolves.toEqual({ publicShares: [signedIn] });
    await execute({ actionId: 'artifact.public_link.revoke', input: { artifactId: 'artifact-1', shareId: 'artifact-1', audience: 'signed_in' } });
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/artifact-signed-in-links/artifact-1' });
  });
  it.each(['plain', 'e2ee'] as const)('preserves a current %s link without delivering unused fresh bearer material', async encryptionMode => {
    const signedIn = { ...publicShare, id: 'artifact-1', audience: 'signed_in' };
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const requests: unknown[] = [];
    const execute = createArtifactPublicLinkActionsV1({ onPublicLinkIssued: link => { issued.push(link); },
      read: async () => ({ artifactId: 'artifact-1', access: 'owner', header: {}, encryptionMode,
        dataKey: encryptionMode === 'plain' ? null : new Uint8Array(32).fill(8) }),
      randomBytes: length => new Uint8Array(length).fill(3), request: async request => {
        requests.push(request);
        return { publicShare: signedIn, viewerOrigin: 'https://home.example.test', created: false };
      } });
    await expect(execute({ actionId: 'artifact.public_link.create',
      input: { artifactId: 'artifact-1', audience: 'signed_in', preserveExisting: true } }))
      .resolves.toEqual({ publicShare: signedIn });
    expect(requests).toEqual([expect.objectContaining({ method: 'POST', path: '/v1/artifact-signed-in-links',
      body: expect.objectContaining({ artifactId: 'artifact-1', preserveExisting: true }) })]);
    expect(issued).toEqual([]);
  });
  it('lets owners revoke existing layout publications after new publication admission is disabled', async () => {
    const requests: string[] = [];
    const execute = createArtifactPublicLinkActionsV1({
      read: async () => ({ artifactId: 'artifact-1', access: 'owner', header: { kind: 'home-hub-layout.v1' }, encryptionMode: 'plain', dataKey: null }),
      randomBytes: length => new Uint8Array(length), request: async request => {
        requests.push(request.method);
        return request.method === 'GET' ? { publicShares: [publicShare] } : { success: true };
      },
    });
    await expect(execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1' } }))
      .rejects.toMatchObject({ code: 'artifact_kind_not_shareable' });
    expect(requests).toEqual([]);
    await expect(execute({ actionId: 'artifact.public_link.revoke', input: { artifactId: 'artifact-1', shareId: 'share-1' } }))
      .resolves.toMatchObject({ revoked: true });
    expect(requests).toEqual(['GET', 'DELETE']);
  });
  it('reads the existing audit only for a share belonging to the owned Artifact', async () => {
    const accessLog = [{ id: 'visit-1', accessedAt: 2, ipAddress: '127.0.0.1', userAgent: null }];
    const requests: string[] = [];
    let access: 'owner' | 'edit' = 'owner';
    const execute = createArtifactPublicLinkActionsV1({
      read: async () => ({ artifactId: 'artifact-1', access, header: {}, encryptionMode: 'plain', dataKey: null }),
      randomBytes: length => new Uint8Array(length), request: async request => {
        requests.push(request.path);
        return request.path.endsWith('/access-log') ? { accessLog } : { publicShares: [publicShare] };
      },
    });
    const actionId = 'artifact.public_link.audit' as ArtifactPublicLinkActionIdV1;
    await expect(execute({ actionId, input: { artifactId: 'artifact-1', shareId: 'share-1' } })).resolves.toEqual({ accessLog });
    expect(requests).toContain('/v1/public-shares/share-1/access-log');
    requests.length = 0;
    await expect(execute({ actionId, input: { artifactId: 'artifact-1', shareId: 'foreign' } })).rejects.toMatchObject({ code: 'public_share_not_found' });
    expect(requests.some(path => path.endsWith('/access-log'))).toBe(false);
    access = 'edit';
    requests.length = 0;
    await expect(execute({ actionId, input: { artifactId: 'artifact-1', shareId: 'share-1' } })).rejects.toMatchObject({ code: 'artifact_access_forbidden' });
    expect(requests).toEqual([]);
  });
  it.each(['plain', 'e2ee'] as const)('returns complete %s links to the approved caller without HTTP secret disclosure', async encryptionMode => {
    const dataKey = encryptionMode === 'plain' ? null : new Uint8Array(32).fill(42);
    const resource: ArtifactPublicLinkKeyholdingResourceV1 = { artifactId: 'artifact-1', access: 'owner', header: {}, encryptionMode, dataKey };
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const bodies: Record<string, unknown>[] = [];
    let randomCounter = 1;
    const execute = createArtifactPublicLinkActionsV1({ read: async () => resource,
      randomBytes: length => new Uint8Array(length).fill(randomCounter++),
      onPublicLinkIssued: link => { issued.push(link); }, request: async request => {
        bodies.push(request.body as Record<string, unknown>);
        return { publicShare, viewerOrigin: 'https://public.example.test' };
      } });
    const result = await execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1' } });
    const link = issued[0]!;
    expect(result).toEqual({ publicShare, url: link.url });
    expect(link.lookupId).not.toBe(link.secret);
    expect(link.url).toBe(`https://public.example.test/s/${link.lookupId}#k=${link.secret}`);
    expect(JSON.stringify(bodies)).not.toContain(link.secret);
    expect(bodies[0]).toMatchObject({ subject: publicShare.subject, lookupId: link.lookupId, keyDerivation: 'fragment_v1' });
    if (dataKey) {
      expect(openPublicShareDataKeyV1({ encryptedDataKey: String(bodies[0]!.encryptedDataKey), secret: link.secret })).toEqual(dataKey);
      expect(openPublicShareDataKeyV1({ encryptedDataKey: String(bodies[0]!.encryptedDataKey), secret: link.lookupId })).toBeNull();
    } else expect(bodies[0]).not.toHaveProperty('encryptedDataKey');
  });

  it('issues a link without a mounted consumer and refuses foreign share revocation', async () => {
    const requests: string[] = [];
    const execute = createArtifactPublicLinkActionsV1({ read: async () => ({ artifactId: 'artifact-1', access: 'owner', header: {}, encryptionMode: 'plain', dataKey: null }),
      randomBytes: length => new Uint8Array(length), request: async request => {
        requests.push(request.method);
        if (request.method === 'POST') return { publicShare, viewerOrigin: 'https://public.example.test' };
        return { publicShares: [{ ...publicShare, subject: { kind: 'artifact', id: 'other' } }] };
      } });
    await expect(execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1' } })).resolves.toMatchObject({ publicShare, url: expect.stringMatching(/^https:\/\/public.example.test\/s\/[^#]+#k=.+$/) });
    await expect(execute({ actionId: 'artifact.public_link.revoke', input: { artifactId: 'artifact-1', shareId: 'share-1' } })).rejects.toMatchObject({ code: 'public_share_subject_mismatch' });
    expect(requests).toEqual(['POST', 'GET']);
  });
  it('does not disclose a local custody failure after the Home committed creation', async () => {
    const execute = createArtifactPublicLinkActionsV1({
      read: async () => ({ artifactId: 'artifact-1', access: 'owner', header: {}, encryptionMode: 'plain', dataKey: null }),
      randomBytes: length => new Uint8Array(length).fill(1),
      request: async () => ({ publicShare, viewerOrigin: 'https://public.example.test' }),
      onPublicLinkIssued: link => { throw new Error(link.secret); },
    });
    await expect(execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1' } }))
      .rejects.toMatchObject({ code: 'outcome_unknown', message: 'outcome_unknown' });
  });
});
