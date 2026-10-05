import { describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import * as protocol from '@happier-dev/protocol';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    computeContentPublicKeyFingerprint,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
    openSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    signAccountContentKeyBindingV1,
    sealEncryptedDataKeyEnvelopeV1,
    openEncryptedDataKeyEnvelopeV1,
    WorkflowDefinitionArtifactHeaderV1Schema,
    workflowDefinitionArtifactSharingAdapterV1,
} from '@happier-dev/protocol';

import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { createPackageAssetArchiveV1, encodePackageAssetArchiveBodyV1 } from '@happier-dev/protocol/plugins/availability';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { encodeAccountStoredJsonContent } from '@/sync/encryption/accountStoredJsonContent';
import {
    buildAccountEncryptionMigrationStorageDirectives,
} from './buildAccountEncryptionMigrationStorageDirectives';

describe('buildAccountEncryptionMigrationStorageDirectives', () => {
    const tokenOnlyCredentials = { token: 'token' } as const;
    const legacyCredentials = {
        token: 'token',
        secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url'),
    };
    const emptyTransitionInventories = {
        readArtifactRecipients: async (artifactId: string) => ({ artifactId,
            ownerAccountId: 'account-a', access: 'owner' as const, encryptionMode: 'plain' as const,
            dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }),
        scope: {
            scope: { serverId: 'home-a', accountId: 'account-a' },
            isCurrent: () => true,
        },
        reviewCommentsInventory: { v: 1 as const, items: [] },
        sessionOrganizationInventory: {
            version: 0,
            folders: [],
            tags: [],
            labels: [],
        },
    };

    it('converts qualified package archives and retained bodies without ordinary recipient authority', async () => {
        const archive = createPackageAssetArchiveV1({
            manifest: { schemaVersion: 2, id: 'com.acme.archive', version: '1.0.0', displayName: 'Archive',
                runtime: { apiVersion: 1 }, contributes: { resources: [{ id: 'icon', kind: 'asset', path: 'icon.png', contentType: 'image/png' }] } },
            files: [{ path: 'icon.png', bytes: Uint8Array.of(137, 80, 78) }],
        });
        if (!archive) throw new Error('Invalid package fixture');
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const row = { id: 'plugin-archive', ownership: { kind: 'packageAsset' as const, pluginId: 'com.acme.archive', descriptor: archive.descriptor },
            header: encodePlainArtifactStoredContent(archive.header), body: encodePlainArtifactStoredContent({ body: encodePackageAssetArchiveBodyV1(archive.body) }),
            headerVersion: 1, bodyVersion: 2, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: encodePackageAssetArchiveBodyV1(archive.body) }) }] };
        const inputs = { ...emptyTransitionInventories, readArtifactRecipients: undefined, machines: [], todos: [], sessions: [],
            sessionSourceCredentials: tokenOnlyCredentials, sessionTargetCredentials: legacyCredentials };
        const result = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
            fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption: encryption, artifacts: [row] });
        if (result.artifacts.action !== 'migrate') throw new Error('Missing conversion');
        const item = result.artifacts.items[0]!;
        expect(item.recipientKeyEnvelopes).toEqual([]);
        expect(item.blobs).toEqual([]);
        const plain = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
            fromMode: 'e2ee', toMode: 'plain', sourceEncryption: encryption, targetEncryption: null,
            sessionSourceCredentials: legacyCredentials, sessionTargetCredentials: null,
            artifacts: [{ ...row, header: item.header, body: item.body, dataEncryptionKey: item.dataEncryptionKey,
                revisions: item.revisions.map(revision => ({ bodyVersion: revision.bodyVersion, body: revision.body })) }] });
        if (plain.artifacts.action !== 'migrate') throw new Error('Missing reverse conversion');
        expect(decodePlainArtifactStoredContent(plain.artifacts.items[0]!.header)).toEqual(archive.header);
        expect(decodePlainArtifactStoredContent(plain.artifacts.items[0]!.revisions[0]!.body))
            .toEqual({ body: encodePackageAssetArchiveBodyV1(archive.body) });
        await expect(buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
            fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption: encryption,
            artifacts: [{ ...row, body: encodePlainArtifactStoredContent({ body: 'corrupt archive' }) }] })).rejects.toThrow();
    });

    it('converts each distinct head and retained binary payload with the replacement Artifact key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const payloads = [new Uint8Array([0, 255, 128]), new Uint8Array([1, 0, 254, 12])];
        const references = payloads.map((bytes, index) => ({
            blobId: `00000000-0000-4000-8000-00000000000${index + 1}`,
            mime: index === 0 ? 'image/png' : 'application/pdf', sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        }));
        const row = { id: artifactId, ownership: { kind: 'ordinary' as const }, header: encodePlainArtifactStoredContent({ kind: 'artifact.legacy', title: 'Binary' }),
            headerVersion: 1, bodyVersion: 3, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            body: encodePlainArtifactStoredContent({ body: references[0] }),
            revisions: [references[1], references[0]].map((body, index) => ({ bodyVersion: index + 1, body: encodePlainArtifactStoredContent({ body }) })),
        };
        const inputs = { ...emptyTransitionInventories, machines: [], todos: [], sessions: [],
            sessionSourceCredentials: tokenOnlyCredentials, sessionTargetCredentials: legacyCredentials };
        const staged = new Map<string, protocol.ArtifactBlobStoredContentV1>();
        const stageArtifactBlob = async (_id: string, blobId: string, content: protocol.ArtifactBlobStoredContentV1) => {
            staged.set(blobId, content);
            const encoded = content.t === 'plain' ? content.v : content.c;
            return { t: content.t, uploadId: `11111111-1111-4111-8111-${String(staged.size).padStart(12, '0')}`,
                contentSha256: createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex') };
        };
        const encrypted = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
            ...{ stageArtifactBlob },
            fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption: encryption, artifacts: [row],
            readArtifactBlob: async (_id, blobId) => ({ blobId, content: { t: 'plain' as const,
                v: Buffer.from(payloads[references.findIndex(ref => ref.blobId === blobId)]!).toString('base64') } }),
        });
        if (encrypted.artifacts.action !== 'migrate') throw new Error('Missing directive');
        const item = encrypted.artifacts.items[0]!;
        const key = await encryption.decryptEncryptionKey(item.dataEncryptionKey);
        if (!key) throw new Error('Missing target Artifact key');
        const codec = new ArtifactEncryption(key);
        expect(item.blobs.map(blob => blob.blobId)).toEqual(references.map(ref => ref.blobId));
        for (const [index, blob] of item.blobs.entries()) {
            expect(blob.expectedContentSha256).toBe(references[index]!.sha256);
            expect(blob.content).toEqual({ t: 'encrypted', uploadId: expect.any(String), contentSha256: expect.any(String) });
            const stored = staged.get(blob.blobId)!;
            if (stored.t !== 'encrypted') throw new Error('Wrong target mode');
            await expect(codec.decryptBytes(stored.c)).resolves.toEqual(payloads[index]);
        }
        const encryptedBlobs = new Map(staged);
        const plain = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
            ...{ stageArtifactBlob },
            fromMode: 'e2ee', toMode: 'plain', sourceEncryption: encryption, targetEncryption: null,
            sessionSourceCredentials: legacyCredentials, sessionTargetCredentials: null,
            artifacts: [{ ...row, header: item.header, body: item.body, dataEncryptionKey: item.dataEncryptionKey,
                revisions: item.revisions.map(revision => ({ bodyVersion: revision.bodyVersion, body: revision.body })) }],
            readArtifactBlob: async (_id, blobId) => ({ blobId, content: encryptedBlobs.get(blobId)! }),
        });
        if (plain.artifacts.action !== 'migrate') throw new Error('Missing plain directive');
        expect([...staged.values()]).toEqual(payloads.map(bytes => ({ t: 'plain', v: Buffer.from(bytes).toString('base64') })));
        expect(plain.artifacts.items[0]!.blobs.map(blob => blob.expectedContentSha256)).toEqual(item.blobs.map(blob => {
            const stored = encryptedBlobs.get(blob.blobId)!;
            if (stored.t !== 'encrypted') throw new Error('Wrong source mode');
            return createHash('sha256').update(Buffer.from(stored.c, 'base64')).digest('hex');
        }));
    });

    it('round-trips shared and handoff workspace tabs across Account modes with their exact CAS versions', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const record = { v: 1, tabsById: { tab: { id: 'tab', target: { kind: 'session', params: { sessionId: 'private-session' } }, pinned: true } }, order: ['tab'], pairs: [] };
        const keys = ['workspace:tabs:v1', 'workspace:handoff-tabs:v1:device:window'];
        const inputs = { ...emptyTransitionInventories, machines: [], todos: [], artifacts: [], sessions: [], sessionSourceCredentials: tokenOnlyCredentials, sessionTargetCredentials: legacyCredentials };
        const workspace = await Promise.all(keys.map(async (key, index) => ({ key, version: index + 4,
            value: await encodeAccountStoredJsonContent({ mode: 'plain', value: record, encryption: null }),
        })));
        const encrypted = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs, fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption: encryption, workspace });
        expect(encrypted).toHaveProperty('workspace.action', 'migrate');
        if (encrypted.workspace?.action !== 'migrate') throw new Error('Missing Workspace migration');
        const items = encrypted.workspace.items;
        expect(items.map(item => ({ key: item.key, version: item.expectedVersion }))).toEqual(workspace.map(row => ({ key: row.key, version: row.version })));
        const plain = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs, fromMode: 'e2ee', toMode: 'plain', sourceEncryption: encryption, targetEncryption: null, workspace: items.map(item => ({ key: item.key, version: item.expectedVersion + 1, value: item.value })) });
        if (plain.workspace?.action !== 'migrate') throw new Error('Missing plain Workspace migration');
        expect(plain.workspace.items.map(item => JSON.parse(Buffer.from(item.value, 'base64').toString('utf8')))).toEqual(keys.map(() => ({ t: 'plain', v: record })));
    });

    it('wraps the replacement Artifact key for current recipients and emits no envelopes for a plain target', async () => {
        const targetEncryption = await Encryption.create(new Uint8Array(32).fill(7));
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const signingSecret = randomBytes(32);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const contentSecret = randomBytes(32);
        const contentPublic = x25519.getPublicKey(contentSecret);
        const fingerprint = computeContentPublicKeyFingerprint(contentPublic);
        const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic });
        const oldEnvelope = Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: randomBytes(32), recipientPublicKey: contentPublic, randomBytes })).toString('base64');
        const workflowHeader = { kind: 'workflow-definition.v1', definitionId: artifactId,
            revision: { headerVersion: 1, bodyVersion: 3 }, metadata: { title: '  Shared  ' },
            savedBy: { kind: 'person', accountId: 'account-a' } };
        expect(workflowDefinitionArtifactSharingAdapterV1.canShare({ artifactId, header: workflowHeader,
            revision: workflowHeader.revision })).toBe(true);
        const rows = [{ id: artifactId, ownership: { kind: 'ordinary' as const }, header: encodePlainArtifactStoredContent(workflowHeader),
            body: encodePlainArtifactStoredContent({ body: 'Private content' }), headerVersion: 1, bodyVersion: 3,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: 'Retained private content' }) }] }];
        const inputs = { ...emptyTransitionInventories, machines: [], todos: [], sessions: [],
            sessionSourceCredentials: tokenOnlyCredentials, sessionTargetCredentials: legacyCredentials };
        const result = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
            fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption, artifacts: rows,
            readArtifactRecipients: async () => ({ artifactId, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [{ recipientAccountId: 'peer',
                    contentKey: { status: 'available', accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'),
                        contentPublicKey: Buffer.from(contentPublic).toString('base64'), contentPublicKeySignature: Buffer.from(signature).toString('base64') },
                    contentPublicKeyFingerprint: fingerprint, encryptedDataKey: oldEnvelope, recipientContentPublicKeyFingerprint: fingerprint }] }),
        });
        if (result.artifacts.action !== 'migrate') throw new Error('Missing Artifact directive');
        const item = result.artifacts.items[0]!;
        expect(item.expectedDataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
        expect(item.recipientKeyEnvelopes?.map(row => row.recipientAccountId)).toEqual(['peer']);
        const ownerKey = await targetEncryption.decryptEncryptionKey(item.dataEncryptionKey);
        expect(ownerKey).not.toBeNull();
        const [encryptedHeader] = await new AES256Encryption(ownerKey!).decrypt([new Uint8Array(Buffer.from(item.header, 'base64'))]);
        const targetHeader = WorkflowDefinitionArtifactHeaderV1Schema.parse(encryptedHeader);
        expect(encryptedHeader).toEqual({ ...workflowHeader, revision: { headerVersion: 2, bodyVersion: 4 } });
        expect(workflowDefinitionArtifactSharingAdapterV1.canShare({ artifactId, header: targetHeader,
            revision: { headerVersion: 2, bodyVersion: 4 } })).toBe(true);
        expect(item.revisions).toHaveLength(1);
        expect(item.revisions[0]).toMatchObject({ bodyVersion: 1, expectedBody: rows[0]!.revisions[0]!.body });
        await expect(new ArtifactEncryption(ownerKey!).decryptBody(item.revisions[0]!.body))
            .resolves.toEqual({ body: 'Retained private content' });
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array(Buffer.from(item.recipientKeyEnvelopes![0]!.encryptedDataKey, 'base64')),
            recipientSecretKeyOrSeed: contentSecret })).toEqual(ownerKey);
        const plain = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs, fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: targetEncryption, targetEncryption: null, sessionSourceCredentials: legacyCredentials, sessionTargetCredentials: null,
            artifacts: [{ ...rows[0]!, header: item.header, body: item.body, dataEncryptionKey: item.dataEncryptionKey,
                headerVersion: 2, bodyVersion: 4,
                revisions: item.revisions.map(revision => ({ bodyVersion: revision.bodyVersion, body: revision.body })) }],
            readArtifactRecipients: async () => { throw new Error('Plain targets must not discover recipients'); },
        });
        expect(plain.artifacts).toMatchObject({ action: 'migrate', items: [{ dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }] });
        if (plain.artifacts.action !== 'migrate') throw new Error('Missing plain directive');
        expect(plain.artifacts.items[0]).toMatchObject({
            expectedDataEncryptionKey: item.dataEncryptionKey,
            recipientKeyEnvelopes: [],
            revisions: [{ bodyVersion: 1, expectedBody: item.revisions[0]!.body,
                body: encodePlainArtifactStoredContent({ body: 'Retained private content' }) }],
        });
        const plainStoredHeader = decodePlainArtifactStoredContent(plain.artifacts.items[0]!.header);
        const plainHeader = WorkflowDefinitionArtifactHeaderV1Schema.parse(plainStoredHeader);
        expect(plainStoredHeader).toEqual({ ...workflowHeader, revision: { headerVersion: 3, bodyVersion: 5 } });
        expect(workflowDefinitionArtifactSharingAdapterV1.canShare({ artifactId, header: plainHeader,
            revision: { headerVersion: 3, bodyVersion: 5 } })).toBe(true);
    });

    it('preserves unrecognized Artifact header metadata without repairing malformed workflow headers across Account modes', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const inputs = { ...emptyTransitionInventories, machines: [], todos: [], sessions: [],
            sessionSourceCredentials: tokenOnlyCredentials, sessionTargetCredentials: legacyCredentials };
        const headers = [
            { kind: 'future-document.v3', v: 2.9, title: null, sessions: 'future-format', customField: { private: true } },
            { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 8, bodyVersion: 9 },
                metadata: { title: 'Unusable workflow' }, extension: { preserve: true } },
            // The current UI Action producer injects this presentation-only
            // field. Raw storage conversion must not repair its strict shape.
            { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 3 },
                metadata: { title: 'UI-produced workflow' }, title: null },
        ];
        for (const header of headers) {
            expect(workflowDefinitionArtifactSharingAdapterV1.canShare({ artifactId, header,
                revision: { headerVersion: 1, bodyVersion: 3 } })).toBe(false);
            const row = { id: artifactId, ownership: { kind: 'ordinary' as const }, header: encodePlainArtifactStoredContent(header), headerVersion: 1,
                body: encodePlainArtifactStoredContent({ body: 'Private content' }), bodyVersion: 3,
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, revisions: [] };
            const encrypted = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
                fromMode: 'plain', toMode: 'e2ee', sourceEncryption: null, targetEncryption: encryption, artifacts: [row],
                readArtifactRecipients: async () => ({ artifactId, ownerAccountId: 'account-a', access: 'owner',
                    encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] }),
            });
            if (encrypted.artifacts.action !== 'migrate') throw new Error('Missing encrypted Artifact directive');
            const item = encrypted.artifacts.items[0]!;
            const dataKey = await encryption.decryptEncryptionKey(item.dataEncryptionKey);
            if (!dataKey) throw new Error('Missing replacement key');
            const [storedHeader] = await new AES256Encryption(dataKey).decrypt([new Uint8Array(Buffer.from(item.header, 'base64'))]);
            expect(storedHeader).toEqual(header);
            const plain = await buildAccountEncryptionMigrationStorageDirectives({ ...inputs,
                fromMode: 'e2ee', toMode: 'plain', sourceEncryption: encryption, targetEncryption: null,
                sessionSourceCredentials: legacyCredentials, sessionTargetCredentials: null,
                artifacts: [{ ...row, header: item.header, body: item.body, dataEncryptionKey: item.dataEncryptionKey,
                    headerVersion: 2, bodyVersion: 4 }],
            });
            if (plain.artifacts.action !== 'migrate') throw new Error('Missing plain Artifact directive');
            expect(decodePlainArtifactStoredContent(plain.artifacts.items[0]!.header)).toEqual(header);
        }
    });

    it('rejects an Artifact key-marker disagreement with the persisted source Account mode before transforming retained history', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const row = { id: '11111111-1111-4111-8111-111111111111',
            ownership: { kind: 'ordinary' as const },
            header: encodePlainArtifactStoredContent({ title: 'Plain head' }), headerVersion: 1,
            body: encodePlainArtifactStoredContent({ body: 'Head' }), bodyVersion: 3,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: 'Retained' }) }] };
        await expect(buildAccountEncryptionMigrationStorageDirectives({ ...emptyTransitionInventories,
            machines: [], todos: [], artifacts: [row], sessions: [], fromMode: 'e2ee', toMode: 'plain',
            sourceEncryption: encryption, targetEncryption: null,
            sessionSourceCredentials: legacyCredentials, sessionTargetCredentials: null,
        })).rejects.toThrow('source Account mode');
    });

    it('rewrites complete plaintext Machine, Todo, Artifact, and Session inventories for e2ee', async () => {
        const targetEncryption =
            await Encryption.create(new Uint8Array(32).fill(7));
        const artifactId = '00000000-0000-4000-8000-000000000001';

        const result =
            await buildAccountEncryptionMigrationStorageDirectives({
                toMode: 'e2ee',
                fromMode: 'plain',
                sourceEncryption: null,
                targetEncryption,
                machines: [{
                    id: 'machine-1',
                    metadata: encodePlainMachineStoredContent({
                        host: 'plain-host',
                        platform: 'darwin',
                        happyCliVersion: '0.2.10',
                        happyHomeDir: '/tmp/happier',
                        homeDir: '/tmp',
                    }),
                    metadataVersion: 2,
                    daemonState: encodePlainMachineStoredContent({
                        status: 'running',
                    }),
                    daemonStateVersion: 3,
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                }],
                todos: [{
                    key: 'todo.index',
                    value: await encodeAccountStoredJsonContent({
                        mode: 'plain',
                        value: { undoneOrder: [], completedOrder: [] },
                        encryption: null,
                    }),
                    version: 4,
                }],
                artifacts: [{
                    id: artifactId,
                    ownership: { kind: 'ordinary' },
                    header: encodePlainArtifactStoredContent({
                        title: 'Plain artifact',
                    }),
                    headerVersion: 5,
                    body: encodePlainArtifactStoredContent({
                        body: 'Plain body',
                    }),
                    bodyVersion: 6,
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    revisions: [],
                }],
                sessions: [{
                    id: 'session-active',
                    metadataLayoutVersion: 1,
                    metadataVersion: 7,
                    agentStateVersion: 8,
                    ownerMetadata: {
                        t: 'plain',
                        v: { v: 1 },
                    },
                }],
                ...emptyTransitionInventories,
                sessionSourceCredentials: tokenOnlyCredentials,
                sessionTargetCredentials: legacyCredentials,
            });

        expect(result.machines).toMatchObject({
            action: 'migrate',
            items: [{
                machineId: 'machine-1',
                expectedMetadataVersion: 2,
                expectedDaemonStateVersion: 3,
                contentPublicKeyFingerprint:
                    computeContentPublicKeyFingerprint(
                        targetEncryption.contentDataKey,
                    ),
            }],
        });
        expect(result.todos).toMatchObject({
            action: 'migrate',
            items: [{
                key: 'todo.index',
                expectedVersion: 4,
            }],
        });
        expect(result.artifacts).toMatchObject({
            action: 'migrate',
            items: [{
                artifactId,
                expectedHeaderVersion: 5,
                expectedBodyVersion: 6,
            }],
        });
        expect(result.sessions).toMatchObject({
            action: 'migrate',
            items: [{
                sessionId: 'session-active',
                expectedMetadataLayoutVersion: 1,
                expectedMetadataVersion: 7,
                expectedAgentStateVersion: 8,
                expectedOwnerMetadata: {
                    t: 'plain',
                    v: { v: 1 },
                },
                ownerMetadata: { t: 'encrypted' },
            }],
        });
        if (result.sessions.action !== 'migrate') {
            throw new Error('expected Session migration');
        }
        expect(openSessionOwnerMetadataEnvelopeV1({
            accountMode: 'e2ee',
            envelope: result.sessions.items[0]!.ownerMetadata,
            material: {
                type: 'legacy',
                secret: new Uint8Array(32).fill(7),
            },
        })).toEqual({ ok: true, ownerMetadata: { v: 1 } });
        expect(result.machines.action === 'migrate'
            && result.machines.items[0]?.dataEncryptionKey)
            .not.toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
        expect(result.artifacts.action === 'migrate'
            && result.artifacts.items[0]?.dataEncryptionKey)
            .not.toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    });

    it('builds every Session replacement beyond the former 500-item ceiling', async () => {
        const material = {
            type: 'legacy' as const,
            secret: new Uint8Array(32).fill(7),
        };
        const sourceOwnerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material,
            ownerMetadata: { v: 1 },
            randomBytes: (length) => new Uint8Array(length).fill(11),
        });

        const result = await buildAccountEncryptionMigrationStorageDirectives({
            toMode: 'plain',
            fromMode: 'e2ee',
            sourceEncryption: null,
            targetEncryption: null,
            machines: [],
            todos: [],
            artifacts: [],
            sessions: Array.from({ length: 501 }, (_, index) => ({
                id: `session-${index}`,
                metadataLayoutVersion: 1 as const,
                metadataVersion: index,
                agentStateVersion: index,
                ownerMetadata: sourceOwnerMetadata,
            })),
            ...emptyTransitionInventories,
            sessionSourceCredentials: legacyCredentials,
            sessionTargetCredentials: null,
        });

        expect(result.sessions.action).toBe('migrate');
        if (result.sessions.action !== 'migrate') {
            throw new Error('expected Session migration');
        }
        expect(result.sessions.items).toHaveLength(501);
        expect(result.sessions.items.at(-1)).toMatchObject({
            sessionId: 'session-500',
            ownerMetadata: { t: 'plain', v: { v: 1 } },
        });
    });

    it('uses strict empty assertions rather than inventing migration work', async () => {
        await expect(
            buildAccountEncryptionMigrationStorageDirectives({
                toMode: 'plain',
                fromMode: 'e2ee',
                sourceEncryption: null,
                targetEncryption: null,
                machines: [],
                todos: [],
                artifacts: [],
                sessions: [],
                ...emptyTransitionInventories,
                sessionSourceCredentials: tokenOnlyCredentials,
                sessionTargetCredentials: null,
            }),
        ).resolves.toEqual({
            machines: { action: 'assert_empty' },
            todos: { action: 'assert_empty' },
            artifacts: { action: 'assert_empty' },
            sessions: { action: 'assert_empty' },
            reviewComments: { action: 'assert_empty' },
            sessionOrganization: { action: 'assert_empty' },
            pets: { action: 'assert_empty' },
        });
    });

    it('rejects a malformed Todo inventory through the canonical Todo codec', async () => {
        await expect(
            buildAccountEncryptionMigrationStorageDirectives({
                toMode: 'plain',
                fromMode: 'e2ee',
                sourceEncryption: null,
                targetEncryption: null,
                machines: [],
                todos: [{
                    key: 'todo.index',
                    value: await encodeAccountStoredJsonContent({
                        mode: 'plain',
                        value: {
                            undoneOrder: 'invalid',
                            completedOrder: [],
                        },
                        encryption: null,
                    }),
                    version: 4,
                }],
                artifacts: [],
                sessions: [],
                ...emptyTransitionInventories,
                sessionSourceCredentials: tokenOnlyCredentials,
                sessionTargetCredentials: null,
            }),
        ).rejects.toMatchObject({
            code: 'todo_stored_content_unavailable',
            key: 'todo.index',
        });
    });

    it('rejects Todo transition inventory whose source envelope disagrees with the exact source Account mode', async () => {
        const encryption = await Encryption.create(
            new Uint8Array(32).fill(7),
        );
        const encryptedIndex = await encodeAccountStoredJsonContent({
            mode: 'e2ee',
            value: { undoneOrder: [], completedOrder: [] },
            encryption,
        });
        const plainIndex = await encodeAccountStoredJsonContent({
            mode: 'plain',
            value: { undoneOrder: [], completedOrder: [] },
            encryption: null,
        });

        for (const mismatch of [
            {
                fromMode: 'plain' as const,
                toMode: 'e2ee' as const,
                value: encryptedIndex,
                sourceEncryption: encryption,
                targetEncryption: encryption,
                sourceCredentials: tokenOnlyCredentials,
                targetCredentials: legacyCredentials,
            },
            {
                fromMode: 'e2ee' as const,
                toMode: 'plain' as const,
                value: plainIndex,
                sourceEncryption: encryption,
                targetEncryption: null,
                sourceCredentials: legacyCredentials,
                targetCredentials: null,
            },
        ]) {
            await expect(
                buildAccountEncryptionMigrationStorageDirectives({
                    fromMode: mismatch.fromMode,
                    toMode: mismatch.toMode,
                    sourceEncryption: mismatch.sourceEncryption,
                    targetEncryption: mismatch.targetEncryption,
                    machines: [],
                    todos: [{
                        key: 'todo.index',
                        value: mismatch.value,
                        version: 4,
                    }],
                    artifacts: [],
                    sessions: [],
                    ...emptyTransitionInventories,
                    sessionSourceCredentials:
                        mismatch.sourceCredentials,
                    sessionTargetCredentials:
                        mismatch.targetCredentials,
                }),
            ).rejects.toMatchObject({
                code: 'todo_stored_content_unavailable',
                key: 'todo.index',
                reason: 'account_mode_mismatch',
            });
        }
    });

    it('rejects an encrypted Session owner envelope when source material is unavailable', async () => {
        const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: {
                type: 'legacy',
                secret: new Uint8Array(32).fill(4),
            },
            ownerMetadata: { v: 1 },
            randomBytes: (length) => new Uint8Array(length).fill(2),
        });
        await expect(
            buildAccountEncryptionMigrationStorageDirectives({
                toMode: 'plain',
                fromMode: 'e2ee',
                sourceEncryption: null,
                targetEncryption: null,
                machines: [],
                todos: [],
                artifacts: [],
                sessions: [{
                    id: 'session-locked',
                    metadataLayoutVersion: 1,
                    metadataVersion: 3,
                    agentStateVersion: 4,
                    ownerMetadata,
                }],
                ...emptyTransitionInventories,
                sessionSourceCredentials: tokenOnlyCredentials,
                sessionTargetCredentials: null,
            }),
        ).rejects.toThrow(
            'Session owner metadata is unavailable (session-locked)',
        );
    });

    it('rejects a Session source envelope that disagrees with the source Account mode', async () => {
        const ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: {
                type: 'legacy',
                secret: new Uint8Array(32).fill(7),
            },
            ownerMetadata: { v: 1 },
            randomBytes: (length) => new Uint8Array(length).fill(2),
        });
        await expect(
            buildAccountEncryptionMigrationStorageDirectives({
                toMode: 'e2ee',
                fromMode: 'plain',
                sourceEncryption: null,
                targetEncryption: null,
                machines: [],
                todos: [],
                artifacts: [],
                sessions: [{
                    id: 'session-wrong-source',
                    metadataLayoutVersion: 1,
                    metadataVersion: 3,
                    agentStateVersion: 4,
                    ownerMetadata,
                }],
                ...emptyTransitionInventories,
                sessionSourceCredentials: legacyCredentials,
                sessionTargetCredentials: legacyCredentials,
            }),
        ).rejects.toMatchObject({
            code: 'session_owner_metadata_account_mode_mismatch',
            reason: 'account_mode_mismatch',
        });
    });

    it('aborts locally when an E2EE target Session envelope cannot be reopened', async () => {
        const actualOpen =
            protocol.openSessionOwnerMetadataEnvelopeV1;
        const openSpy = vi
            .spyOn(protocol, 'openSessionOwnerMetadataEnvelopeV1')
            .mockImplementationOnce(actualOpen)
            .mockReturnValueOnce({
                ok: false,
                reason: 'invalid_ciphertext',
            });
        try {
            await expect(
                buildAccountEncryptionMigrationStorageDirectives({
                    toMode: 'e2ee',
                    fromMode: 'plain',
                    sourceEncryption: null,
                    targetEncryption: null,
                    machines: [],
                    todos: [],
                    artifacts: [],
                    sessions: [{
                        id: 'session-round-trip',
                        metadataLayoutVersion: 1,
                        metadataVersion: 3,
                        agentStateVersion: 4,
                        ownerMetadata: {
                            t: 'plain',
                            v: { v: 1 },
                        },
                    }],
                    ...emptyTransitionInventories,
                    sessionSourceCredentials: tokenOnlyCredentials,
                    sessionTargetCredentials: legacyCredentials,
                }),
            ).rejects.toThrow(
                'Target Session owner metadata verification failed',
            );
        } finally {
            openSpy.mockRestore();
        }
    });
});
