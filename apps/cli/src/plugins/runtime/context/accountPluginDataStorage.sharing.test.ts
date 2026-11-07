import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    normalizePluginAccountCollectionContractV1, type PluginCollectionRowV1 } from '@happier-dev/protocol';
import { encodePluginCollectionLogicalValueV1, decodePluginCollectionLogicalRowV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { StoredCredentials } from '@/persistence';
import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';

const definition = { id: 'records', schemaVersion: 1, rowIdField: 'id', schema: { type: 'object',
    properties: { id: { type: 'string' }, status: { type: 'string' }, note: { type: 'string' } },
    required: ['id', 'status', 'note'], additionalProperties: false }, serverReadable: ['status'],
    indexes: [{ id: 'by-status', fields: [{ field: 'status', direction: 'asc' }] }],
    uiQueries: [], relations: [], identityFields: [],
} satisfies PluginAccountCollectionDefinition;
const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'example.sharing', contribution: { ...definition, migrations: [] } });
const machineKey = new Uint8Array(32).fill(7);
const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
    encryption: { type: 'dataKey', machineKey, publicKey } } satisfies StoredCredentials;
const material = { type: 'dataKey', machineKey } as const;
const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material, dataKeyPublicKey: publicKey });
const randomBytes = (length: number) => new Uint8Array(length).fill(3);
const rowKey = new Uint8Array(32).fill(19);
const initialValue = { id: 'record-1', status: 'open', note: 'shared private note' };

function createPromotedBoundary(activeContract = contract, retireDuringKeyOpen = false) {
    const encoded = encodePluginCollectionLogicalValueV1({ contract, isValidLogicalValue: () => true,
        value: initialValue, encryptionMode: 'e2ee', material, resourceDataKey: rowKey, randomBytes });
    if (encoded.status !== 'encoded') throw new Error('Invalid fixture');
    let row: PluginCollectionRowV1 = { rowId: encoded.rowId, revision: 1, content: encoded.content,
        projection: encoded.projection, encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey: rowKey, recipientPublicKey: publicKey, randomBytes })).toString('base64') };
    const paths: string[] = [];
    const stages: Array<Readonly<{ content: PluginCollectionRowV1['content']; projection: PluginCollectionRowV1['projection'] }>> = [];
    let current = true;
    let rowResponseReturned = false;
    // Credential custody is a system boundary: switch Accounts while the
    // resource opener acquires its recipient secret, after HTTP admission.
    const hostCredentials = { ...credentials, encryption: { type: 'dataKey', publicKey,
        get machineKey() { if (retireDuringKeyOpen && rowResponseReturned) current = false; return machineKey; },
    } } satisfies StoredCredentials;
    const host = createAccountPluginDataStorageHost({ contracts: [activeContract], readCredentials: async () => hostCredentials,
        isCurrentAccount: () => current, resolveAccountScopeKey: () => 'sharing-owner', resolveBaseUrl: () => 'https://sharing.test', randomBytes,
        resolveAccountEncryptionCurrentness: async () => ({ mode: 'e2ee', version: 1, updatedAt: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
            recipientEnvelopeReadiness: { status: 'available' } }),
        http: { get: async () => { throw new Error('Unexpected GET'); }, post: async (url, body) => {
            const path = new URL(url).pathname;
            paths.push(path);
            if (path.endsWith('/source-page')) return { status: 200, data: { rows: [{ ...row, alreadyStaged: false }] } };
            if (path.endsWith('/stage')) {
                const request = JSON.parse(body);
                stages.push(...request.items.map((item: { target: (typeof stages)[number] }) => item.target));
                return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
            }
            if (path.endsWith('/get')) {
                rowResponseReturned = true;
                return { status: 200, data: { row: JSON.parse(body).rowId === row.rowId ? row : null, absenceEpoch: 0 } };
            }
            if (path.endsWith('/query')) { rowResponseReturned = true; return { status: 200, data: { rows: [row], changeCursor: row.revision } }; }
            if (path.endsWith('/mutate')) {
                const request = JSON.parse(body);
                const operation = request.operations[0];
                if (operation.expectedRevision !== row.revision) return { status: 200, data: { status: 'conflict',
                    conflicts: [{ rowId: row.rowId, revision: row.revision, deleted: false }] } };
                row = { ...row, revision: row.revision + 1, content: operation.content, projection: operation.projection };
                return { status: 200, data: { status: 'updated', results: [{ rowId: row.rowId, revision: row.revision, deleted: false }], changeCursor: row.revision } };
            }
            throw new Error(`Unexpected path ${path}`);
        } },
    });
    const account = host.bind({ pluginId: contract.pluginId, occurrenceId: 'sharing', signal: new AbortController().signal, isOccurrenceCurrent: () => true });
    if (!account) throw new Error('Missing Account binding');
    return { collection: account.collection(definition), paths, readRow: () => row, host, stages };
}

describe('Collection resource keys through the CLI Account Data host', () => {
    it('reports an unknown mutation outcome for an invalid sharing acknowledgement', async () => {
        const resource = { ownerAccountId: 'owner', pluginId: contract.pluginId, collectionId: contract.collectionId,
            rowId: initialValue.id, access: 'edit', encryptionMode: 'plain', encryptedDataKey: null,
            row: { rowId: initialValue.id, revision: 1, content: { t: 'plain', v: { note: initialValue.note } }, projection: { status: 'open' } } };
        const host = createAccountPluginDataStorageHost({ contracts: [contract], readCredentials: async () => ({ ...credentials, encryption: null }),
            isCurrentAccount: () => true, resolveAccountScopeKey: () => 'sharing-owner', resolveBaseUrl: () => 'https://sharing.test',
            resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: null, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
            http: { get: async () => { throw new Error('Unexpected GET'); }, post: async url => {
                if (new URL(url).pathname.endsWith('/sharing/get')) return { status: 200, data: resource };
                if (new URL(url).pathname.endsWith('/sharing/put')) return { status: 200, data: { committed: true } };
                throw new Error(`Unexpected sharing path ${url}`);
            } },
        });
        const account = host.bind({ pluginId: contract.pluginId, occurrenceId: 'sharing', signal: new AbortController().signal, isOccurrenceCurrent: () => true });
        if (!account) throw new Error('Missing Account binding');
        await expect(account.collection(definition).sharing.put({ ownerAccountId: 'owner', value: initialValue, expectedRevision: 1 }))
            .rejects.toMatchObject({ code: 'plugin_collection_outcome_unknown', retryable: false });
    });

    it('binds sharing requests with owner addressing and surfaces revoked access', async () => {
        const principal = { kind: 'account', accountId: 'recipient' } as const;
        let revoked = false;
        const row = { rowId: initialValue.id, revision: 1, content: { t: 'plain', v: { note: initialValue.note } }, projection: { status: 'open' } };
        const address = { ownerAccountId: 'owner', pluginId: contract.pluginId, collectionId: contract.collectionId, rowId: row.rowId };
        const resource = { ...address, access: 'edit', encryptionMode: 'plain', encryptedDataKey: null, row };
        const host = createAccountPluginDataStorageHost({ contracts: [contract], readCredentials: async () => ({ ...credentials, encryption: null }),
            isCurrentAccount: () => true, resolveAccountScopeKey: () => 'sharing-owner', resolveBaseUrl: () => 'https://sharing.test',
            resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, updatedAt: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: null, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
            http: { get: async () => { throw new Error('Unexpected GET'); }, post: async (url, body) => {
                const path = new URL(url).pathname;
                const request = JSON.parse(body);
                if (path.endsWith('/census')) return { status: 200, data: { ...address, encryptionMode: 'plain', access: 'owner',
                    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] } };
                if (path.endsWith('/set-grant')) { expect(request).toMatchObject({ ...address, principal, accessLevel: 'edit', expectedRevision: 1 }); return { status: 200, data: { changed: true } }; }
                if (path.endsWith('/revoke-grant')) { revoked = true; return { status: 200, data: { changed: true } }; }
                if (path.endsWith('/sharing/put')) return { status: 400, data: { error: 'collection_quota_incompatible', dimension: 'maxRowEncodedBytes', effectiveMaximum: 1024 } };
                if (path.endsWith('/shared-with-me')) return { status: 200, data: { resources: [resource], nextCursor: null } };
                if (path.endsWith('/sharing/get')) return revoked ? { status: 403, data: { error: 'collection_access_forbidden' } }
                    : { status: 200, data: resource };
                if (path.endsWith('/get')) return { status: 200, data: { row, absenceEpoch: 0 } };
                throw new Error(`Unexpected sharing path ${path}`);
            } },
        });
        const account = host.bind({ pluginId: contract.pluginId, occurrenceId: 'sharing', signal: new AbortController().signal, isOccurrenceCurrent: () => true });
        if (!account) throw new Error('Missing Account binding');
        const collection = account.collection(definition);
        await expect(collection.sharing.setGrant(row.rowId, { principal, accessLevel: 'edit', expectedRevision: 1 })).resolves.toEqual({ changed: true });
        await expect(collection.sharing.sharedWithMe()).resolves.toMatchObject({ rows: [{ ownerAccountId: 'owner', access: 'edit', value: initialValue }] });
        await expect(collection.sharing.get({ ownerAccountId: 'owner', rowId: row.rowId })).resolves.toMatchObject({ value: initialValue });
        await expect(collection.sharing.put({ ownerAccountId: 'owner', value: initialValue, expectedRevision: 1 })).rejects.toMatchObject({
            code: 'collection_quota_incompatible', retryable: false,
            data: { details: { dimension: 'maxRowEncodedBytes', effectiveMaximum: 1024 } },
        });
        await collection.sharing.revokeGrant(row.rowId, { principal });
        await expect(collection.sharing.get({ ownerAccountId: 'owner', rowId: row.rowId })).rejects.toMatchObject({ code: 'collection_access_forbidden' });
    });

    it('reads promoted rows through ordinary get/query', async () => {
        const { collection } = createPromotedBoundary();
        await expect(collection.get(initialValue.id)).resolves.toMatchObject({ value: initialValue });
        await expect(collection.query({ index: 'by-status', prefix: ['open'], order: 'asc' })).resolves.toMatchObject({ rows: [{ value: initialValue }] });
    });

    it.each(['get', 'query'] as const)('refuses %s disclosure if the Account retires during resource-key opening', async operation => {
        const { collection } = createPromotedBoundary(contract, true);
        const result = operation === 'get' ? collection.get(initialValue.id)
            : collection.query({ index: 'by-status', prefix: ['open'], order: 'asc' });
        await expect(result).rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
    });

    it('preserves promoted row keys through ordinary put/batch with revision conflicts', async () => {
        const { collection, readRow, paths } = createPromotedBoundary();
        const updated = { ...initialValue, note: 'owner updated' };
        await expect(collection.put(updated, { expectedRevision: 1 })).resolves.toMatchObject({ revision: 2, value: updated });
        expect(readRow().content).toMatchObject({ t: 'encrypted', k: 'collection' });
        expect(decodePluginCollectionLogicalRowV1({ contract, row: readRow(), encryptionMode: 'e2ee', material,
            resourceDataKey: rowKey, parseStoredLogicalValue: value => value })).toMatchObject({ status: 'decoded', value: updated });
        await expect(collection.put(updated, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'plugin_collection_conflict' });
        await expect(collection.batch([{ kind: 'put', value: { ...updated, note: 'batch updated' }, expectedRevision: 2 }])).resolves.toMatchObject({ status: 'updated' });
        // Key discovery follows only changed rows, without an inventory query.
        expect(paths.filter(path => path.endsWith('/query'))).toHaveLength(0);
        expect(paths.filter(path => path.endsWith('/get')).length).toBeLessThanOrEqual(3);
        await expect(collection.get(initialValue.id)).resolves.toMatchObject({ revision: 3, value: { ...updated, note: 'batch updated' } });
    });

    it('shares one absence proof when measuring new E2EE rows', async () => {
        const { collection, paths } = createPromotedBoundary();
        await collection.measureBatch(['new-1', 'new-2', 'new-3'].map(id => ({
            kind: 'put', value: { ...initialValue, id }, expectedRevision: 'absent',
        })));
        expect(paths.filter(path => path.endsWith('/get'))).toHaveLength(1);
    });

    it('keeps the resource key when a candidate migrates a promoted row', async () => {
        const migration = { id: 'to-v2', fromSchemaVersion: 1, toSchemaVersion: 2 };
        const declaration = { ...definition, schemaVersion: 2, readableSchemaVersions: [1], migrations: [migration] };
        const target = normalizePluginAccountCollectionContractV1({ pluginId: contract.pluginId, contribution: declaration });
        const { host, stages, readRow } = createPromotedBoundary(target);
        const ref = (selected: typeof contract) => ({ pluginId: selected.pluginId, collectionId: selected.collectionId,
            schemaVersion: selected.schemaVersion, contractDigest: selected.contractDigest });
        const candidate = host.createCollectionMigrationCandidate({
            binding: { source: ref(contract), target: ref(target), candidate: { releaseVersion: '2.0.0', artifactDigest: `sha256:${'c'.repeat(64)}` } },
            sourceContract: contract, targetContract: target, declarations: [declaration],
            runtime: { [definition.id]: [{ ...migration, migrate: value => ({ ...value, note: 'migrated private note' }) }] },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        expect(stages).toHaveLength(1);
        expect(stages[0]!.content).toMatchObject({ t: 'encrypted', k: 'collection' });
        expect(decodePluginCollectionLogicalRowV1({ contract: target, row: { ...readRow(), ...stages[0]! },
            encryptionMode: 'e2ee', material, resourceDataKey: rowKey, parseStoredLogicalValue: value => value,
        })).toMatchObject({ status: 'decoded', value: { ...initialValue, note: 'migrated private note' } });
    });
});
