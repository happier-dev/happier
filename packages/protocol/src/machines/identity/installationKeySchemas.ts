import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { decodeBase64 } from '../../crypto/base64.js';
import { ED25519_PUBLIC_KEY_BYTES, ED25519_SECRET_KEY_BYTES, ED25519_SIGNATURE_BYTES, isValidEd25519PublicKey } from '../../crypto/ed25519.js';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function validateBase64UrlEncodedBytes(
    value: string,
    fieldName: string,
    expectedLength: number,
    ctx: z.RefinementCtx,
    path: ReadonlyArray<string | number> = [],
): void {
    if (!BASE64URL_PATTERN.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: `${fieldName} must use unpadded base64url encoding` });
        return;
    }
    try {
        const bytes = decodeBase64(value, 'base64url');
        if (bytes.length !== expectedLength) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: `${fieldName} must decode to ${expectedLength} bytes` });
        }
    } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: `${fieldName} must be base64url-encoded key material` });
    }
}

export const MachineInstallationPublicKeySchema = lazyZodSchema(() => z.string().trim().min(1)
    .superRefine((value, ctx) => {
        validateBase64UrlEncodedBytes(value, 'installationPublicKey', ED25519_PUBLIC_KEY_BYTES, ctx);
        try {
            if (!isValidEd25519PublicKey(decodeBase64(value, 'base64url'))) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Ed25519 installation public key' });
            }
        } catch {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Ed25519 installation public key' });
        }
    }));

export const MachineInstallationPublicIdentityV1Schema = lazyZodSchema(() => z.object({
    machineId: z.string().trim().min(1),
    installationId: z.string().trim().min(1),
    installationPublicKey: MachineInstallationPublicKeySchema,
}).strict());
export type MachineInstallationPublicIdentityV1 = Readonly<z.infer<typeof MachineInstallationPublicIdentityV1Schema>>;

export const MachineInstallationPrivateKeySchema = lazyZodSchema(() => z.string().trim().min(1)
    .superRefine((value, ctx) => {
        validateBase64UrlEncodedBytes(value, 'privateKey', ED25519_SECRET_KEY_BYTES, ctx);
    }));

export const MachineInstallationProofSignatureSchema = lazyZodSchema(() => z.string().trim().min(1)
    .superRefine((value, ctx) => {
        validateBase64UrlEncodedBytes(value, 'signature', ED25519_SIGNATURE_BYTES, ctx);
    }));
