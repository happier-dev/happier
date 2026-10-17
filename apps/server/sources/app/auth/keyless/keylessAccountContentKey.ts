import { randomBytes } from "node:crypto";
import * as privacyKit from "privacy-kit";
import { z } from "zod";
import { sealTerminalProvisioningV2Payload } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { deriveCurve25519KeyPair } from "@/modules/encrypt";
import { computeContentPublicKeyFingerprint } from "@/app/machines/installationProof";

/**
 * The content keypair of a keyless account, in the data-key credential shape clients store
 * (`encryption.publicKey` / `encryption.machineKey`, standard base64).
 */
export const KeylessAccountContentKeySchema = z.object({
    publicKey: z.string(),
    machineKey: z.string(),
});

export type KeylessAccountContentKey = z.infer<typeof KeylessAccountContentKeySchema>;

/**
 * One content keypair per keyless account, derived from the server key tree (HANDY_MASTER_SECRET)
 * and the account id. Nothing is stored: every call returns the same keypair, and rotating the
 * master secret rotates it.
 *
 * Keyless accounts have no account signing key and are always plain, so the server can already
 * read everything this key protects. Handing it to every device of the account replaces the random
 * per-device keypairs that left machine RPC working only between a terminal and the device that
 * approved it.
 */
export function deriveKeylessAccountContentKey(accountId: string): KeylessAccountContentKey {
    const keyPair = deriveCurve25519KeyPair(["auth", "keyless", "content-key", accountId]);
    return {
        publicKey: privacyKit.encodeBase64(keyPair.public),
        machineKey: privacyKit.encodeBase64(keyPair.secret),
    };
}

export function deriveKeylessAccountContentPublicKeyFingerprint(accountId: string): string {
    return computeContentPublicKeyFingerprint(privacyKit.decodeBase64(deriveKeylessAccountContentKey(accountId).publicKey));
}

/** Keyless means the account has no signing key (`resolveEffectiveAccountEncryptionModeFromAccountRow` treats it as plain). */
export async function isKeylessAccount(accountId: string): Promise<boolean> {
    const account = await db.account.findUnique({ where: { id: accountId }, select: { publicKey: true } });
    return account !== null && !account.publicKey;
}

/** The account content key for a sign-in response, or null for an account that holds its own keys. */
export async function resolveKeylessAccountContentKey(accountId: string): Promise<KeylessAccountContentKey | null> {
    return await isKeylessAccount(accountId) ? deriveKeylessAccountContentKey(accountId) : null;
}

/**
 * The terminal provisioning response for a keyless account: the account content private key in the
 * v2 format (`[0x00, key]` sealed to the terminal's one-time key), whichever device approved.
 * Returns null for an account that holds its own keys, whose approver response is relayed as sent.
 */
export async function sealKeylessAccountTerminalProvisioning(
    accountId: string,
    terminalPublicKey: Uint8Array,
): Promise<string | null> {
    const contentKey = await resolveKeylessAccountContentKey(accountId);
    if (!contentKey) return null;
    const sealed = sealTerminalProvisioningV2Payload({
        contentPrivateKey: privacyKit.decodeBase64(contentKey.machineKey),
        recipientPublicKey: terminalPublicKey,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    return privacyKit.encodeBase64(new Uint8Array(sealed));
}
