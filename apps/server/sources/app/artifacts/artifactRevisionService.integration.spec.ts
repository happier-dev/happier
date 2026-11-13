import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from "@happier-dev/protocol";
import { UpdateContainerSchema } from "@happier-dev/protocol/updates";
import { db } from "@/storage/db";
import { withSqliteReadSnapshot } from "@/storage/prisma";
import { eventRouter } from "@/app/events/eventRouter";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("Artifact revision restore through HTTP and SQLite", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-artifact-restore-",
            initAuth: false, initEncrypt: true, initFiles: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "none" } });
    }, 120_000);
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => await harness.close());

    it("keeps a restored revision committed and notifies recipients when post-commit orphan cleanup fails", async () => {
        // Only the outward event transport is substituted; payload builders and
        // all admission, transaction, content and HTTP owners remain real.
        const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        const originalBody = encodePlainArtifactStoredContent({ body: "original" });
        const currentBody = encodePlainArtifactStoredContent({ body: "current" });
        const header = encodePlainArtifactStoredContent({ title: "History" });
        await db.artifact.create({ data: { id, accountId: owner.id,
            header: Buffer.from(header, "base64"), body: Buffer.from(originalBody, "base64"),
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, "base64"), headerVersion: 1, bodyVersion: 1 } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: id, accountId: recipient.id,
            accessLevel: "view", createdByAccountId: owner.id } });

        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { "x-test-user-id": owner.id };
            const updated = await app.inject({ method: "POST", url: `/v1/artifacts/${id}`, headers,
                payload: { header, body: currentBody, expectedHeaderVersion: 1, expectedBodyVersion: 1 } });
            expect(updated.statusCode, updated.body).toBe(200);
            expect(updated.json()).toEqual({ success: true, headerVersion: 2, bodyVersion: 2 });
            const retained = await db.artifactRevision.findUniqueOrThrow({ where: { artifactId_bodyVersion: { artifactId: id, bodyVersion: 1 } } });
            expect(Array.from(retained.body)).toEqual(Array.from(Buffer.from(originalBody, "base64")));
            emitUpdate.mockClear();

            // Fail only the real database census used by read-only orphan cleanup.
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const original = reader.artifactBlob.findMany.bind(reader.artifactBlob);
            let cleanupFailed = false;
            Object.defineProperty(reader.artifactBlob, "findMany", { configurable: true, writable: true,
                value: async () => { cleanupFailed = true; throw new Error("orphan census unavailable"); } });
            try {
                const restore = (expectedVersion: number) => app.inject({ method: "POST",
                    url: `/v1/artifacts/${id}/revisions/1/restore`, headers,
                    payload: { header, expectedHeaderVersion: expectedVersion, expectedBodyVersion: expectedVersion } });
                const refused = await restore(1);
                expect(refused.statusCode, refused.body).toBe(200);
                expect(refused.json()).toMatchObject({ success: false, error: "version-mismatch",
                    currentHeaderVersion: 2, currentBodyVersion: 2 });
                expect(cleanupFailed).toBe(false);
                expect(emitUpdate).not.toHaveBeenCalled();
                const unchanged = await db.artifact.findUniqueOrThrow({ where: { id } });
                expect(unchanged).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
                expect(Array.from(unchanged.body)).toEqual(Array.from(Buffer.from(currentBody, "base64")));

                const restored = await restore(2);
                expect(cleanupFailed).toBe(true);
                const committed = await db.artifact.findUniqueOrThrow({ where: { id } });
                expect(committed).toMatchObject({ headerVersion: 3, bodyVersion: 3 });
                expect(Array.from(committed.body)).toEqual(Array.from(Buffer.from(originalBody, "base64")));
                expect(restored.statusCode, restored.body).toBe(200);
                expect(restored.json()).toEqual({ success: true, headerVersion: 3, bodyVersion: 3 });
                const updates = emitUpdate.mock.calls.map(([update]) => ({ ...update,
                    payload: UpdateContainerSchema.parse(update.payload) }));
                for (const account of [owner, recipient]) {
                    expect(updates).toContainEqual(expect.objectContaining({ userId: account.id,
                        payload: expect.objectContaining({ body: expect.objectContaining({ t: "update-artifact", artifactId: id,
                            header: { value: header, version: 3 }, body: { value: originalBody, version: 3 } }) }) }));
                }
            } finally {
                Object.defineProperty(reader.artifactBlob, "findMany", { configurable: true, writable: true, value: original });
            }
        });
    });
});
