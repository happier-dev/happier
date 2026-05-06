import { describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import type { Credentials } from '@/persistence';

import { resolveCliVoicePromptStackBlocks } from './resolveCliVoicePromptStackBlocks';
import type { PromptArtifactRecord } from './resolveCliPromptStackSystemAppendBlocks';

function createPromptDocArtifactRecord(params: Readonly<{
    artifactId: string;
    markdown: string;
    recipientPublicKey: Uint8Array;
}>): PromptArtifactRecord {
    const dataKey = new Uint8Array(32).fill(7);
    const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey: params.recipientPublicKey,
        randomBytes: (size) => new Uint8Array(size).fill(3),
    });

    return {
        id: params.artifactId,
        body: encodeBase64(encryptWithDataKey({
            body: JSON.stringify({
                v: 1,
                markdown: params.markdown,
                createdAtMs: 1,
                updatedAtMs: 1,
            }),
        }, dataKey)),
        dataEncryptionKey: encodeBase64(encryptedDataKey),
    };
}

describe('resolveCliVoicePromptStackBlocks', () => {
    it('resolves voice prompt-stack blocks from explicit account settings', async () => {
        const machineKey = new Uint8Array(32).fill(9);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const credentials: Credentials = {
            token: 'token',
            encryption: {
                type: 'dataKey',
                machineKey,
                publicKey,
            },
        };

        const artifactById: Record<string, PromptArtifactRecord> = {
            v1: createPromptDocArtifactRecord({
                artifactId: 'v1',
                markdown: 'Voice stack block',
                recipientPublicKey: publicKey,
            }),
        };

        const blocks = await resolveCliVoicePromptStackBlocks({
            credentials,
            settings: {
                promptStacksV1: {
                    v: 1,
                    surfaces: {
                        coding: [],
                        voice: [
                            {
                                id: 'voice-entry',
                                ref: { kind: 'doc', artifactId: 'v1' },
                                enabled: true,
                                placement: 'system_append',
                                editPolicy: 'user_only',
                            },
                        ],
                        profilesById: {},
                    },
                },
            },
            fetchPromptArtifactRecord: async (artifactId) => artifactById[artifactId] ?? null,
        });

        expect(blocks).toEqual(['Voice stack block']);
    });

    it('includes profile-scoped voice prompt-stack blocks when profileId is provided', async () => {
        const machineKey = new Uint8Array(32).fill(5);
        const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
        const credentials: Credentials = {
            token: 'token',
            encryption: {
                type: 'dataKey',
                machineKey,
                publicKey,
            },
        };

        const artifactById: Record<string, PromptArtifactRecord> = {
            shared: createPromptDocArtifactRecord({
                artifactId: 'shared',
                markdown: 'Shared voice block',
                recipientPublicKey: publicKey,
            }),
            profile: createPromptDocArtifactRecord({
                artifactId: 'profile',
                markdown: 'Profile voice block',
                recipientPublicKey: publicKey,
            }),
        };

        const blocks = await resolveCliVoicePromptStackBlocks({
            credentials,
            profileId: 'work',
            settings: {
                promptStacksV1: {
                    v: 1,
                    surfaces: {
                        coding: [],
                        voice: [
                            {
                                id: 'voice-entry',
                                ref: { kind: 'doc', artifactId: 'shared' },
                                enabled: true,
                                placement: 'system_append',
                                editPolicy: 'user_only',
                            },
                        ],
                        profilesById: {
                            work: [
                                {
                                    id: 'voice-profile-entry',
                                    ref: { kind: 'doc', artifactId: 'profile' },
                                    enabled: true,
                                    placement: 'system_append',
                                    editPolicy: 'user_only',
                                },
                            ],
                        },
                    },
                },
            },
            fetchPromptArtifactRecord: async (artifactId) => artifactById[artifactId] ?? null,
        });

        expect(blocks).toEqual(['Shared voice block', 'Profile voice block']);
    });
});
