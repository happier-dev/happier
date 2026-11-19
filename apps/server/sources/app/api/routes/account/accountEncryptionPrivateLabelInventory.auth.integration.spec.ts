import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { registerAccountDirectoryRoutes } from '@/app/accountDirectory/accountDirectoryRoutes';
import { registerAccountEncryptionMigrateRoutes } from './registerAccountEncryptionMigrateRoutes';
import { storedPlainPrivateLabel } from '@/testkit/privateLabelFixture';

describe('Account mode private-label inventory authentication', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'account-label-inventory-', initAuth: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('lets a fresh Home Account enumerate its migration inventory without Directory authority', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const token = await auth.createToken(account.id, { session: 'label-inventory' }, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(app => {
            registerAccountDirectoryRoutes(app);
            registerAccountEncryptionMigrateRoutes(app);
        }, async app => {
            const headers = { authorization: `Bearer ${token}` };
            // Control: ordinary Home authentication works, while Directory reads retain their separate authority.
            const control = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/todos/inventory', headers });
            expect(control.statusCode, control.body).toBe(200);
            const directory = await app.inject({ method: 'GET', url: '/v1/account-directory/homes', headers });
            expect(directory.statusCode).toBe(403);
            const inventory = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/private-labels/inventory', headers });
            expect(inventory.statusCode, inventory.body).toBe(200);
            expect(inventory.json()).toEqual({ items: [] });
            const directoryToken = await auth.createToken(account.id, undefined, { kind: 'account_directory', authority: 'present_user' });
            const denied = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/private-labels/inventory',
                headers: { authorization: `Bearer ${directoryToken}` } });
            expect(denied.statusCode).toBe(403);
        }, { authentication: 'real' });
    });

    it('returns the complete local Account label census and preserves legacy text without foreign labels', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const other = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const tokenRow = await db.accountApiToken.create({ data: { accountId: account.id, id: randomUUID(),
            label: 'Saved token', displayPrefix: 'hap_inventory', secretDigest: randomUUID() } });
        await db.accountApiToken.create({ data: { accountId: other.id, id: randomUUID(),
            label: 'Foreign token', displayPrefix: 'hap_foreign', secretDigest: randomUUID() } });
        const homeId = randomUUID();
        await db.accountHomeDirectoryEntry.createMany({ data: [
            { accountId: account.id, homeServerIdentityId: homeId, canonicalServerUrl: 'https://home.test', label: 'Saved Home', connectionDescriptor: {} },
            { accountId: account.id, homeServerIdentityId: randomUUID(), canonicalServerUrl: 'https://bootstrap.test', label: '', connectionDescriptor: {} },
        ] });
        const pool = await db.machinePool.create({ data: { id: randomUUID(), accountId: account.id, name: 'Personal Pool', description: 'Personal details' } });
        const bearer = await auth.createToken(account.id, { session: 'label-inventory-populated' }, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerAccountEncryptionMigrateRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/private-labels/inventory',
                headers: { authorization: `Bearer ${bearer}` } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().items).toEqual([
                { entity: 'account_api_token', field: 'label', id: tokenRow.id, label: { content: { t: 'plain', v: 'Saved token' }, recipientEnvelope: null, legacyPlaintext: true } },
                { entity: 'account_directory_home', field: 'label', id: homeId, label: { content: { t: 'plain', v: 'Saved Home' }, recipientEnvelope: null, legacyPlaintext: true } },
                { entity: 'machine_pool', field: 'name', id: pool.id, label: { content: { t: 'plain', v: 'Personal Pool' }, recipientEnvelope: null, legacyPlaintext: true } },
                { entity: 'machine_pool', field: 'description', id: pool.id, label: { content: { t: 'plain', v: 'Personal details' }, recipientEnvelope: null, legacyPlaintext: true } },
            ]);
        }, { authentication: 'real' });
    });

    it('refuses the whole census when a stored label conflicts with the persisted Account mode', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        await db.machinePool.create({ data: { id: randomUUID(), accountId: account.id, name: storedPlainPrivateLabel('Wrong mode') } });
        const bearer = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerAccountEncryptionMigrateRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/account/encryption/migrate/private-labels/inventory',
                headers: { authorization: `Bearer ${bearer}` } });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'encryption_unavailable' });
        }, { authentication: 'real' });
    });
});
