import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { withSqliteReadSnapshot } from '@/storage/prisma';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { readArtifactForCaller } from './artifactAccessService';

describe('exact Artifact content capture and request admission', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-artifact-exact-read-', initEncrypt: true, initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('captures %s content and admission once per request', async mode => {
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const id = crypto.randomUUID();
        const header = Buffer.from(mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'Exact read' }) : 'opaque-header', mode === 'plain' ? 'base64' : 'utf8');
        const body = Buffer.from(mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'Exact revision' }) : 'opaque-body', mode === 'plain' ? 'base64' : 'utf8');
        const stored = await db.artifact.create({ data: { id, accountId: owner.id, header, body,
            dataEncryptionKey: mode === 'plain' ? Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64')
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                    recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes })),
            headerVersion: 3, bodyVersion: 7, seq: 1 } });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        // Observe the real DB boundary; content and access stay real.
        const delegate = reader.artifact;
        const original = delegate.findFirst.bind(delegate);
        let reads = 0;
        Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
            value: (...args: Parameters<typeof original>) => { reads += 1; return original(...args); } });
        try {
            const result = await readArtifactForCaller({ actorAccountId: owner.id, artifactId: id });
            expect(result.ok, result.ok ? 'read' : result.error).toBe(true);
            expect(result).toMatchObject({ ok: true, artifact: { id, header: new Uint8Array(header), body: new Uint8Array(body),
                dataEncryptionKey: new Uint8Array(stored.dataEncryptionKey),
                headerVersion: 3, bodyVersion: 7, encryptionMode: mode, access: 'owner', publicAudience: 'none' } });
            expect.soft(reads).toBe(1);
        } finally { Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original }); }
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await readArtifactForCaller({ actorAccountId: outsider.id, artifactId: id }))
            .toEqual({ ok: false, error: 'artifact_not_found' });
        const endSnapshot = reader.$executeRawUnsafe.bind(reader);
        let changed = false;
        // Change the real writer only after the captured snapshot closes.
        Object.defineProperty(reader, '$executeRawUnsafe', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof endSnapshot>) => {
                const result = await endSnapshot(...args);
                if (args[0] === 'ROLLBACK;' && !changed) {
                    changed = true;
                    await db.account.update({ where: { id: owner.id }, data: { encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' } });
                }
                return result;
            } });
        try {
            expect(await readArtifactForCaller({ actorAccountId: owner.id, artifactId: id }))
                .toMatchObject({ ok: true, artifact: { id, header: new Uint8Array(header), body: new Uint8Array(body),
                    dataEncryptionKey: new Uint8Array(stored.dataEncryptionKey), encryptionMode: mode } });
            expect(changed).toBe(true);
            expect(await readArtifactForCaller({ actorAccountId: owner.id, artifactId: id }))
                .toMatchObject({ ok: false, error: 'artifact_content_unavailable' });
        } finally { Object.defineProperty(reader, '$executeRawUnsafe', { configurable: true, writable: true, value: endSnapshot }); }
    });
});
