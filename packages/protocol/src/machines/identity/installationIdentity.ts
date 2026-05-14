import tweetnacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { MachineReplacementReasonSchema } from './machineReplacement.js';

const CONTENT_PUBLIC_KEY_FINGERPRINT_PREFIX = 'content-public-key-sha256:' as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const ContentPublicKeyFingerprintSchema = z.string()
    .regex(new RegExp(`^${CONTENT_PUBLIC_KEY_FINGERPRINT_PREFIX}[a-f0-9]{64}$`, 'u'));

export type ContentPublicKeyFingerprint = z.infer<typeof ContentPublicKeyFingerprintSchema>;

function validateBase64UrlEncodedBytes(
    value: string,
    fieldName: string,
    expectedLength: number,
    ctx: z.RefinementCtx,
    path: ReadonlyArray<string | number> = [],
): void {
    if (!BASE64URL_PATTERN.test(value)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: `${fieldName} must use unpadded base64url encoding`,
        });
        return;
    }

    try {
        const bytes = decodeBase64(value, 'base64url');
        if (bytes.length !== expectedLength) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path],
                message: `${fieldName} must decode to ${expectedLength} bytes`,
            });
        }
    } catch {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path],
            message: `${fieldName} must be base64url-encoded key material`,
        });
    }
}

export const MachineInstallationPublicKeySchema = z.string().trim().min(1)
    .superRefine((value, ctx) => {
        validateBase64UrlEncodedBytes(value, 'installationPublicKey', tweetnacl.sign.publicKeyLength, ctx);
    });

export const MachineInstallationPrivateKeySchema = z.string().trim().min(1)
    .superRefine((value, ctx) => {
        validateBase64UrlEncodedBytes(value, 'privateKey', tweetnacl.sign.secretKeyLength, ctx);
    });

export const MachineInstallationProofSignatureSchema = z.string().trim().min(1)
    .superRefine((value, ctx) => {
        validateBase64UrlEncodedBytes(value, 'signature', tweetnacl.sign.signatureLength, ctx);
    });

export const MachineInstallationIdentityV1Schema = z.object({
    version: z.literal(1),
    installationId: z.string().trim().min(1),
    createdAt: z.number().int().nonnegative(),
    publicKey: z.string().trim().min(1),
    privateKey: z.string().trim().min(1),
}).superRefine((identity, ctx) => {
    validateBase64UrlEncodedBytes(identity.publicKey, 'publicKey', tweetnacl.sign.publicKeyLength, ctx, ['publicKey']);
    validateBase64UrlEncodedBytes(identity.privateKey, 'privateKey', tweetnacl.sign.secretKeyLength, ctx, ['privateKey']);
});

export type MachineInstallationIdentityV1 = z.infer<typeof MachineInstallationIdentityV1Schema>;

export const MachineInstallationProofPayloadV1Schema = z.object({
    version: z.literal(1),
    installationId: z.string().trim().min(1),
    machineId: z.string().trim().min(1),
    replacesMachineId: z.string().trim().min(1).optional(),
    replacementReason: MachineReplacementReasonSchema.optional(),
    contentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema.optional(),
    accountId: z.string().trim().min(1).optional(),
});

export type MachineInstallationProofPayloadV1 = z.infer<typeof MachineInstallationProofPayloadV1Schema>;

export const MachineInstallationProofV1Schema = z.object({
    version: z.literal(1),
    algorithm: z.literal('ed25519'),
    signature: MachineInstallationProofSignatureSchema,
});

export type MachineInstallationProofV1 = z.infer<typeof MachineInstallationProofV1Schema>;

function encodeUtf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function normalizeProofPayload(
    payload: MachineInstallationProofPayloadV1,
): MachineInstallationProofPayloadV1 {
    return MachineInstallationProofPayloadV1Schema.parse(payload);
}

export function buildMachineInstallationProofPayloadBytes(
    payload: MachineInstallationProofPayloadV1,
): Uint8Array {
    const normalized = normalizeProofPayload(payload);
    return encodeUtf8(JSON.stringify({
        version: normalized.version,
        installationId: normalized.installationId,
        machineId: normalized.machineId,
        ...(normalized.replacesMachineId ? { replacesMachineId: normalized.replacesMachineId } : null),
        ...(normalized.replacementReason ? { replacementReason: normalized.replacementReason } : null),
        ...(normalized.contentPublicKeyFingerprint
            ? { contentPublicKeyFingerprint: normalized.contentPublicKeyFingerprint }
            : null),
        ...(normalized.accountId ? { accountId: normalized.accountId } : null),
    }));
}

export function signMachineInstallationProof(params: Readonly<{
    payload: MachineInstallationProofPayloadV1;
    privateKey: string | Uint8Array;
}>): MachineInstallationProofV1 {
    const privateKeyBytes = typeof params.privateKey === 'string'
        ? decodeBase64(MachineInstallationPrivateKeySchema.parse(params.privateKey), 'base64url')
        : params.privateKey;
    if (privateKeyBytes.length !== tweetnacl.sign.secretKeyLength) {
        throw new Error(`Invalid installation private key length: expected ${tweetnacl.sign.secretKeyLength} bytes`);
    }
    const signature = tweetnacl.sign.detached(
        buildMachineInstallationProofPayloadBytes(params.payload),
        privateKeyBytes,
    );
    return {
        version: 1,
        algorithm: 'ed25519',
        signature: encodeBase64(signature, 'base64url'),
    };
}

export function verifyMachineInstallationProof(params: Readonly<{
    payload: MachineInstallationProofPayloadV1;
    proof: MachineInstallationProofV1;
    publicKey: string | Uint8Array;
}>): boolean {
    const proof = MachineInstallationProofV1Schema.safeParse(params.proof);
    if (!proof.success) return false;

    let publicKeyBytes: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
        publicKeyBytes = typeof params.publicKey === 'string'
            ? decodeBase64(MachineInstallationPublicKeySchema.parse(params.publicKey), 'base64url')
            : params.publicKey;
        signatureBytes = decodeBase64(proof.data.signature, 'base64url');
    } catch {
        return false;
    }

    if (publicKeyBytes.length !== tweetnacl.sign.publicKeyLength) return false;
    if (signatureBytes.length !== tweetnacl.sign.signatureLength) return false;

    try {
        return tweetnacl.sign.detached.verify(
            buildMachineInstallationProofPayloadBytes(params.payload),
            signatureBytes,
            publicKeyBytes,
        );
    } catch {
        return false;
    }
}

export function computeContentPublicKeyFingerprint(publicKey: Uint8Array | string): string {
    const bytes = typeof publicKey === 'string'
        ? decodeBase64(publicKey, 'base64url')
        : publicKey;
    const hex = bytesToHex(sha256(bytes));
    if (!SHA256_HEX_PATTERN.test(hex)) {
        throw new Error('Failed to compute content public key fingerprint');
    }
    return `${CONTENT_PUBLIC_KEY_FINGERPRINT_PREFIX}${hex}`;
}
