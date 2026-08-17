import { describe, expect, it } from "vitest";

import {
    accountEncryptionMigrationReplayBindingsEqualV1,
    createAccountEncryptionMigrationReplayBindingV1,
} from "./accountEncryptionMigrationReplayBindingV1";

const ACCOUNT_ID = "account-1";
const PROTOCOL_REQUEST_DIGEST = `aemrb1_${"A".repeat(43)}`;

function createBinding(overrides: Readonly<{
    accountId?: string;
    protocolRequestDigest?: string;
    masterSecret?: string;
}> = {}): string {
    return createAccountEncryptionMigrationReplayBindingV1(
        {
            accountId: overrides.accountId ?? ACCOUNT_ID,
            protocolRequestDigest:
                overrides.protocolRequestDigest
                ?? PROTOCOL_REQUEST_DIGEST,
        },
        {
            HANDY_MASTER_SECRET:
                overrides.masterSecret ?? "server-master-secret",
        },
    );
}

describe("account encryption migration replay binding v1", () => {
    it("is restart-stable for the same account, request digest, and server secret", () => {
        const firstProcessEnv = {
            HANDY_MASTER_SECRET: "restart-stable-secret",
        };
        const restartedProcessEnv = {
            HANDY_MASTER_SECRET: "restart-stable-secret",
        };

        const first = createAccountEncryptionMigrationReplayBindingV1(
            {
                accountId: ACCOUNT_ID,
                protocolRequestDigest: PROTOCOL_REQUEST_DIGEST,
            },
            firstProcessEnv,
        );
        const afterRestart =
            createAccountEncryptionMigrationReplayBindingV1(
                {
                    accountId: ACCOUNT_ID,
                    protocolRequestDigest: PROTOCOL_REQUEST_DIGEST,
                },
                restartedProcessEnv,
            );

        expect(first).toBe(afterRestart);
        expect(first).toBe(
            "aemrsb1_54uytmrABf-RcbBsg8RD0KOcLyZvdgUPNqLz0FQry8g",
        );
        expect(first).toMatch(/^aemrsb1_[A-Za-z0-9_-]{43}$/u);
    });

    it("binds the account, Protocol request digest, and server secret", () => {
        const original = createBinding();

        expect(createBinding({ accountId: "account-2" }))
            .not.toBe(original);
        expect(createBinding({
            protocolRequestDigest: `aemrb1_${"B".repeat(42)}A`,
        })).not.toBe(original);
        expect(createBinding({ masterSecret: "other-master-secret" }))
            .not.toBe(original);
    });

    it.each([
        ["empty account id", ""],
        ["whitespace account id", "   "],
        ["non-canonical account id", " account-1"],
        ["NUL-bearing account id", "account\u0000one"],
    ])("rejects a malformed %s", (_description, accountId) => {
        expect(() => createBinding({ accountId })).toThrow();
    });

    it.each([
        ["empty digest", ""],
        ["wrong tag", `other_${"A".repeat(43)}`],
        ["short payload", `aemrb1_${"A".repeat(42)}`],
        ["long payload", `aemrb1_${"A".repeat(44)}`],
        ["padded payload", `aemrb1_${"A".repeat(42)}=`],
        ["non-base64url payload", `aemrb1_${"A".repeat(42)}+`],
        [
            "non-canonical base64url payload",
            `aemrb1_${"A".repeat(42)}B`,
        ],
    ])("rejects a malformed Protocol request %s", (
        _description,
        protocolRequestDigest,
    ) => {
        expect(() => createBinding({ protocolRequestDigest })).toThrow();
    });

    it.each([
        undefined,
        "",
        "   ",
    ])("fails closed when HANDY_MASTER_SECRET is %j", (
        masterSecret,
    ) => {
        expect(() =>
            createAccountEncryptionMigrationReplayBindingV1(
                {
                    accountId: ACCOUNT_ID,
                    protocolRequestDigest: PROTOCOL_REQUEST_DIGEST,
                },
                { HANDY_MASTER_SECRET: masterSecret },
            ),
        ).toThrow(/HANDY_MASTER_SECRET/u);
    });

    it("compares only strict canonical bindings", () => {
        const original = createBinding();
        const same = createBinding();
        const different = createBinding({ accountId: "account-2" });

        expect(
            accountEncryptionMigrationReplayBindingsEqualV1(
                original,
                same,
            ),
        ).toBe(true);
        expect(
            accountEncryptionMigrationReplayBindingsEqualV1(
                original,
                different,
            ),
        ).toBe(false);
        expect(
            accountEncryptionMigrationReplayBindingsEqualV1(
                original,
                "malformed",
            ),
        ).toBe(false);
        expect(
            accountEncryptionMigrationReplayBindingsEqualV1(
                `aemrsb1_${"A".repeat(42)}=`,
                original,
            ),
        ).toBe(false);
        expect(
            accountEncryptionMigrationReplayBindingsEqualV1(
                `aemrsb1_${"A".repeat(42)}B`,
                original,
            ),
        ).toBe(false);
    });
});
