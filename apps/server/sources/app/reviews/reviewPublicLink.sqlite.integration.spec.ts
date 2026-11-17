import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1,
    sealPublicShareDataKeyV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { writeArtifactPublicShare } from '@/app/share/storedContentPublicShare';
import { writeArtifactSignedInLink } from '@/app/share/artifactSignedInLink';

describe('Review authenticated audience boundary', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-links-', initEncrypt: true,
            env: { HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
                HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function artifact(mode: 'plain' | 'e2ee', kind: string) {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const id = randomUUID(), key = tweetnacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)) : new Uint8Array(await sealSessionDataKeyBundleV0(value, key));
        await db.artifact.create({ data: { id, accountId: owner.id, kind: `v1:other:${kind}`,
            header: await seal({ kind, v: 1, reviewId: id, title: 'Private code review' }),
            body: await seal({ body: JSON.stringify({ v: 1, rounds: [] }) }),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes })) } });
        return { id, accountId: owner.id, encryptedDataKey: mode === 'e2ee'
            ? sealPublicShareDataKeyV1({ dataKey: key, secret: 'fragment-secret', randomBytes: tweetnacl.randomBytes }) : undefined };
    }

    it.each(['plain', 'e2ee'] as const)('refuses anonymous links for a %s Review without publishing a link', async mode => {
        const row = await artifact(mode, 'review.v1');
        expect(await writeArtifactPublicShare({ userId: row.accountId, artifactId: row.id, lookupId: randomUUID(),
            encryptedDataKey: row.encryptedDataKey, authentication: createPresentUserSessionAccessAuthentication() }))
            .toMatchObject({ type: 'error', error: 'artifact_kind_not_shareable' });
        expect(await db.publicSessionShare.count({ where: { artifactId: row.id } })).toBe(0);
    });
    it.each(['plain', 'e2ee'] as const)('refuses signed-in links for a %s Review without publishing a link', async mode => {
        const row = await artifact(mode, 'review.v1');
        expect(await writeArtifactSignedInLink({ actorAccountId: row.accountId, artifactId: row.id, lookupId: randomUUID(),
            encryptedDataKey: row.encryptedDataKey })).toMatchObject({ ok: false, error: 'artifact_kind_not_shareable' });
        expect(await db.artifactSignedInLink.count({ where: { artifactId: row.id } })).toBe(0);
    });

    it('keeps ordinary encrypted documents shareable through both existing link owners', async () => {
        const row = await artifact('e2ee', 'ordinary.v1');
        expect(await writeArtifactPublicShare({ userId: row.accountId, artifactId: row.id, lookupId: randomUUID(),
            encryptedDataKey: row.encryptedDataKey, authentication: createPresentUserSessionAccessAuthentication() })).toMatchObject({ type: 'ok' });
        expect(await writeArtifactSignedInLink({ actorAccountId: row.accountId, artifactId: row.id, lookupId: randomUUID(),
            encryptedDataKey: row.encryptedDataKey })).toMatchObject({ ok: true });
    });
});
