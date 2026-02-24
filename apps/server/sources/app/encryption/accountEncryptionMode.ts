export type EffectiveAccountEncryptionMode = "plain" | "e2ee";

export function resolveEffectiveAccountEncryptionModeFromAccountRow(account: Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
}>): EffectiveAccountEncryptionMode {
    if (!account.publicKey) return "plain";
    return account.encryptionMode === "plain" ? "plain" : "e2ee";
}

