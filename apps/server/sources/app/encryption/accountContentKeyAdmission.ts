import { timingSafeEqual } from "node:crypto";

import {
    computeContentPublicKeyFingerprint,
    type ContentPublicKeyFingerprint,
} from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import type { Tx } from "@/storage/inTx";

const CONTENT_KEY_BINDING_PREFIX = Buffer.from(
    "Happy content key v1\u0000",
    "utf8",
);

type AccountContentKeyClient = Pick<Tx, "account">;

export type VerifiedAccountContentKeyBinding = Readonly<{
    contentPublicKey: Uint8Array<ArrayBuffer>;
    contentPublicKeySignature: Uint8Array<ArrayBuffer>;
    contentPublicKeyFingerprint: ContentPublicKeyFingerprint;
}>;

export type AccountContentKeyAdmissionResult =
    | Readonly<{
        status: "initialized" | "unchanged" | "signature_filled";
        binding: VerifiedAccountContentKeyBinding;
    }>
    | Readonly<{
        status: "account_not_found" | "invalid_binding" | "key_mismatch";
    }>;

export type AccountEncryptionCurrentness = Readonly<{
    encryptionMode: "plain" | "e2ee";
    contentPublicKey: Uint8Array<ArrayBuffer> | null;
    contentPublicKeySignature: Uint8Array<ArrayBuffer> | null;
    contentPublicKeyFingerprint: ContentPublicKeyFingerprint | null;
}>;

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function bytesEqual(
    left: Uint8Array | null,
    right: Uint8Array | null,
): boolean {
    if (left === null || right === null) return left === right;
    if (left.byteLength !== right.byteLength) return false;
    return timingSafeEqual(
        Buffer.from(left.buffer, left.byteOffset, left.byteLength),
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
    );
}

function decodeAccountSigningPublicKey(
    publicKeyHex: string | null,
): Uint8Array<ArrayBuffer> | null {
    if (
        typeof publicKeyHex !== "string"
        || publicKeyHex.length !== tweetnacl.sign.publicKeyLength * 2
        || !/^[0-9a-f]+$/iu.test(publicKeyHex)
    ) {
        return null;
    }
    return copyBytes(Buffer.from(publicKeyHex, "hex"));
}

export function verifyAccountContentKeyBinding(params: Readonly<{
    accountSigningPublicKey: Uint8Array;
    contentPublicKey: Uint8Array;
    contentPublicKeySignature: Uint8Array;
}>): VerifiedAccountContentKeyBinding | null {
    if (
        params.accountSigningPublicKey.byteLength
            !== tweetnacl.sign.publicKeyLength
        || params.contentPublicKey.byteLength
            !== tweetnacl.box.publicKeyLength
        || params.contentPublicKeySignature.byteLength
            !== tweetnacl.sign.signatureLength
    ) {
        return null;
    }

    const contentPublicKey = copyBytes(params.contentPublicKey);
    const contentPublicKeySignature = copyBytes(
        params.contentPublicKeySignature,
    );
    const signedPayload = Buffer.concat([
        CONTENT_KEY_BINDING_PREFIX,
        Buffer.from(contentPublicKey),
    ]);
    try {
        if (!tweetnacl.sign.detached.verify(
            signedPayload,
            contentPublicKeySignature,
            params.accountSigningPublicKey,
        )) {
            return null;
        }
    } catch {
        return null;
    }

    return {
        contentPublicKey,
        contentPublicKeySignature,
        contentPublicKeyFingerprint:
            computeContentPublicKeyFingerprint(contentPublicKey),
    };
}

export function verifyAccountContentKeyBindingForAccountPublicKey(
    params: Readonly<{
        accountPublicKeyHex: string | null;
        contentPublicKey: Uint8Array;
        contentPublicKeySignature: Uint8Array;
    }>,
): VerifiedAccountContentKeyBinding | null {
    const accountSigningPublicKey = decodeAccountSigningPublicKey(
        params.accountPublicKeyHex,
    );
    if (!accountSigningPublicKey) return null;
    return verifyAccountContentKeyBinding({
        accountSigningPublicKey,
        contentPublicKey: params.contentPublicKey,
        contentPublicKeySignature: params.contentPublicKeySignature,
    });
}

function verifyStoredAccountContentKeyBinding(account: Readonly<{
    publicKey: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>): VerifiedAccountContentKeyBinding | null {
    if (
        account.contentPublicKey === null
        || account.contentPublicKeySig === null
    ) {
        return null;
    }
    return verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: account.publicKey,
        contentPublicKey: account.contentPublicKey,
        contentPublicKeySignature: account.contentPublicKeySig,
    });
}

export async function admitAccountContentKey(
    client: AccountContentKeyClient,
    params: Readonly<{
        accountId: string;
        contentPublicKey: Uint8Array;
        contentPublicKeySignature: Uint8Array;
    }>,
): Promise<AccountContentKeyAdmissionResult> {
    const readAccount = async () => await client.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    let account = await readAccount();
    if (!account) return { status: "account_not_found" };

    const binding = verifyAccountContentKeyBindingForAccountPublicKey({
        accountPublicKeyHex: account.publicKey,
        contentPublicKey: params.contentPublicKey,
        contentPublicKeySignature: params.contentPublicKeySignature,
    });
    if (!binding) return { status: "invalid_binding" };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (account.contentPublicKey === null) {
            const initialized = await client.account.updateMany({
                where: {
                    id: params.accountId,
                    contentPublicKey: null,
                },
                data: {
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig:
                        binding.contentPublicKeySignature,
                },
            });
            if (initialized.count === 1) {
                return { status: "initialized", binding };
            }
        } else if (!bytesEqual(
            account.contentPublicKey,
            binding.contentPublicKey,
        )) {
            return { status: "key_mismatch" };
        } else if (account.contentPublicKeySig === null) {
            const filled = await client.account.updateMany({
                where: {
                    id: params.accountId,
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig: null,
                },
                data: {
                    contentPublicKeySig:
                        binding.contentPublicKeySignature,
                },
            });
            if (filled.count === 1) {
                return { status: "signature_filled", binding };
            }
        } else {
            const storedBinding =
                verifyStoredAccountContentKeyBinding(account);
            return storedBinding
                ? { status: "unchanged", binding: storedBinding }
                : { status: "invalid_binding" };
        }

        account = await readAccount();
        if (!account) return { status: "account_not_found" };
    }
    if (!bytesEqual(
        account.contentPublicKey,
        binding.contentPublicKey,
    )) {
        return { status: "key_mismatch" };
    }
    const storedBinding = verifyStoredAccountContentKeyBinding(account);
    return storedBinding
        ? { status: "unchanged", binding: storedBinding }
        : { status: "invalid_binding" };
}

export function deriveAccountEncryptionCurrentnessFromRow(
    account: Readonly<{
        publicKey: string | null;
        encryptionMode: string | null;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>,
): Readonly<AccountEncryptionCurrentness> {
    const contentPublicKey = account.contentPublicKey
        ? copyBytes(account.contentPublicKey)
        : null;
    const contentPublicKeySignature = account.contentPublicKeySig
        ? copyBytes(account.contentPublicKeySig)
        : null;
    const verifiedBinding =
        contentPublicKey && contentPublicKeySignature
            ? verifyAccountContentKeyBindingForAccountPublicKey({
                accountPublicKeyHex: account.publicKey,
                contentPublicKey,
                contentPublicKeySignature,
            })
            : null;

    return {
        encryptionMode:
            resolveEffectiveAccountEncryptionModeFromAccountRow(account),
        contentPublicKey,
        contentPublicKeySignature,
        contentPublicKeyFingerprint:
            verifiedBinding?.contentPublicKeyFingerprint ?? null,
    };
}
