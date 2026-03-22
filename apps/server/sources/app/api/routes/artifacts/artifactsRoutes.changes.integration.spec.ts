import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { artifactsRoutes } from "./artifactsRoutes";

const { emitUpdate, buildNewArtifactUpdate, buildUpdateArtifactUpdate, buildDeleteArtifactUpdate, randomKeyNaked, markAccountChanged } =
    vi.hoisted(() => ({
        emitUpdate: vi.fn(),
        buildNewArtifactUpdate: vi.fn((_artifact: any, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "new-artifact" },
        })),
        buildUpdateArtifactUpdate: vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "update-artifact" },
        })),
        buildDeleteArtifactUpdate: vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
            id: updId,
            seq: updSeq,
            body: { t: "delete-artifact" },
        })),
        randomKeyNaked: vi.fn(() => "upd-id"),
        markAccountChanged: vi.fn(async () => 700),
    }));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewArtifactUpdate,
    buildUpdateArtifactUpdate,
    buildDeleteArtifactUpdate,
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));
vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("artifactsRoutes (AccountChange integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-artifacts-changes-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.artifact.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedAccount() {
        return await db.account.create({
            data: { publicKey: "pk-artifacts" },
            select: { id: true },
        });
    }

    it("marks artifact create and emits new-artifact using returned cursor", async () => {
        const account = await seedAccount();
        const artifactId = "11111111-1111-4111-8111-111111111111";

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v1/artifacts",
                    headers: { "x-test-user-id": account.id, "content-type": "application/json" },
                    payload: {
                        id: artifactId,
                        header: Buffer.from("head").toString("base64"),
                        body: Buffer.from("body").toString("base64"),
                        dataEncryptionKey: Buffer.from("key").toString("base64"),
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual(
                    expect.objectContaining({
                        id: artifactId,
                        headerVersion: 1,
                        bodyVersion: 1,
                    }),
                );
            },
        );

        const stored = await db.artifact.findUnique({
            where: { id: artifactId },
            select: { accountId: true, headerVersion: true, bodyVersion: true },
        });
        expect(stored).toEqual({
            accountId: account.id,
            headerVersion: 1,
            bodyVersion: 1,
        });
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "artifact", entityId: artifactId }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 700,
                    body: expect.objectContaining({ t: "new-artifact" }),
                }),
            }),
        );
    });

    it("marks artifact update and emits update-artifact using returned cursor", async () => {
        const account = await seedAccount();
        const artifactId = "22222222-2222-4222-8222-222222222222";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from("head-old"),
                headerVersion: 1,
                body: Buffer.from("body-old"),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from("key"),
                seq: 7,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: { "x-test-user-id": account.id, "content-type": "application/json" },
                    payload: {
                        header: Buffer.from("head-new").toString("base64"),
                        expectedHeaderVersion: 1,
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true, headerVersion: 2 });
            },
        );

        const stored = await db.artifact.findUnique({
            where: { id: artifactId },
            select: { header: true, headerVersion: true, seq: true },
        });
        expect(stored?.headerVersion).toBe(2);
        expect(stored?.seq).toBe(8);
        expect(stored?.header).toEqual(Uint8Array.from(Buffer.from("head-new")));
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "artifact", entityId: artifactId }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 700,
                    body: expect.objectContaining({ t: "update-artifact" }),
                }),
            }),
        );
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        const account = await seedAccount();
        const artifactId = "33333333-3333-4333-8333-333333333333";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: Buffer.from("head"),
                headerVersion: 1,
                body: Buffer.from("body"),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from("key"),
                seq: 3,
            },
        });

        await withAuthenticatedTestApp(
            (app) => artifactsRoutes(app as any),
            async (app) => {
                const res = await app.inject({
                    method: "DELETE",
                    url: `/v1/artifacts/${artifactId}`,
                    headers: { "x-test-user-id": account.id },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toEqual({ success: true });
            },
        );

        const stored = await db.artifact.findUnique({
            where: { id: artifactId },
            select: { id: true },
        });
        expect(stored).toBeNull();
        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: account.id, kind: "artifact", entityId: artifactId }),
        );
        expect(emitUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    seq: 700,
                    body: expect.objectContaining({ t: "delete-artifact" }),
                }),
            }),
        );
    });
});
