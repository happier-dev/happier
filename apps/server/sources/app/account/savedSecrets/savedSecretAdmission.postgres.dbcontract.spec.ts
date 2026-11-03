import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
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
