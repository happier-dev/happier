import {
    SessionOwnerMetadataV1Schema,
    createPlainSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import { readSessionLayout1OwnerMetadata } from './readSessionLayout1OwnerProjection';

const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
    v: 1,
    workspace: { path: '/private/worktree' },
});
const secret = new Uint8Array(32).fill(7);
const credentials = {
    token: 'token',
    secret: Buffer.from(secret).toString('base64url'),
};

describe('readSessionLayout1OwnerMetadata', () => {
    it('opens owner metadata using persisted Account mode independently from Session mode', () => {
        expect(readSessionLayout1OwnerMetadata({
            share: null,
            accountMode: 'plain',
            ownerMetadataEnvelope:
                createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
            credentials: { token: 'token' },
        })).toMatchObject({
            kind: 'owner',
            ownerMetadata,
        });

        expect(readSessionLayout1OwnerMetadata({
            share: null,
            accountMode: 'e2ee',
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials,
        })).toMatchObject({
            kind: 'owner',
            ownerMetadata,
        });
    });

    it.each([
        {
            accountMode: 'plain' as const,
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy' as const, secret },
                ownerMetadata,
                randomBytes: (length: number) =>
                    new Uint8Array(length).fill(1),
            }),
        },
        {
            accountMode: 'e2ee' as const,
            ownerMetadataEnvelope:
                createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
        },
    ])(
        'fails closed before disclosure when $accountMode Account mode disagrees with the envelope',
        ({ accountMode, ownerMetadataEnvelope }) => {
            expect(readSessionLayout1OwnerMetadata({
                share: null,
                accountMode,
                ownerMetadataEnvelope,
                credentials,
            })).toMatchObject({
                kind: 'unavailable',
                reason: 'account_mode_mismatch',
            });
        },
    );

    it('fails closed when E2EE material is unavailable', () => {
        const dataKeyCredentials = {
            token: 'token',
            encryption: {
                publicKey: encodeBase64(new Uint8Array(32).fill(8), 'base64'),
                machineKey: encodeBase64(secret, 'base64'),
            },
        } as const;
        expect(readSessionLayout1OwnerMetadata({
            share: null,
            accountMode: 'e2ee',
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: {
                    type: 'dataKey',
                    machineKey: new Uint8Array(32).fill(9),
                },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials: dataKeyCredentials,
        })).toMatchObject({
            kind: 'unavailable',
            reason: 'invalid_ciphertext',
        });
    });

    it('treats share presence as recipient authority before an overprojected owner envelope', () => {
        expect(readSessionLayout1OwnerMetadata({
            share: {
                accessLevel: 'view',
                canApprovePermissions: false,
            },
            accountMode: 'e2ee',
            ownerMetadataEnvelope: sealSessionOwnerMetadataEnvelopeV1({
                material: { type: 'legacy', secret },
                ownerMetadata,
                randomBytes: (length) => new Uint8Array(length).fill(1),
            }),
            credentials,
        })).toEqual({ kind: 'recipient' });
    });
});
