import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { Platform } from 'react-native';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { createFakeCryptoWorker } from '@/sync/encryption/nativeCryptoWorker/fakeCryptoWorker';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { InvalidateSync } from '@/utils/sessions/sync';
import { decryptArtifactWithBody, fetchAndApplyArtifactsList, fetchArtifactWithBodyFromApi, handleNewArtifactSocketUpdate, handleUpdateArtifactSocketUpdate } from './syncArtifacts';

vi.mock('@/log', () => ({ log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.restoreAllMocks());

describe('background artifact decryption', () => {
    it.each(['recover', 'cancel'] as const)('recovers an exact receipt read through the shared Worker routing owner (%s)', async scenario => {
        const previousPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        Object.defineProperty(Platform, 'OS', { ...previousPlatform, value: 'web' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(41));
        const worker = createFakeCryptoWorker();
        const controller = new AbortController();
        const decrypt = vi.spyOn(worker, 'decryptDataKeyEnvelopeV1');
        decrypt.mockImplementationOnce(async () => {
            if (scenario === 'cancel') controller.abort();
            throw new Error('Web crypto worker failed');
        });
        encryption.configureNativeCryptoWorker({ worker, routing: { mode: 'auto', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(42);
        const codec = new ArtifactEncryption(key);
        const artifact: Artifact = { id: '11111111-1111-4111-8111-111111111111', ownerAccountId: 'owner', access: 'owner',
            encryptionMode: 'e2ee', header: await codec.encryptHeader({ title: 'Exact receipt' }),
            body: await codec.encryptBody({ body: 'receipt body' }), dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const census = { artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] };
        const request = async (path: string) => Response.json(path === '/v1/artifacts/read'
            ? { items: [{ artifactId: artifact.id, ok: true, artifact: { ...artifact, publicAudience: 'none' }, recipientCensus: census }] }
            : path.endsWith('/recipients') ? census : artifact);
        try {
            const read = fetchArtifactWithBodyFromApi({ credentials: { token: 'fixture' }, encryption,
                artifactDataKeys: new Map(), request, artifactId: artifact.id, signal: controller.signal });
            if (scenario === 'cancel') {
                await expect(read).rejects.toMatchObject({ name: 'AbortError' });
                expect(decrypt).toHaveBeenCalledOnce();
            } else {
                await expect(read).resolves.toMatchObject({ isDecrypted: true, body: 'receipt body' });
                expect(decrypt).toHaveBeenCalledOnce();
            }
        } finally { controller.abort(); Object.defineProperty(Platform, 'OS', previousPlatform); }
    });
    it.each(['new', 'update', 'missing-key'] as const)('requests exact-id repair for a %s socket decrypt failure without publishing a lock or a raw toast', async kind => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(38));
        const worker = createFakeCryptoWorker();
        vi.spyOn(worker, 'decryptDataKeyEnvelopeV1').mockRejectedValue(new Error('native crypto worker timed out'));
        encryption.configureNativeCryptoWorker({ worker, routing: { mode: 'require', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(39);
        const dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(key));
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const header = await new ArtifactEncryption(key).encryptHeader({ title: 'Kept document' });
        const invalidateArtifactsSync = vi.fn();
        const publish = vi.fn();
        const rawError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const previousPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        Object.defineProperty(Platform, 'OS', { ...previousPlatform, value: 'web' });
        try {
            if (kind === 'new') {
                const event = { artifactId, dataEncryptionKey, header, headerVersion: 1, bodyVersion: 1,
                    seq: 1, createdAt: 1, updatedAt: 1, encryption, artifactDataKeys: new Map(),
                    addArtifact: publish, invalidateArtifactsSync, log: { log: () => {} } };
                await handleNewArtifactSocketUpdate(event);
            } else {
                await handleUpdateArtifactSocketUpdate({ artifactId, createdAt: 2, encryption,
                    provenance: 'pending ciphertext', provenanceDataEncryptionKey: dataEncryptionKey,
                    body: { version: 2, value: 'pending body' },
                    artifactDataKeys: kind === 'missing-key' ? new Map() : new Map([[artifactId, { dataKey: key, envelope: dataEncryptionKey }]]),
                    getExistingArtifact: () => ({ id: artifactId, title: 'Kept document', isDecrypted: true,
                        headerVersion: 1, bodyVersion: 1, body: 'Kept content', seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'e2ee' }),
                    updateArtifact: publish, invalidateArtifactsSync, log: { log: () => {} } });
            }
        } finally { Object.defineProperty(Platform, 'OS', previousPlatform); }
        expect(publish).not.toHaveBeenCalled();
        expect(invalidateArtifactsSync).toHaveBeenCalledExactlyOnceWith([artifactId]);
        expect(rawError).not.toHaveBeenCalled();
    });
    it('retains corrupt stored content as locked without writing to the raw error/toast channel', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(36));
        const key = new Uint8Array(32).fill(37);
        const id = '11111111-1111-4111-8111-111111111111';
        const codec = new ArtifactEncryption(key);
        const artifact: Artifact = { id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            header: await codec.encryptHeader({ title: 'Corrupt attribution' }),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            provenanceDataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId: id, bodyVersion: 1, dataKey: key,
                provenance: { savedBy: { kind: 'person', accountId: 'owner' } } }),
            headerVersion: 1, bodyVersion: 2, seq: 1, createdAt: 1, updatedAt: 1 };
        const rawError = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(decryptArtifactWithBody({ artifact, encryption, artifactDataKeys: new Map() }))
            .resolves.toMatchObject({ isDecrypted: false, availability: { kind: 'locked' } });
        expect(rawError).not.toHaveBeenCalled();
    });
    it('opens only index content for 1500 unconsumed settled approvals and profiles', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(31));
        encryption.configureNativeCryptoWorker({ worker: createFakeCryptoWorker(), routing: { mode: 'require', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(32);
        const privateKey = new Uint8Array(32).fill(33);
        const codec = new ArtifactEncryption(key);
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
            createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent', actionId: 'session.list',
            actionArgs: {}, summary: 'Settled', decision: { kind: 'approve', decidedAtMs: 2 } });
        const body = await codec.encryptBody({ body: JSON.stringify(approval) });
        const header = await codec.encryptHeader(buildApprovalRequestArtifactHeaderV1(approval));
        const profileHeader = await codec.encryptHeader({ kind: 'launch-profile.v1', title: 'Profile' });
        const rows: Artifact[] = await Promise.all(Array.from({ length: 1500 }, async (_, index) => {
            const id = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
            return { id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee', publicAudience: 'none',
                header: index === 0 ? profileHeader : header, body, headerVersion: 1, bodyVersion: 1,
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
                provenanceDataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(privateKey)),
                provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId: id, bodyVersion: 1,
                    dataKey: privateKey, provenance: { savedBy: { kind: 'person', accountId: 'owner' } } }),
                seq: index, createdAt: index, updatedAt: index };
        }));
        let page = 0;
        let detailReads = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path.startsWith('/v1/artifacts?')) {
                const heads = rows.slice(page * 500, ++page * 500).map(({ body: _body, ...head }) => head);
                return Response.json(heads);
            }
            if (path === '/v1/artifacts/read') {
                detailReads += 1;
                const selected = (JSON.parse(String(init?.body)) as { artifactIds: string[] }).artifactIds
                    .map(id => rows.find(row => row.id === id)!);
                return Response.json({ items: selected.map(artifact => ({ artifactId: artifact.id, ok: true, artifact,
                    recipientCensus: { artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
                        dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey,
                        provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey,
                        callerProvenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey, recipients: [] } })) });
            }
            throw new Error(`Unexpected artifact request: ${path}`);
        };
        const openKeys = vi.spyOn(encryption, 'decryptEncryptionKeys'); // Measures the real owner, preserving its crypto and queue.
        const openHeader = vi.spyOn(ArtifactEncryption.prototype, 'decryptHeaderRaw');
        const openBody = vi.spyOn(ArtifactEncryption.prototype, 'decryptBody');
        const applied: DecryptedArtifact[][] = [];
        const started = performance.now();
        await fetchAndApplyArtifactsList({ credentials: { token: 't' }, encryption, artifactDataKeys: new Map(), request,
            applyArtifacts: artifacts => applied.push(artifacts) });
        const measurement = { elapsedMs: Math.round(performance.now() - started),
            envelopeInputs: openKeys.mock.calls.reduce((sum, [values]) => sum + values.length, 0),
            headerDecrypts: openHeader.mock.calls.length, bodyDecrypts: openBody.mock.calls.length, detailReads };
        console.info('FX-26 1500 artifact first-load measurement', measurement);
        // Earlier admitted pages may be visible before the complete inventory.
        expect(applied.at(-1)).toHaveLength(1500);
        expect(measurement).toMatchObject({ envelopeInputs: 1500, headerDecrypts: 1500, bodyDecrypts: 0, detailReads: 0 });
        expect(applied.flat().every(row => row.body === undefined && !Object.hasOwn(row, 'provenance'))).toBe(true);
    });

    it('lets the existing invalidation owner retry a worker timeout without publishing locked rows or raw errors', async () => {
        // This operation's routing is browser-specific; retain the standard host
        // module graph and override only the platform port during this read.
        const previousPlatform = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
        Object.defineProperty(Platform, 'OS', { ...previousPlatform, value: 'web' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(34));
        const worker = createFakeCryptoWorker();
        const decrypt = vi.spyOn(worker, 'decryptDataKeyEnvelopeV1');
        decrypt.mockRejectedValueOnce(new Error('native crypto worker timed out'));
        encryption.configureNativeCryptoWorker({ worker, routing: { mode: 'require', minPayloadBytes: 0 } });
        const key = new Uint8Array(32).fill(35);
        const artifact: Artifact = { id: '11111111-1111-4111-8111-111111111111', ownerAccountId: 'owner', access: 'owner',
            encryptionMode: 'e2ee', header: await new ArtifactEncryption(key).encryptHeader({ title: 'Retryable' }),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key)),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const rawError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const applied: DecryptedArtifact[][] = [];
        const attempts = vi.fn(() => fetchAndApplyArtifactsList({ credentials: { token: 't' }, encryption,
            artifactDataKeys: new Map(), request: async () => Response.json([artifact]),
            applyArtifacts: artifacts => applied.push(artifacts) }));
        const owner = new InvalidateSync(attempts, { backoff: { minDelayMs: 0, maxDelayMs: 0, maxFailureCount: 2 } });
        try { await owner.invalidateAndAwait(); } finally {
            owner.stop();
            Object.defineProperty(Platform, 'OS', previousPlatform);
        }
        expect(attempts).toHaveBeenCalledTimes(2);
        expect(applied).toMatchObject([[{ title: 'Retryable', isDecrypted: true }]]);
        expect(rawError).not.toHaveBeenCalled();
    });
});
