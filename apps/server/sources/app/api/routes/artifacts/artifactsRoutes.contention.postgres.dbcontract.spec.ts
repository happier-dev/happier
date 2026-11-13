import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import * as privacyKit from 'privacy-kit';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, readPostgresTransactionSqlState, type Tx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { updateArtifact } from '@/app/artifacts/artifactWriteService';
import { updateSessionMetadata } from '@/app/session/sessionWriteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { artifactsRoutes } from './artifactsRoutes';

// The real SQL transport is the interleaving boundary. Each attempt captures its
// audience, then a peer commits before Account admission. Internal owners and
// route registration remain real; a stale Serializable snapshot cannot recover
// while this ordinary publication traffic continues on every retry.
function interleaveAccountPublisher(artifactId: string, publish: () => Promise<void>) {
    const original = db.$transaction;
    let publications = 0;
    const conflicts: Array<{ sqlState: string | undefined; statement: string }> = [];
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let addressed = false;
            let advanced = false;
            return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === 'artifact') return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                    const query = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findFirst' && method !== 'findUnique' && method !== 'findMany') return query;
                    return (...queryArgs: Parameters<typeof tx.artifact.findFirst>) => {
                        const id = queryArgs[0]?.where?.id;
                        if (id === artifactId || (typeof id === 'object' && Array.isArray(id?.in) && id.in.includes(artifactId))) addressed = true;
                        return Reflect.apply(query, delegate, queryArgs);
                    };
                } });
                if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                return (query: string, ...values: unknown[]) => {
                    const nativeQuery = inner.$queryRawUnsafe(query, ...values);
                    let running: Promise<unknown> | undefined;
                    const execute = () => running ??= (async () => {
                        if (addressed && !advanced && query.includes('FROM "Account"') && query.includes('FOR ')) {
                            advanced = true;
                            await publish();
                            publications++;
                        }
                        try { return await nativeQuery; }
                        catch (error) {
                            conflicts.push({ sqlState: readPostgresTransactionSqlState(error),
                                statement: query.includes('FROM "Account"') ? 'Account admission/publication' : 'other' });
                            throw error;
                        }
                    })();
                    // Preserve Prisma's lazy execution so inTx attaches its
                    // rejection handler before the real SQL can fail.
                    return new Proxy(nativeQuery, { get(target, property, receiver) {
                        if (property === 'then') return (...callbacks: Parameters<Promise<unknown>['then']>) => execute().then(...callbacks);
                        return Reflect.get(target, property, receiver);
                    } });
                };
            } }));
        }, ...args.slice(1)]);
    } });
    return { restore: () => { db.$transaction = original; }, publications: () => publications, conflicts };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Artifact access routes under Account publication contention', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    for (const quota of ['', '1000000']) {
        it.each(['grant', 'envelope', 'revoke'] as const)('commits %s beside peer publication without stale-snapshot retries (quota=' + quota + ')', async operation => {
            vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', quota);
            vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '1');
            const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
            const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
            await makeShareEligibleForTest(owner.id, recipient.id);
            const key = tweetnacl.randomBytes(32);
            const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
                dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
            }));
            const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                header: new TextEncoder().encode('opaque header'), body: new TextEncoder().encode('opaque body'),
                dataEncryptionKey: wrap(owner.contentPublicKey!), headerVersion: 1, bodyVersion: 1 } });
            const peerArtifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
                header: artifact.header, body: artifact.body, dataEncryptionKey: artifact.dataEncryptionKey, bodyVersion: 1 } });
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
            if (operation !== 'grant') await db.artifactGrant.create({ data: { principalKind: 'account',
                artifactId: artifact.id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id,
            } });
            const recipientEnvelope = { recipientAccountId: recipient.id, encryptedDataKey: privacyKit.encodeBase64(wrap(recipient.contentPublicKey!)),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.contentPublicKey!) };
            if (operation === 'revoke') await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id,
                recipientAccountId: recipient.id, encryptedDataKey: privacyKit.decodeBase64(recipientEnvelope.encryptedDataKey),
                recipientContentPublicKeyFingerprint: recipientEnvelope.recipientContentPublicKeyFingerprint } });
            const peer = async () => {
                if (operation === 'grant') {
                    expect(await updateArtifact({ actorUserId: owner.id, artifactId: peerArtifact.id,
                        body: { bytes: new TextEncoder().encode('peer body'), expectedVersion:
                            (await db.artifact.findUniqueOrThrow({ where: { id: peerArtifact.id } })).bodyVersion } }))
                        .toMatchObject({ ok: true });
                } else if (operation === 'envelope') {
                    const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                    expect(await updateSessionMetadata({ actorUserId: owner.id, sessionId: session.id,
                        authentication: createPresentUserSessionAccessAuthentication({ env: {} }),
                        expectedVersion: current.metadataVersion, metadataCiphertext: `opaque-${current.metadataVersion + 1}` }))
                        .toMatchObject({ ok: true });
                } else await inTx(async tx => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(tx, owner.id, 'content');
                    await markAccountChanged(tx, { accountId: owner.id, kind: 'account', entityId: owner.id });
                }, { transactionClass: 'artifact-contention-peer' });
            };
            const interleaving = interleaveAccountPublisher(artifact.id, peer);
            try {
                await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
                    const grants = `/v1/artifacts/${artifact.id}/access/grants`;
                    const result = await app.inject({ method: operation === 'grant' ? 'PUT' : operation === 'revoke' ? 'DELETE' : 'POST',
                        url: operation === 'envelope' ? `/v1/artifacts/${artifact.id}/access/key-envelopes` : grants,
                        headers: { 'x-test-user-id': owner.id }, payload: operation === 'envelope'
                            ? { artifactId: artifact.id, expectedDataEncryptionKey: privacyKit.encodeBase64(artifact.dataEncryptionKey),
                                recipientKeyEnvelopes: [recipientEnvelope] }
                            : { artifactId: artifact.id, principal: { kind: 'account', accountId: recipient.id },
                                ...(operation === 'grant' ? { accessLevel: 'view' } : {}) } });
                    expect(result.statusCode, JSON.stringify({ statusCode: result.statusCode, conflicts: interleaving.conflicts })).toBe(200);
                    expect(interleaving.publications()).toBe(1);
                    expect(interleaving.conflicts).toEqual([]);
                    if (operation === 'envelope') expect(result.json()).toEqual({ appliedRecipientAccountIds: [recipient.id], skippedRecipientAccountIds: [] });
                    else expect(result.json()).toMatchObject({ changed: true });
                });
                expect(await db.artifactGrant.count({ where: { principalKind: 'account', artifactId: artifact.id } })).toBe(operation === 'revoke' ? 0 : 1);
                expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(operation === 'envelope' ? 1 : 0);
                const changes = await db.accountChange.findMany({ where: { accountId: owner.id }, orderBy: { cursor: 'asc' } });
                // Envelope commits notify the applied recipient; they do not
                // publish an unchanged owner envelope back to the owner.
                expect(changes.map(change => change.entityId)).toEqual(operation === 'envelope'
                    ? [session.id] : [operation === 'grant' ? peerArtifact.id : owner.id, artifact.id]);
                expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                    accountId: recipient.id, kind: 'artifact', entityId: artifact.id,
                } } })).toMatchObject({ entityId: artifact.id });
            } finally {
                interleaving.restore();
                vi.unstubAllEnvs();
                await db.artifact.deleteMany({ where: { accountId: owner.id } });
                await db.session.deleteMany({ where: { accountId: owner.id } });
                await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
            }
        });
    }
});
