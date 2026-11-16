import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

import { decodeStoredText, encodeStoredText } from '@/storage/storedContent';

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
    settingsDbValueBytes?: Uint8Array | null;
}>;

export function resolveAccountSettingsSnapshotContentKind(
    snapshot: Pick<AccountSettingsSnapshotStorage, "encryptionMode" | "settingsDbValue" | "settingsDbValueBytes">,
): AccountSettingsSnapshotContentKind {
    const mode = requireAccountSettingsSnapshotEncryptionMode(snapshot.encryptionMode);
    if (!readAccountSettingsSnapshotDbValue(snapshot)) return "empty";
    return mode === "plain" ? "plain" : "encrypted";
}

export function accountSettingsSnapshotToContent(
    snapshot: AccountSettingsSnapshotStorage,
): AccountSettingsStoredContentEnvelope | null {
    const mode = requireAccountSettingsSnapshotEncryptionMode(snapshot.encryptionMode);
    const settingsDbValue = readAccountSettingsSnapshotDbValue(snapshot);
    if (!settingsDbValue) return null;
    if (mode === "plain") {
        return openPlainAccountSettingsDbValue({
            accountId: snapshot.accountId,
            dbValue: settingsDbValue,
        });
    }
    return { t: "encrypted", c: settingsDbValue };
}

/** Decode the physical representation before applying history semantics. */
export function readAccountSettingsSnapshotDbValue(snapshot: Pick<AccountSettingsSnapshotStorage, "settingsDbValue" | "settingsDbValueBytes">): string | null {
    return decodeStoredText(snapshot.settingsDbValue, snapshot.settingsDbValueBytes);
}

/** Plain Settings keep their existing server-at-rest wrapper; E2EE stays opaque. */
export function encodeAccountSettingsSnapshotDbValue(snapshot: Pick<AccountSettingsSnapshotStorage, "encryptionMode" | "settingsDbValue">) {
    const stored = snapshot.encryptionMode === "e2ee"
        ? encodeStoredText(snapshot.settingsDbValue)
        : { value: snapshot.settingsDbValue, bytes: null };
    return { settingsDbValue: stored.value, settingsDbValueBytes: stored.bytes };
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
