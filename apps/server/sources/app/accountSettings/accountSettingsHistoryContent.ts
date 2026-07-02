import type { AccountSettingsStoredContentEnvelope } from "@happier-dev/protocol";

import { openPlainAccountSettingsDbValue } from "@/app/encryption/accountSettingsStorage";

export type AccountSettingsSnapshotContentKind = "encrypted" | "plain" | "empty";
export type AccountSettingsSnapshotEncryptionMode = "e2ee" | "plain";

export type AccountSettingsSnapshotStorage = Readonly<{
    accountId: string;
    encryptionMode: string;
    settingsDbValue: string | null;
}>;

export function resolveAccountSettingsSnapshotContentKind(
    snapshot: Pick<AccountSettingsSnapshotStorage, "encryptionMode" | "settingsDbValue">,
): AccountSettingsSnapshotContentKind {
    if (!snapshot.settingsDbValue) return "empty";
    return snapshot.encryptionMode === "plain" ? "plain" : "encrypted";
}

export function accountSettingsSnapshotToContent(
    snapshot: AccountSettingsSnapshotStorage,
): AccountSettingsStoredContentEnvelope | null {
    if (!snapshot.settingsDbValue) return null;
    if (snapshot.encryptionMode === "plain") {
        return openPlainAccountSettingsDbValue({
            accountId: snapshot.accountId,
            dbValue: snapshot.settingsDbValue,
        });
    }
    return { t: "encrypted", c: snapshot.settingsDbValue };
}

export function accountSettingsContentEquals(
    left: AccountSettingsStoredContentEnvelope | null,
    right: AccountSettingsStoredContentEnvelope | null,
): boolean {
    return jsonValueEquals(left, right);
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right) return false;
    if (left === null || right === null) return left === right;
    if (typeof left !== "object" || typeof right !== "object") return false;

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        return left.every((value, index) => jsonValueEquals(value, right[index]));
    }

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (leftKeys.length !== rightKeys.length) return false;

    for (let index = 0; index < leftKeys.length; index += 1) {
        const key = leftKeys[index];
        if (key !== rightKeys[index]) return false;
        if (!jsonValueEquals(leftRecord[key], rightRecord[key])) return false;
    }

    return true;
}
