import { describe, expect, it } from "vitest";

import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "./accountEncryptionMode";

describe("resolveEffectiveAccountEncryptionModeFromAccountRow", () => {
    it.each([
        {
            account: { encryptionMode: "plain", publicKey: null },
            expected: { status: "ready", mode: "plain" },
        },
        {
            account: { encryptionMode: "e2ee", publicKey: null },
            expected: { status: "ready", mode: "e2ee" },
        },
        {
            account: { encryptionMode: "e2ee", publicKey: "account-public-key" },
            expected: { status: "ready", mode: "e2ee" },
        },
    ] as const)(
        "uses persisted encryptionMode=$account.encryptionMode when publicKey=$account.publicKey",
        ({ account, expected }) => {
            expect(resolveEffectiveAccountEncryptionModeFromAccountRow(account)).toEqual(expected);
        },
    );

    it.each([null, "", "future-mode"])(
        "returns a typed inconsistency for unsupported persisted mode %j",
        (encryptionMode) => {
            expect(resolveEffectiveAccountEncryptionModeFromAccountRow({
                encryptionMode,
            })).toEqual({
                status: "inconsistent",
                reason: "invalid_encryption_mode",
            });
        },
    );
});
