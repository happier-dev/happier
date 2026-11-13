import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCOUNT_ERASURE_HTTP_PATH_V1 } from "@happier-dev/protocol/auth/accountErasure";

import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";
import * as blobFiles from "@/storage/blob/files";
import { registerAccountErasureRoute } from "./registerAccountErasureRoute";

describe("registerAccountErasureRoute", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-erasure-route-",
            initEncrypt: true,
        });
    }, 120_000);
    afterAll(async () => await harness.close());
    afterEach(async () => {
        vi.restoreAllMocks();
        await db.uploadedFile.deleteMany();
        await db.account.deleteMany();
    });

    async function createAccount(id: string, homeRole: "member" | "owner" = "member") {
        return db.account.create({ data: { id, publicKey: null, encryptionMode: "plain", homeRole } });
    }

    async function erase(accountId: string, disconnect: (accountId: string) => void, confirmation = "DELETE") {
        let result: { statusCode: number; body: unknown } | undefined;
        await withAuthenticatedTestApp(app => {
            // Socket eviction is an external transport effect; deletion and its
            // authorization/persistence use their real owners.
            app.decorate("disconnectAccountSockets", disconnect);
            registerAccountErasureRoute(app);
        }, async app => {
            const response = await app.inject({ method: "POST", url: ACCOUNT_ERASURE_HTTP_PATH_V1,
                headers: { "x-test-user-id": accountId }, payload: { confirmation } });
            result = { statusCode: response.statusCode, body: response.json() };
        });
        return result;
    }

    it("deletes only the authenticated Account and disconnects its sockets after deletion", async () => {
        await createAccount("erased");
        await createAccount("survivor");
        const disconnect = vi.fn((accountId: string) => {
            expect(accountId).toBe("erased");
        });

        expect(await erase("erased", disconnect)).toEqual({ statusCode: 200, body: { status: "deleted" } });
        expect(disconnect).toHaveBeenCalledWith("erased");
        expect(await db.account.findUnique({ where: { id: "erased" } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: "survivor" } })).not.toBeNull();
    });

    it("preserves the Account and its sockets when blob deletion fails", async () => {
        await createAccount("blob-owner");
        await db.uploadedFile.create({ data: { accountId: "blob-owner", path: "retained-public-file" } });
        const remove = vi.spyOn(blobFiles, "deletePublicFile").mockRejectedValue(new Error("Storage unavailable"));
        const disconnect = vi.fn();

        expect(await erase("blob-owner", disconnect)).toMatchObject({ statusCode: 500 });
        expect(remove).toHaveBeenCalledWith("retained-public-file");
        expect(await db.account.findUnique({ where: { id: "blob-owner" } })).not.toBeNull();
        expect(disconnect).not.toHaveBeenCalled();
    });

    it("returns an actionable ownership conflict and preserves the last Home owner", async () => {
        await createAccount("last-owner", "owner");
        const disconnect = vi.fn();

        expect(await erase("last-owner", disconnect)).toEqual({
            statusCode: 409, body: { error: "home_owner_transfer_required" },
        });
        expect(await db.account.findUnique({ where: { id: "last-owner" } })).not.toBeNull();
        expect(disconnect).not.toHaveBeenCalled();
    });

    it("rejects malformed confirmation before deleting the Account or disconnecting sockets", async () => {
        await createAccount("malformed");
        const disconnect = vi.fn();

        expect(await erase("malformed", disconnect, "NO")).toEqual({ statusCode: 400, body: { error: "invalid_request" } });
        expect(await db.account.findUnique({ where: { id: "malformed" } })).not.toBeNull();
        expect(disconnect).not.toHaveBeenCalled();
    });
});
