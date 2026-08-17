import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { shareRoutes } from "./shareRoutes";

let originalSessionShareFindUnique:
    | ((args: Parameters<typeof db.sessionShare.findUnique>[0]) => ReturnType<typeof db.sessionShare.findUnique>)
    | undefined;

function afterQueryResolves<T extends object>(query: T, after: () => Promise<void>): T {
    return new Proxy(query, {
        get(target, property, receiver) {
            if (property !== "then") return Reflect.get(target, property, receiver);

            const then = Reflect.get(target, property, target);
            if (typeof then !== "function") return then;

            return (
                onfulfilled?: (value: unknown) => unknown,
                onrejected?: (reason: unknown) => unknown,
            ) => then.call(
                target,
                async (value: unknown) => {
                    await after();
                    return onfulfilled ? onfulfilled(value) : value;
                },
                onrejected,
            );
        },
    });
}

function replaceSessionShareFindUnique(after: () => Promise<void>): () => void {
    const delegate = db.sessionShare;
    const original = originalSessionShareFindUnique ?? delegate.findUnique.bind(delegate);
    originalSessionShareFindUnique = original;
    Object.defineProperty(delegate, "findUnique", {
        configurable: true,
        writable: true,
        value: (args: Parameters<typeof delegate.findUnique>[0]) => afterQueryResolves(original(args), after),
    });
    return () => {
        Object.defineProperty(delegate, "findUnique", {
            configurable: true,
            writable: true,
            value: original,
        });
    };
}

describe("shareRoutes current authorization (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let restoreSessionShareFindUnique: (() => void) | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-share-routes-current-authorization-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        if (harness) await harness.close();
    });

    afterEach(async () => {
        restoreSessionShareFindUnique?.();
        restoreSessionShareFindUnique = undefined;
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.sessionShare.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createFixture() {
        const owner = await db.account.create({
            data: { publicKey: `share-owner-${crypto.randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const admin = await db.account.create({
            data: { publicKey: `share-admin-${crypto.randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const recipient = await db.account.create({
            data: { publicKey: `share-recipient-${crypto.randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `share-current-authorization-${crypto.randomUUID()}`,
                encryptionMode: "plain",
                metadata: JSON.stringify({}),
                currentStorageState: "hosted",
            },
            select: { id: true },
        });
        const adminShare = await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: admin.id,
                accessLevel: "admin",
                canApprovePermissions: true,
            },
            select: { id: true },
        });
        const recipientShare = await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: recipient.id,
                accessLevel: "edit",
                canApprovePermissions: true,
            },
            select: { id: true },
        });
        return { admin, adminShare, recipientShare, session };
    }

    function revokeAdminAfterFirstPointInTimeLookup(adminShareId: string) {
        restoreSessionShareFindUnique = replaceSessionShareFindUnique(async () => {
            await db.sessionShare.delete({ where: { id: adminShareId } });
        });
    }

    it("does not disclose a roster after the current shared-admin grant is revoked", async () => {
        const fixture = await createFixture();
        revokeAdminAfterFirstPointInTimeLookup(fixture.adminShare.id);

        await withAuthenticatedTestApp(
            (app) => shareRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: `/v1/sessions/${fixture.session.id}/shares`,
                    headers: { "x-test-user-id": fixture.admin.id },
                });

                expect(response.statusCode).toBe(403);
                expect(response.json()).toEqual({ error: "Forbidden" });
            },
        );
    });

    it("does not revoke another participant after the acting shared-admin grant is revoked", async () => {
        const fixture = await createFixture();
        revokeAdminAfterFirstPointInTimeLookup(fixture.adminShare.id);

        await withAuthenticatedTestApp(
            (app) => shareRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "DELETE",
                    url: `/v1/sessions/${fixture.session.id}/shares/${fixture.recipientShare.id}`,
                    headers: { "x-test-user-id": fixture.admin.id },
                });

                expect(response.statusCode).toBe(403);
            },
        );

        await expect(db.sessionShare.findUniqueOrThrow({
            where: { id: fixture.recipientShare.id },
            select: { id: true },
        })).resolves.toEqual({ id: fixture.recipientShare.id });
    });

    it("does not change delegated approval after the actor loses that capability", async () => {
        const fixture = await createFixture();
        let pointInTimeLookups = 0;
        restoreSessionShareFindUnique = replaceSessionShareFindUnique(async () => {
            pointInTimeLookups += 1;
            if (pointInTimeLookups === 3) {
                await db.sessionShare.update({
                    where: { id: fixture.adminShare.id },
                    data: { canApprovePermissions: false },
                });
            }
        });

        await withAuthenticatedTestApp(
            (app) => shareRoutes(app),
            async (app) => {
                const response = await app.inject({
                    method: "PATCH",
                    url: `/v1/sessions/${fixture.session.id}/shares/${fixture.recipientShare.id}`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": fixture.admin.id,
                    },
                    payload: { canApprovePermissions: false },
                });

                expect(response.statusCode).toBe(403);
            },
        );

        await expect(db.sessionShare.findUniqueOrThrow({
            where: { id: fixture.recipientShare.id },
            select: { canApprovePermissions: true },
        })).resolves.toEqual({ canApprovePermissions: true });
    });
});
