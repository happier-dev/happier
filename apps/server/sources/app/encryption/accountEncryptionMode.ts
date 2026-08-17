export type EffectiveAccountEncryptionMode = "plain" | "e2ee";

export type AccountEncryptionModeResolution =
    | Readonly<{
        status: "ready";
        mode: EffectiveAccountEncryptionMode;
    }>
    | Readonly<{
        status: "inconsistent";
        reason: "invalid_encryption_mode";
    }>;

export function resolveEffectiveAccountEncryptionModeFromAccountRow(account: Readonly<{
    encryptionMode: unknown;
}>): AccountEncryptionModeResolution {
    if (
        account.encryptionMode !== "plain"
        && account.encryptionMode !== "e2ee"
    ) {
        return {
            status: "inconsistent",
            reason: "invalid_encryption_mode",
        };
    }
    return {
        status: "ready",
        mode: account.encryptionMode,
    };
}

export function isTrulyKeylessPlainAccountRow(
    account: Readonly<{
        publicKey: string | null;
        encryptionMode: string | null;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>,
): boolean {
    const mode =
        resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    return account.publicKey === null
        && account.contentPublicKey === null
        && account.contentPublicKeySig === null
        && mode.status === "ready"
        && mode.mode === "plain";
}
