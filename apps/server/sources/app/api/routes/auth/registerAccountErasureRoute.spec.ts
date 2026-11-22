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
        await db.deployment.deleteMany();
        await db.deploymentTargetLink.deleteMany();
        await db.deploymentEnvironment.deleteMany();
        await db.projectSource.deleteMany();
        await db.artifact.deleteMany();
        await db.machine.deleteMany();
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

    it("keeps sockets connected while public-file cleanup remains pending", async () => {
        await createAccount("blob-owner");
        await db.uploadedFile.create({ data: { accountId: "blob-owner", path: "retained-public-file" } });
        const remove = vi.spyOn(blobFiles, "deletePublicFile").mockRejectedValue(new Error("Storage unavailable"));
        const disconnect = vi.fn();

        expect(await erase("blob-owner", disconnect)).toEqual({ statusCode: 200, body: { status: "disabled_pending_completion" } });
        expect(remove).toHaveBeenCalledWith("retained-public-file");
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

    it("returns the owned provider target that blocks cleanup", async () => {
        const account = await createAccount("provider-owner");
        const machine = await db.machine.create({ data: { id: "controller", accountId: account.id, metadata: "{}" } });
        const source = await db.projectSource.create({ data: {
            createdByAccountId: account.id, name: "Deploy", audience: [], attachments: [],
        } });
        const artifact = await db.artifact.create({ data: { id: "definition", accountId: account.id, header: new Uint8Array(),
            body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.id, createdByAccountId: account.id, controllerMachineId: machine.id, protection: "production",
            purpose: "standard", deployerMode: "managers", ...content,
        } });
        const target = await db.deploymentTargetLink.create({ data: {
            environmentId: environment.id, createdByAccountId: account.id, role: "runtime", sourceKind: "plugin",
            pluginId: "happier.deploy.vercel", contributionLocalId: "runtime", targetKind: "vercel", state: "deployed", ...content,
        } });
        const disconnect = vi.fn();
        expect(await erase(account.id, disconnect)).toEqual({ statusCode: 409, body: {
            error: "account_erasure_deployment_cleanup_required", blocker: {
                reason: "provider_resource", environmentId: environment.id, targetLinkId: target.id, targetKind: "vercel",
            },
        } });
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
