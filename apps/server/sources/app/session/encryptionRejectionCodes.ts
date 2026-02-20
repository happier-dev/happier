export type EncryptionPolicyRejectionCode =
    | "session_encryption_mode_mismatch"
    | "storage_policy_requires_e2ee"
    | "storage_policy_requires_plaintext";

export function resolveEncryptionWriteRejectionCode(params: Readonly<{
    storagePolicy: string;
    sessionEncryptionMode: "e2ee" | "plain";
    writeKind: "encrypted" | "plain";
}>): EncryptionPolicyRejectionCode {
    if (params.storagePolicy === "required_e2ee") return "storage_policy_requires_e2ee";
    if (params.storagePolicy === "plaintext_only") return "storage_policy_requires_plaintext";
    return "session_encryption_mode_mismatch";
}

export function resolveRequestedSessionModeRejectionCode(params: Readonly<{
    storagePolicy: string;
}>): EncryptionPolicyRejectionCode {
    if (params.storagePolicy === "plaintext_only") return "storage_policy_requires_plaintext";
    return "storage_policy_requires_e2ee";
}

