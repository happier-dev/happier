import { describe, expect, it, vi } from 'vitest';
import * as protocol from '@happier-dev/protocol';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    computeContentPublicKeyFingerprint,
    encodePlainArtifactStoredContent,
    openSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

import { Encryption } from '@/sync/encryption/encryption';
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
        reviewCommentsInventory: { v: 1 as const, items: [] },
        sessionOrganizationInventory: {
            version: 0,
            folders: [],
            tags: [],
            labels: [],
        },
    };

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
                    header: encodePlainArtifactStoredContent({
                        title: 'Plain artifact',
                    }),
                    headerVersion: 5,
                    body: encodePlainArtifactStoredContent({
                        body: 'Plain body',
                    }),
                    bodyVersion: 6,
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
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
