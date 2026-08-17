import { describe, expect, it } from "vitest";

import { PlainAccountSettingsStorageUnavailableError } from "@/app/encryption/accountSettingsStorage";

import {
    accountSettingsSnapshotToContent,
    resolveAccountSettingsSnapshotContentKind,
} from "./accountSettingsHistoryContent";

describe("accountSettingsHistoryContent", () => {
    it.each(["future-mode", null])(
        "fails closed before projecting snapshot mode %j",
        (encryptionMode) => {
            const snapshot = {
                accountId: "account-1",
                encryptionMode,
                settingsDbValue: "retained-settings-bytes",
            };

            expect(() => resolveAccountSettingsSnapshotContentKind(snapshot))
                .toThrow(PlainAccountSettingsStorageUnavailableError);
            expect(() => accountSettingsSnapshotToContent(snapshot))
                .toThrow(PlainAccountSettingsStorageUnavailableError);
        },
    );

    it("preserves valid plain, E2EE, and empty projections", () => {
        expect(resolveAccountSettingsSnapshotContentKind({
            encryptionMode: "plain",
            settingsDbValue: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
        })).toBe("plain");
        expect(accountSettingsSnapshotToContent({
            accountId: "account-1",
            encryptionMode: "plain",
            settingsDbValue: JSON.stringify({ t: "plain", v: { schemaVersion: 2 } }),
        })).toEqual({ t: "plain", v: { schemaVersion: 2 } });

        expect(resolveAccountSettingsSnapshotContentKind({
            encryptionMode: "e2ee",
            settingsDbValue: "ciphertext",
        })).toBe("encrypted");
        expect(accountSettingsSnapshotToContent({
            accountId: "account-1",
            encryptionMode: "e2ee",
            settingsDbValue: "ciphertext",
        })).toEqual({ t: "encrypted", c: "ciphertext" });

        expect(resolveAccountSettingsSnapshotContentKind({
            encryptionMode: "plain",
            settingsDbValue: null,
        })).toBe("empty");
        expect(accountSettingsSnapshotToContent({
            accountId: "account-1",
            encryptionMode: "e2ee",
            settingsDbValue: null,
        })).toBeNull();
    });
});
