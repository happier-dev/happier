import { describe, expect, it } from 'vitest';
import { createArtifactPublicLinkActionsV1, type ArtifactPublicLinkActionIdV1, type ArtifactPublicLinkIssuedV1, type ArtifactPublicLinkKeyholdingResourceV1 } from './artifactPublicLinkActions.js';
import { openPublicShareDataKeyV1 } from '../../crypto/publicShareEncryptedDataKeyEnvelopeV0.js';

const publicShare = { id: 'share-1', subject: { kind: 'artifact' as const, id: 'artifact-1' }, expiresAt: null,
  maxUses: null, useCount: 0, isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' as const };

describe('keyholding Artifact public-link Actions', () => {
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
        return { publicShare, isolatedOrigin: 'https://public.example.test' };
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
        if (request.method === 'POST') return { publicShare, isolatedOrigin: 'https://public.example.test' };
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
      request: async () => ({ publicShare, isolatedOrigin: 'https://public.example.test' }),
      onPublicLinkIssued: link => { throw new Error(link.secret); },
    });
    await expect(execute({ actionId: 'artifact.public_link.create', input: { artifactId: 'artifact-1' } }))
      .rejects.toMatchObject({ code: 'outcome_unknown', message: 'outcome_unknown' });
  });
});
