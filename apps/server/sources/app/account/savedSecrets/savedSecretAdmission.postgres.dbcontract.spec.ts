import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, readPostgresTransactionSqlState, type Tx } from '@/storage/inTx';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { observeLazyPrismaQuery, withAccountPublicationBeforeTransactionSql } from '@/app/changes/accountPublicationContention.testkit';
import { registerSavedSecretResourceRoutes } from '@/app/api/routes/account/registerSavedSecretResourceRoutes';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sealEncryptedDataKeyEnvelopeV1, sealQualifiedConnectedAccountContentEnvelope, sealSavedSecretResourceStoredContentV1, verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readQualifiedConnectedServiceCredential } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { createSavedSecretResourceInTx, promoteSavedSecretResourceInTx, setSavedSecretResourceGrantsInTx } from './savedSecretResourceService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('SavedSecret complete early publication admission', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST = 'none';
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST = 'none';
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    describe('rotation contention', () => {
        const originalRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        beforeAll(() => { process.env.HAPPIER_DB_TX_MAX_RETRIES = '0'; });
        afterAll(() => {
            if (originalRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = originalRetries;
        });

        async function createRotationFixture(shared = false) {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const resourceId = randomUUID();
            const accountGrants: string[] = [];
            if (shared) {
                const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
                await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: 'friend' } });
                accountGrants.push(recipient.id);
            }
            const content = { v: 1 as const, name: 'Rotation fixture', kind: 'token' as const, value: 'synthetic-original' };
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
                accountId: owner.id, resourceId, displayName: content.name, kind: content.kind,
                encryptionMode: 'plain', storedContent: { t: 'plain', v: content }, accountGrants,
            }))).toMatchObject({ ok: true });
            const app = createAuthenticatedTestApp();
            registerSavedSecretResourceRoutes(app);
            const rotate = () => app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/update',
                headers: { 'x-test-user-id': owner.id }, payload: {
                    resourceId, expectedRevision: 1, displayName: content.name, kind: content.kind,
                    storedContent: { t: 'plain', v: { ...content, value: 'synthetic-rotated' } },
                } });
            return { owner, resourceId, app, rotate };
        }

        it('rotates once after an unrelated Account cursor publishes following the audience census', async () => {
            const { owner, resourceId, app, rotate } = await createRotationFixture();
            const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
            try {
                const { result: response, advances } = await withAccountPublicationBeforeTransactionSql(owner.id,
                    sql => sql.includes('FROM "Account"') && sql.includes('FOR NO KEY UPDATE'), rotate);
                expect(response.statusCode, response.body).toBe(200);
                expect(advances).toBe(1);
                expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId }, select: { revision: true } }))
                    .toEqual({ revision: 2 });
                expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }))
                    .toEqual({ seq: before.seq + 2 });
            } finally { await app.close(); }
        });

        it('reads the Account mode after a transition wins the content admission fence', async () => {
            const { owner, resourceId, app, rotate } = await createRotationFixture(true);
            const binding = createSignedAccountContentBinding(tweetnacl.box.keyPair().publicKey);
            const transaction = db.$transaction;
            let transitioned = false;
            // Interpose before real content admission. A shared Plain Secret
            // remains Plain across this genuine persisted Account mode change.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (!transitioned && query.includes('FROM "Account"') && /FOR (KEY SHARE|NO KEY UPDATE)/.test(query)) {
                            transitioned = true;
                            await transaction.call(db, async (peer: Tx) => {
                                await peer.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE', owner.id);
                                await peer.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee', ...binding } });
                            });
                        }
                        return inner.$queryRawUnsafe(query, ...values);
                    };
                } })), ...args.slice(1)]);
            } });
            try {
                const response = await rotate();
                expect(transitioned).toBe(true);
                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toMatchObject({ error: 'account_mode_mismatch' });
                expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId }, select: { revision: true, encryptionMode: true } }))
                    .toEqual({ revision: 1, encryptionMode: 'plain' });
            } finally { db.$transaction = transaction; await app.close(); }
        });

        it('admits only one concurrent rotation of the same Secret revision', async () => {
            const { owner, resourceId, app, rotate } = await createRotationFixture();
            const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
            try {
                const responses = await Promise.all([rotate(), rotate()]);
                expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
                expect(responses.find(response => response.statusCode === 409)?.json()).toMatchObject({ error: 'resource_changed' });
                expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId }, select: { revision: true } }))
                    .toEqual({ revision: 2 });
                expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }))
                    .toEqual({ seq: before.seq + 1 });
            } finally { await app.close(); }
        });

        it('lets an admitted grant mutation finish before a competing rotation without a lock-order cycle', async () => {
            const { owner, resourceId, app, rotate } = await createRotationFixture(true);
            const transaction = db.$transaction;
            let firstTransaction = true;
            let grantPid = 0;
            let rotationPid = 0;
            let locked!: () => void;
            let release!: () => void;
            const parentLocked = new Promise<void>(resolve => { locked = resolve; });
            const released = new Promise<void>(resolve => { release = resolve; });
            // Hold the real grant CAS row lock. Observe PostgreSQL's wait graph,
            // then let the owner publish while rotation is awaiting admission.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                const grantTransaction = firstTransaction;
                firstTransaction = false;
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                    if (grantTransaction) grantPid = backend.pid;
                    else rotationPid = backend.pid;
                    return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (!grantTransaction || property !== 'savedSecretResource') return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.savedSecretResource, { get(delegate, method, delegateReceiver) {
                            const query = Reflect.get(delegate, method, delegateReceiver);
                            if (method !== 'updateMany') return query;
                            return (...input: unknown[]) => observeLazyPrismaQuery(Reflect.apply(query, delegate, input),
                                () => ({ started() {}, settled() {} }), undefined, async consume => {
                                    const result = await consume();
                                    locked(); await released;
                                    return result;
                                });
                        } });
                    } }));
                }, ...args.slice(1)]);
            } });
            let grant: ReturnType<typeof inTx> | undefined;
            let rotation: ReturnType<typeof rotate> | undefined;
            let rotationSettled = false;
            try {
                grant = inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: owner.id, resourceId,
                    expectedRevision: 1, accountGrants: [], teamGrants: [], groupGrants: [] }), { isolationLevel: 'Serializable' });
                // A failed peer must release the observer instead of stranding it.
                void grant.catch(() => { locked(); });
                await parentLocked;
                rotation = rotate().finally(() => { rotationSettled = true; });
                let observedWait = false;
                while (!observedWait && !rotationSettled) {
                    const [waiter] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                        SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                            WHERE pid = ${rotationPid} AND ${grantPid} = ANY(pg_blocking_pids(pid))) AS waiting`;
                    observedWait = waiter.waiting;
                }
                release();
                expect(observedWait).toBe(true);
                expect(await grant).toMatchObject({ ok: true, value: { revision: 2 } });
                const response = await rotation;
                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toMatchObject({ error: 'resource_changed' });
                expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId }, select: { revision: true } }))
                    .toEqual({ revision: 2 });
                expect(await db.savedSecretAccountGrant.count({ where: { resourceId } })).toBe(0);
            } finally {
                release();
                db.$transaction = transaction;
                await Promise.allSettled([grant, rotation]);
                await app.close();
            }
        });
    });

    it('deletes immediately after revoking grants while Account publication competes with every attempt', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: 'friend' } });
        const resourceId = randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: owner.id, resourceId, displayName: 'Disposable shared secret', kind: 'token',
            encryptionMode: 'plain', accountGrants: [],
            storedContent: { t: 'plain', v: { v: 1, name: 'Disposable shared secret', kind: 'token', value: 'synthetic' } },
        }))).toMatchObject({ ok: true });
        expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id, resourceId, expectedRevision: 1,
            accountGrants: [recipient.id], teamGrants: [], groupGrants: [],
        }), { isolationLevel: 'Serializable' })).toMatchObject({ ok: true, value: { revision: 2 } });
        expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, {
            accountId: owner.id, resourceId, expectedRevision: 2,
            accountGrants: [], teamGrants: [], groupGrants: [],
        }), { isolationLevel: 'Serializable' })).toMatchObject({ ok: true, value: { revision: 3 } });
        const app = createAuthenticatedTestApp();
        registerSavedSecretResourceRoutes(app);
        const transaction = db.$transaction;
        // Schedule a genuine competing DB publication at admission. No domain
        // result or SQL is substituted. NOWAIT observes whether the owner's
        // existing admission excludes the competing non-key Account update.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let competed = false;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        const result = await inner.$queryRawUnsafe(query, ...values);
                        if (!competed && query.includes('FROM "Account"') && /FOR (KEY SHARE|NO KEY UPDATE)/.test(query)) {
                            competed = true;
                            try {
                                await transaction.call(db, async (competing: Tx) => {
                                    await competing.$queryRawUnsafe('SELECT "id" FROM "Account" WHERE "id" = $1 FOR NO KEY UPDATE NOWAIT', owner.id);
                                    await competing.account.update({ where: { id: owner.id }, data: { seq: { increment: 1 } } });
                                });
                            } catch (error) {
                                if (readPostgresTransactionSqlState(error) !== '55P03') throw error;
                            }
                        }
                        return result;
                    };
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/account/saved-secrets/resources/delete',
                headers: { 'x-test-user-id': owner.id }, payload: {
                    resourceId, expectedRevision: 3, expectedSettingsVersion: 0,
                    referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] } },
                } });
            expect(response.statusCode, response.body).toBe(200);
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
            expect(await db.savedSecretAccountGrant.count({ where: { resourceId } })).toBe(0);
        } finally {
            db.$transaction = transaction;
            await app.close();
        }
    });

    it.each([
        { mode: 'plain', teamSource: false },
        { mode: 'e2ee', teamSource: false },
        { mode: 'plain', teamSource: true },
    ] as const)('persists a $mode Connected Account and key with no Machines (Team source: $teamSource)', async ({ mode, teamSource }) => {
        const keys = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(keys.publicKey);
        const owner = await db.account.create({ data: { encryptionMode: mode, settingsVersion: 2,
            ...(mode === 'e2ee' ? binding : {}) } });
        const resourceId = randomUUID();
        const ref = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel' }, accountId: randomUUID() };
        if (teamSource) {
            const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: 'Credential recipients' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'owner' } });
            await db.teamCredentialResource.create({ data: { teamId: team.id, custodianAccountId: owner.id,
                displayName: 'Retained source', disclosureCeiling: 'brokered_only', sessionUsePolicy: 'personal_allowed',
                sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account',
                    target: { kind: 'account', account: ref }, credentialIncarnation: randomUUID() }) } });
        }
        const content = { v: 1 as const, name: 'Vercel token', kind: 'token' as const, value: 'disposable-fixture' };
        const credential = { v: 1, values: {}, secretRefs: { token: formatSharedSavedSecretRefV1(resourceId) } };
        const verifiedBinding = verifyAccountContentKeyBindingV1({ accountSigningPublicKey: Buffer.from(binding.publicKey, 'hex'),
            contentPublicKey: binding.contentPublicKey, signature: binding.contentPublicKeySig });
        if (!verifiedBinding) throw new Error('Fixture binding must verify');
        const dataKey = tweetnacl.randomBytes(32);
        const promoted = await inTx(tx => promoteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: content.name, kind: content.kind, encryptionMode: mode,
            storedContent: mode === 'plain' ? { t: 'plain', v: content }
                : sealSavedSecretResourceStoredContentV1({ resourceId, mode, resourceDataKey: dataKey, content, randomBytes: tweetnacl.randomBytes }),
            ...(mode === 'e2ee' ? { keyEnvelopes: [{ recipientAccountId: owner.id,
                recipientContentPublicKeyFingerprint: verifiedBinding.contentPublicKeyFingerprint,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes }) }] } : {}),
            nextSettings: null, profileMutations: [], referenceCensus: { scope: 'catalogs', accountMode: mode, catalogs: {} },
            connectedAccountCredentialMutation: { ref, authenticationModeId: 'token', expectedCredentialRevision: null,
                metadata: { scopes: [] }, savedSecretResourceIds: [resourceId],
                content: mode === 'plain' ? { t: 'plain', v: credential }
                    : sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: mode,
                        material: { type: 'dataKey', machineKey: keys.secretKey }, payload: credential, randomBytes: tweetnacl.randomBytes }) },
        }));
        expect(promoted).toMatchObject({ ok: true, value: { connectedAccountCredential: { credentialRevision: expect.any(String) } } });
        expect(await readQualifiedConnectedServiceCredential({ accountId: owner.id, ref })).toMatchObject({ status: 'resolved' });
        expect(await db.savedSecretResource.count({ where: { id: resourceId, ownerAccountId: owner.id } })).toBe(1);
        expect(await db.machine.count({ where: { accountId: owner.id } })).toBe(0);
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { settings: true, settingsVersion: true } }))
            .toEqual({ settings: null, settingsVersion: 2 });
    });

    it.each(['create', 'grants', 'promotion'] as const)('admits every %s recipient together before Account or resource locking', async operation => {
        const owner = await db.account.create({ data: { id: `z-owner-${randomUUID()}`, encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { id: `a-viewer-${randomUUID()}`, encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: recipient.id, status: 'friend' } });
        const resourceId = randomUUID();
        const resource = { accountId: owner.id, resourceId, displayName: 'Shared token', kind: 'token' as const,
            encryptionMode: 'plain' as const, storedContent: { t: 'plain' as const, v: { v: 1 as const, name: 'Shared token', kind: 'token' as const, value: 'private' } },
            accountGrants: [recipient.id] };
        if (operation === 'grants') expect(await inTx(tx => createSavedSecretResourceInTx(tx, { ...resource, accountGrants: [] }))).toMatchObject({ ok: true });
        const transaction = db.$transaction;
        let wroteResource = false;
        let firstAccountAdmission: readonly string[] | undefined;
        // Observe real DB admission and resource writes. The application,
        // eligibility checks, grants, row CAS and terminal publication stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === 'savedSecretResource') return new Proxy(inner.savedSecretResource, { get(delegate, method, delegateReceiver) {
                    const write = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'create' && method !== 'updateMany' && method !== 'deleteMany') return write;
                    return (...input: unknown[]) => { wroteResource = true; return Reflect.apply(write, delegate, input); };
                } });
                if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (firstAccountAdmission === undefined && query.includes('FROM "Account"') && query.includes('FOR ')) {
                        firstAccountAdmission = values.flatMap(value => Array.isArray(value) ? value : [value]).filter((value): value is string => typeof value === 'string');
                        expect(wroteResource, 'resource write must follow complete Account admission').toBe(false);
                        expect([...firstAccountAdmission].sort()).toEqual([owner.id, recipient.id].sort());
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } })), ...args.slice(1)]);
        } });
        try {
            const result = await inTx(async tx => operation === 'create' ? await createSavedSecretResourceInTx(tx, resource)
                : operation === 'grants' ? await setSavedSecretResourceGrantsInTx(tx, { accountId: owner.id, resourceId,
                    expectedRevision: 1, accountGrants: [recipient.id], teamGrants: [], groupGrants: [] })
                : await promoteSavedSecretResourceInTx(tx, { ...resource, profileMutations: [], expectedSettingsVersion: 0, nextSettings: null,
                    referenceCensus: { accountMode: 'plain', profileTransferRevision: 'absent',
                        profiles: { referenceGuardRevision: 'absent', rows: [] }, artifacts: [],
                        catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent', connectedPurposes: 'absent' },
                        remoteHosts: { revision: 'absent', resourceRefs: [] }, notificationChannels: { revision: 'absent', resourceRefs: [] } },
                    notificationChannelMutation: { expectedRevision: 'absent', sourceSettingsVersion: 0,
                        content: { t: 'plain', v: NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, topics: {}, id: 'hook', kind: 'webhook', url: 'https://example.test/hook', signingSecretRef: formatSharedSavedSecretRefV1(resourceId) }] }) },
                        savedSecretRevisions: [{ resourceRef: formatSharedSavedSecretRefV1(resourceId), revision: 1 }] },
                }));
            expect(result).toMatchObject({ ok: true });
            expect(firstAccountAdmission).toBeDefined();
            expect(wroteResource).toBe(true);
            const publications = await db.accountChange.findMany({ where: { entityId: resourceId }, select: { accountId: true } });
            expect(publications.map(row => row.accountId).sort()).toEqual([owner.id, recipient.id].sort());
        } finally { db.$transaction = transaction; }
    });
});
