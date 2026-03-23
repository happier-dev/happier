import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDbMocks, installDbModuleMock } from "../testkit/dbMocks";
import { createInTxHarness } from "../testkit/txHarness";
import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";

const emitUpdate = vi.fn();
const buildNewArtifactUpdate = vi.fn((_artifact: any, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "new-artifact" },
}));
const buildUpdateArtifactUpdate = vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "update-artifact" },
}));
const buildDeleteArtifactUpdate = vi.fn((_artifactId: string, updSeq: number, updId: string) => ({
    id: updId,
    seq: updSeq,
    body: { t: "delete-artifact" },
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate },
    buildNewArtifactUpdate,
    buildUpdateArtifactUpdate,
    buildDeleteArtifactUpdate,
}));

const randomKeyNaked = vi.fn(() => "upd-id");
vi.mock("@/utils/keys/randomKeyNaked", () => ({ randomKeyNaked }));

const markAccountChanged = vi.fn(async () => 555);
vi.mock("@/app/changes/markAccountChanged", () => ({ markAccountChanged }));

vi.mock("@/app/monitoring/metrics2", () => ({
    websocketEventsCounter: { inc: vi.fn() },
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

const txDbMocks = createDbMocks({
    artifact: ["findFirst", "findUnique", "updateMany", "create", "delete"],
} as const);

vi.mock("@/storage/inTx", () => {
    const { inTx, afterTx } = createInTxHarness(() => ({
            artifact: txDbMocks.db.artifact,
    }));

    return { afterTx, inTx };
});

const dbMocks = createDbMocks({
    artifact: ["findUnique"],
} as const);
const dbArtifactFindUnique = dbMocks.db.artifact.findUnique;
installDbModuleMock(() => ({
    db: dbMocks.db,
}));

describe("artifactUpdateHandler (AccountChange integration)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        txDbMocks.reset();

        dbArtifactFindUnique.mockResolvedValue(null);
    });

    it("marks artifact update and emits update using returned cursor", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({
            id: "a1",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 2,
            dataEncryptionKey: Buffer.from("k"),
            seq: 7,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });
        txDbMocks.db.artifact.updateMany.mockResolvedValue({ count: 1 });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket();
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-update");

        const callback = vi.fn();
        await handler(
            {
                artifactId: "a1",
                header: { data: "aGVsbG8=", expectedVersion: 1 },
                body: { data: "d29ybGQ=", expectedVersion: 2 },
            },
            callback,
        );

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a1" }),
        );
        expect(buildUpdateArtifactUpdate).toHaveBeenCalledWith(
            "a1",
            555,
            expect.any(String),
            { value: "aGVsbG8=", version: 2 },
            { value: "d29ybGQ=", version: 3 },
        );
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                header: { version: 2, data: "aGVsbG8=" },
                body: { version: 3, data: "d29ybGQ=" },
            }),
        );
    });

    it("marks artifact create and emits new-artifact using returned cursor", async () => {
        txDbMocks.db.artifact.findUnique.mockResolvedValue(null);
        txDbMocks.db.artifact.create.mockResolvedValue({
            id: "a2",
            accountId: "u1",
            header: Buffer.from("h"),
            headerVersion: 1,
            body: Buffer.from("b"),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from("k"),
            seq: 0,
            createdAt: new Date(1),
            updatedAt: new Date(1),
        });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket();
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-create");

        const callback = vi.fn();
        await handler({ id: "a2", header: "aGVhZA==", body: "Ym9keQ==", dataEncryptionKey: "a2V5" }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a2" }),
        );
        expect(buildNewArtifactUpdate).toHaveBeenCalledWith(expect.anything(), 555, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                result: "success",
                artifact: expect.objectContaining({ id: "a2", headerVersion: 1, bodyVersion: 1 }),
            }),
        );
    });

    it("marks artifact delete and emits delete-artifact using returned cursor", async () => {
        txDbMocks.db.artifact.findFirst.mockResolvedValue({ id: "a3" });
        txDbMocks.db.artifact.delete.mockResolvedValue({ id: "a3" });

        const { artifactUpdateHandler } = await import("./artifactUpdateHandler");

        const socket = createFakeSocket();
        artifactUpdateHandler("u1", socket as any);
        const handler = getSocketHandler(socket, "artifact-delete");

        const callback = vi.fn();
        await handler({ artifactId: "a3" }, callback);

        expect(markAccountChanged).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ accountId: "u1", kind: "artifact", entityId: "a3" }),
        );
        expect(buildDeleteArtifactUpdate).toHaveBeenCalledWith("a3", 555, expect.any(String));
        expect(emitUpdate).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ result: "success" });
    });
});
