import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { projectAccountPrivateLabelForRecipientV1, migrateAccountPrivateLabelsForModeInTx } from './accountPrivateLabelContent';
import type { AccountEncryptionMigratePrivateLabelsDirectiveV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import { serializePrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';

describe('Account private labels across stored legacy reads and explicit mode changes', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'account-legacy-labels-' }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('reads without rewriting and includes raw Pool labels in the complete mode-change census', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const token = await db.accountApiToken.create({ data: { accountId: account.id, id: randomUUID(),
            label: 'Historic API token', displayPrefix: 'hap_legacy_label', secretDigest: randomUUID() } });
        const home = await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id,
            homeServerIdentityId: randomUUID(), canonicalServerUrl: 'https://legacy-home.example.test',
            label: 'Historic Home', connectionDescriptor: { canonicalServerUrl: 'https://legacy-home.example.test', revision: 1 } } });
        const pool = await db.machinePool.create({ data: { accountId: account.id, id: randomUUID(),
            name: 'Historic Pool', description: 'Historic description' } });
        const sources = [
            { entity: 'account_api_token' as const, field: 'label' as const, id: token.id, value: token.label },
            { entity: 'account_directory_home' as const, field: 'label' as const, id: home.homeServerIdentityId, value: home.label },
            { entity: 'machine_pool' as const, field: 'name' as const, id: pool.id, value: pool.name },
            { entity: 'machine_pool' as const, field: 'description' as const, id: pool.id, value: pool.description! },
        ];
        const items = sources.map((source): AccountEncryptionMigratePrivateLabelsDirectiveV1['items'][number] => {
            const projected = projectAccountPrivateLabelForRecipientV1({ serialized: source.value, mode: 'e2ee', recipientAccountId: account.id });
            if (projected.kind !== 'available') throw new Error(projected.kind);
            const content = { id: source.id, expectedLabel: projected.label,
                label: { content: { t: 'plain' as const, v: source.value }, recipients: [] } };
            switch (source.entity) {
                case 'account_api_token': return { ...content, entity: source.entity, field: 'label' };
                case 'account_directory_home': return { ...content, entity: source.entity, field: 'label' };
                case 'machine_pool': return { ...content, entity: source.entity, field: source.field };
            }
        });
        expect(await db.machinePool.findUniqueOrThrow({ where: { id: pool.id }, select: { name: true, description: true } }))
            .toEqual({ name: pool.name, description: pool.description });
        const result = await inTx(tx => migrateAccountPrivateLabelsForModeInTx(tx, {
            accountId: account.id, fromMode: 'e2ee', toMode: 'plain', ownerContentPublicKeyFingerprint: null,
            directive: { items },
        }));
        expect(result).toEqual({ status: 'applied' });
        expect(await db.machinePool.findUniqueOrThrow({ where: { id: pool.id }, select: { name: true, description: true } }))
            .toEqual({ name: serializePrivateLabelStoredV1(items[2]!.label), description: serializePrivateLabelStoredV1(items[3]!.label) });
        expect((await db.accountApiToken.findUniqueOrThrow({ where: { id: token.id } })).label)
            .toBe(serializePrivateLabelStoredV1(items[0]!.label));
        expect((await db.accountHomeDirectoryEntry.findUniqueOrThrow({ where: {
            accountId_homeServerIdentityId: { accountId: account.id, homeServerIdentityId: home.homeServerIdentityId },
        } })).label).toBe(serializePrivateLabelStoredV1(items[1]!.label));
    });
});
