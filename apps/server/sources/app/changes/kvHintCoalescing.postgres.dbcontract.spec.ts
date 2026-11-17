import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { kvMutate } from '@/app/kv/kvMutate';
import { db, initDbPostgres } from '@/storage/db';
import { readAccountChangesPage } from './readAccountChangesPage';

describe('KV addresses in the coalesced Account feed', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    const compatibility = evaluateAccountStoredContentSocketCompatibility({
        accountStoredContentCompatibility: {
            v: 1, protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION_PROTOCOL_VERSION,
        },
    }).evaluation;
    const read = (accountId: string) => readAccountChangesPage({ accountId, after: 0, limit: 100,
        compatibility, readAuthentication: () => ({ env: process.env, authority: 'present_user',
            authenticationEvidence: undefined }) });
    const createKeys = (accountId: string, keys: string[]) => kvMutate({ uid: accountId }, keys.map(key => ({
        key, version: -1, value: Buffer.from('private value').toString('base64'),
    })));

    it('retains both addresses when separate writes coalesce before a feed read', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await createKeys(account.id, ['backup-owner-a'])).toMatchObject({ success: true });
        expect(await createKeys(account.id, ['backup-owner-b'])).toMatchObject({ success: true });
        const result = await read(account.id);
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('Expected an available Account feed');
        expect(result.page.changes).toEqual([expect.objectContaining({ kind: 'kv', entityId: 'self',
            hint: { keys: ['backup-owner-a', 'backup-owner-b'] } })]);
    });

    it('keeps an incumbent full invalidation broad after a later exact-key write', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        // The mutation owner already publishes full above its exact-key budget.
        expect(await createKeys(account.id, Array.from({ length: 51 }, (_, index) => `backup-${index}`)))
            .toMatchObject({ success: true });
        expect(await createKeys(account.id, ['backup-later'])).toMatchObject({ success: true });
        const result = await read(account.id);
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') throw new Error('Expected an available Account feed');
        expect(result.page.changes).toEqual([expect.objectContaining({ kind: 'kv', entityId: 'self',
            hint: { full: true } })]);
    });
});
