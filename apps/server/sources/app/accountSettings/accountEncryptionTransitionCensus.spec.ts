import { describe, expect, it, vi } from "vitest";

import { PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX } from "@/app/kv/accountScopedKv";
import type { Tx } from "@/storage/inTx";

import { inspectAccountSettingsForEncryptionTransitionInTx } from "./accountEncryptionTransitionCensus";

function createTx(input: Readonly<{
    account?: null | Readonly<{ id: string }>;
    declarativeSettings?: null | Readonly<{ id: string }>;
    history?: null | Readonly<{ id: string }>;
}> = {}) {
    const tx = {
        account: {
            findUnique: vi.fn(async () => (
                input.account === undefined ? { id: "account-1" } : input.account
            )),
        },
        userKVStore: {
            findFirst: vi.fn(async () => input.declarativeSettings ?? null),
        },
        accountSettingsSnapshot: {
            findFirst: vi.fn(async () => input.history ?? null),
        },
    };
    // Narrow persistence-boundary fixture; this helper only reads these delegates.
    return { tx: tx as unknown as Tx, ...tx };
}

describe("Account Settings encryption-transition census", () => {
    it("preserves account_not_found without reading Settings rows", async () => {
        const fixture = createTx({ account: null });

        await expect(inspectAccountSettingsForEncryptionTransitionInTx(
            fixture.tx,
            "missing-account",
        )).resolves.toEqual({ status: "account_not_found" });

        expect(fixture.userKVStore.findFirst).not.toHaveBeenCalled();
        expect(fixture.accountSettingsSnapshot.findFirst).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "a live plugin declarative Settings envelope",
            declarativeSettings: { id: "kv-1" },
            history: null,
            expected: {
                status: "nonempty",
                declarativeSettings: true,
                history: false,
            },
        },
        {
            name: "a retained Settings history payload",
            declarativeSettings: null,
            history: { id: "history-1" },
            expected: {
                status: "nonempty",
                declarativeSettings: false,
                history: true,
            },
        },
        {
            name: "both Settings stores",
            declarativeSettings: { id: "kv-1" },
            history: { id: "history-1" },
            expected: {
                status: "nonempty",
                declarativeSettings: true,
                history: true,
            },
        },
    ])("fails PEP1 closed for $name", async ({
        declarativeSettings,
        history,
        expected,
    }) => {
        const fixture = createTx({ declarativeSettings, history });

        await expect(inspectAccountSettingsForEncryptionTransitionInTx(
            fixture.tx,
            "account-1",
        )).resolves.toEqual(expected);

        expect(fixture.userKVStore.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                key: { startsWith: PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX },
                value: { not: null },
            },
            select: { id: true },
        });
        expect(fixture.accountSettingsSnapshot.findFirst).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                settingsDbValue: { not: null },
            },
            select: { id: true },
        });
    });

    it("reports empty only after checking both Settings stores", async () => {
        const fixture = createTx();

        await expect(inspectAccountSettingsForEncryptionTransitionInTx(
            fixture.tx,
            "account-1",
        )).resolves.toEqual({ status: "empty" });

        expect(fixture.userKVStore.findFirst).toHaveBeenCalledOnce();
        expect(fixture.accountSettingsSnapshot.findFirst).toHaveBeenCalledOnce();
    });
});
