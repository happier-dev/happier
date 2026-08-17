import type { AccountSettingsStoredContentEnvelope } from "@happier-dev/protocol";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import {
    openPlainAccountSettingsDbValue,
    PlainAccountSettingsStorageUnavailableError,
} from "@/app/encryption/accountSettingsStorage";

export type AccountSettingsSnapshotContentKind = "encrypted" | "plain" | "empty";
export type AccountSettingsSnapshotEncryptionMode = "e2ee" | "plain";

export type AccountSettingsSnapshotStorage = Readonly<{
    accountId: string;
    encryptionMode: unknown;
    settingsDbValue: string | null;
}>;

export function resolveAccountSettingsSnapshotContentKind(
    snapshot: Pick<AccountSettingsSnapshotStorage, "encryptionMode" | "settingsDbValue">,
): AccountSettingsSnapshotContentKind {
    const mode = requireAccountSettingsSnapshotEncryptionMode(snapshot.encryptionMode);
    if (!snapshot.settingsDbValue) return "empty";
    return mode === "plain" ? "plain" : "encrypted";
}

export function accountSettingsSnapshotToContent(
    snapshot: AccountSettingsSnapshotStorage,
): AccountSettingsStoredContentEnvelope | null {
    const mode = requireAccountSettingsSnapshotEncryptionMode(snapshot.encryptionMode);
    if (!snapshot.settingsDbValue) return null;
    if (mode === "plain") {
        return openPlainAccountSettingsDbValue({
            accountId: snapshot.accountId,
            dbValue: snapshot.settingsDbValue,
        });
    }
    return { t: "encrypted", c: snapshot.settingsDbValue };
}

function requireAccountSettingsSnapshotEncryptionMode(
    encryptionMode: unknown,
): AccountSettingsSnapshotEncryptionMode {
    const resolution = resolveEffectiveAccountEncryptionModeFromAccountRow({
        encryptionMode,
    });
    if (resolution.status === "inconsistent") {
        throw new PlainAccountSettingsStorageUnavailableError();
    }
    return resolution.mode;
}
