import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealSessionDataKeyBundleV0, sealPublicShareDataKeyV1 } from '@happier-dev/protocol';
import { createDbMocks, createDbTransactionMock, installDbModuleMock } from '../../testkit/dbMocks';

// Database transport is the only substitute. Route parsing, transaction handling,
// Account mode, stored-content opening, kind policy and publication owner are real.
const mocks = createDbMocks({ artifact: ['findFirst'], publicSessionShare: ['findUnique', 'create', 'update'] } as const);
const transactions = createDbTransactionMock(() => mocks.db);
installDbModuleMock(() => ({ db: transactions.wrapDb(mocks.db) }));
const { withAuthenticatedTestApp } = await import('../../testkit/sqliteFastify');
const { registerStoredContentPublicShareRoutes } = await import('./registerStoredContentPublicShareRoutes');
const { storePlainArtifactDbBytes } = await import('@/app/artifacts/artifactStoredContent');
const { initEncrypt } = await import('@/modules/encrypt');

describe('Artifact public-share kind admission through the HTTP owner', () => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const lookupId = '22222222-2222-4222-8222-222222222222';
    const share = { id: '33333333-3333-4333-8333-333333333333', sessionId: null, artifactId,
        tokenHash: createHash('sha256').update(lookupId).digest(), encryptedDataKey: null,
        keyDerivation: 'fragment_v1', expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
        createdAt: new Date(1), updatedAt: new Date(1), createdByUserId: 'owner' };
    beforeEach(() => {
        mocks.reset();
        mocks.db.publicSessionShare.findUnique.mockResolvedValue(share);
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN', 'preview.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER', '1');
    });
    afterEach(() => vi.unstubAllEnvs());
    it.each(['widget-area-layout.v1', 'home-hub-layout.v1', 'approval_request.v1', 'text', undefined])(
        'admits the canonical Plain Account policy for %s', async kind => {
            mocks.db.artifact.findFirst.mockResolvedValue({ id: artifactId, accountId: 'owner', account: { encryptionMode: 'plain' },
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent(kind ? { kind } : {})),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            await withAuthenticatedTestApp(registerStoredContentPublicShareRoutes, async app => {
                const response = await app.inject({ method: 'POST', url: '/v1/public-shares', headers: { 'x-test-user-id': 'owner' },
                    payload: { subject: { kind: 'artifact', id: artifactId }, lookupId, keyDerivation: 'fragment_v1' } });
                if (kind === 'text' || kind === undefined) {
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ publicShare: { subject: { kind: 'artifact', id: artifactId } } });
                } else {
                    expect(response.statusCode, response.body).toBe(400);
                    expect(response.json()).toEqual({ error: 'artifact_kind_not_shareable' });
                }
                expect(mocks.db.publicSessionShare.create).not.toHaveBeenCalled();
                expect(mocks.db.publicSessionShare.update).not.toHaveBeenCalled();
            });
        });
    it('enforces the policy after opening a Plain Account header sealed at rest', async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'fx7-kind-policy-test-secret');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'server_sealed');
        await initEncrypt();
        const header = storePlainArtifactDbBytes({ accountId: 'owner', artifactId, field: 'header',
            content: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'home-hub-layout.v1' })) });
        if (!header) throw new Error('Missing sealed test header');
        expect(JSON.parse(new TextDecoder().decode(header))).toMatchObject({ t: 'sealed_v1' });
        mocks.db.artifact.findFirst.mockResolvedValue({ id: artifactId, accountId: 'owner', account: { encryptionMode: 'plain' },
            header, body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        await withAuthenticatedTestApp(registerStoredContentPublicShareRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/public-shares', headers: { 'x-test-user-id': 'owner' },
                payload: { subject: { kind: 'artifact', id: artifactId }, lookupId, keyDerivation: 'fragment_v1' } });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: 'artifact_kind_not_shareable' });
        });
    });
    it('keeps E2EE headers opaque instead of assuming a server-readable kind', async () => {
        const key = new Uint8Array(32).fill(9);
        const encryptedDataKey = privacyKit.decodeBase64(sealPublicShareDataKeyV1({ dataKey: key, secret: 'A'.repeat(43),
            randomBytes: length => new Uint8Array(length).fill(4) }));
        mocks.db.publicSessionShare.findUnique.mockResolvedValue({ ...share, encryptedDataKey });
        mocks.db.artifact.findFirst.mockResolvedValue({ id: artifactId, accountId: 'owner', account: { encryptionMode: 'e2ee' },
            header: new Uint8Array(await sealSessionDataKeyBundleV0({ kind: 'home-hub-layout.v1' }, key)),
            body: new Uint8Array(await sealSessionDataKeyBundleV0({ body: '{}' }, key)), dataEncryptionKey: new Uint8Array([31]) });
        await withAuthenticatedTestApp(registerStoredContentPublicShareRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v1/public-shares', headers: { 'x-test-user-id': 'owner' },
                payload: { subject: { kind: 'artifact', id: artifactId }, lookupId, keyDerivation: 'fragment_v1' } });
            expect(response.statusCode, response.body).toBe(200);
        });
    });
});
