import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { readAccountDirectoryMe } from "./accountDirectoryService";

describe("Account Directory identity visibility (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-directory-identity-",
            initAuth: false,
        });
        await auth.init();
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        vi.unstubAllGlobals();
        await harness.resetDbTables([
            () => db.accountPasswordCredential.deleteMany(),
            () => db.accountIdentity.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("omits the native email login locator and reports each other identity by its handle", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-directory-native-identity" },
            select: { id: true },
        });
        await db.accountIdentity.createMany({
            data: [
                {
                    accountId: account.id,
                    provider: "email",
                    providerUserId: "owner@example.test",
                    providerLogin: "owner@example.test",
                    profile: {},
                    showOnProfile: false,
                },
                {
                    accountId: account.id,
                    provider: "github",
                    providerUserId: "123",
                    providerLogin: "octocat",
                    profile: {},
                    showOnProfile: true,
                },
                {
                    accountId: account.id,
                    provider: "mtls",
                    providerUserId: "certificate-subject",
                    providerLogin: null,
                    profile: {},
                    showOnProfile: false,
                },
            ],
        });

        const result = await readAccountDirectoryMe(account.id);

        // `login` is the handle people know the identity by, never the provider's opaque user id.
        expect(result.linkedAuthenticationMethods).toEqual([
            { providerId: "github", login: "octocat" },
            { providerId: "mtls", login: null },
        ]);
    });

    it("says how the account's recovery key can be reached, from its stored mode, without naming the login email", async () => {
        const plain = await db.account.create({ data: { encryptionMode: "plain", publicKey: null }, select: { id: true } });
        const keyOnly = await db.account.create({ data: { encryptionMode: "e2ee", publicKey: "pk-key-only" }, select: { id: true } });
        const withPassword = await db.account.create({ data: { encryptionMode: "e2ee", publicKey: "pk-password" }, select: { id: true } });
        await db.accountPasswordCredential.create({ data: {
            accountId: withPassword.id,
            credential: { v: 1, kind: "e2ee_password_envelope", envelope: {}, authVerifier: { v: 1, hash: "h" } },
        } });

        // Plain Accounts have no key; an E2EE key is reachable through the password only when one exists.
        const plainDirectory = await readAccountDirectoryMe(plain.id);
        expect(plainDirectory.recoveryKey).toBe("none");
        expect(plainDirectory.encryptionMode).toBe("plain");
        const keyOnlyDirectory = await readAccountDirectoryMe(keyOnly.id);
        expect(keyOnlyDirectory.recoveryKey).toBe("key_only");
        expect(keyOnlyDirectory.encryptionMode).toBe("e2ee");
        const reachable = await readAccountDirectoryMe(withPassword.id);
        expect(reachable.recoveryKey).toBe("password_unlock");
        expect(reachable.encryptionMode).toBe("e2ee");
        expect(JSON.stringify(reachable)).not.toContain("@");
    });
});
