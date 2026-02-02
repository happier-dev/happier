import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

type Cursor = number;

export type CreateArtifactResult =
    | { ok: true; didWrite: true; cursor: Cursor; artifact: ArtifactRow }
    | { ok: true; didWrite: false; artifact: ArtifactRow }
    | { ok: false; error: "invalid-params" | "conflict" | "internal" };

type ArtifactRow = {
    id: string;
    seq: number;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    createdAt: Date;
    updatedAt: Date;
};

export async function createArtifact(params: {
    actorUserId: string;
    artifactId: string;
    header: Uint8Array;
    body: Uint8Array;
    dataEncryptionKey: Uint8Array;
}): Promise<CreateArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";
    const header = params.header instanceof Uint8Array ? params.header : null;
    const body = params.body instanceof Uint8Array ? params.body : null;
    const dataEncryptionKey = params.dataEncryptionKey instanceof Uint8Array ? params.dataEncryptionKey : null;

    if (!actorUserId || !artifactId || !header || !body || !dataEncryptionKey) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => await createArtifactTx(tx, { actorUserId, artifactId, header, body, dataEncryptionKey }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function createArtifactTx(
    tx: Tx,
    params: {
        actorUserId: string;
        artifactId: string;
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
    }
): Promise<CreateArtifactResult> {
    const existing = await tx.artifact.findUnique({
        where: { id: params.artifactId },
        select: {
            id: true,
            accountId: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    if (existing) {
        if (existing.accountId !== params.actorUserId) {
            return { ok: false, error: "conflict" };
        }
        const { accountId: _accountId, ...artifact } = existing;
        return { ok: true, didWrite: false, artifact };
    }

    const created = await tx.artifact.create({
        data: {
            id: params.artifactId,
            accountId: params.actorUserId,
            header: Buffer.from(params.header),
            headerVersion: 1,
            body: Buffer.from(params.body),
            bodyVersion: 1,
            dataEncryptionKey: Buffer.from(params.dataEncryptionKey),
            seq: 0,
        },
        select: {
            id: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            seq: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    const cursor = await markAccountChanged(tx, { accountId: params.actorUserId, kind: "artifact", entityId: params.artifactId });
    return { ok: true, didWrite: true, cursor, artifact: created };
}

export type UpdateArtifactResult =
    | {
        ok: true;
        cursor: Cursor;
        header?: { bytes: Uint8Array; version: number };
        body?: { bytes: Uint8Array; version: number };
      }
    | {
        ok: false;
        error: "invalid-params" | "not-found" | "version-mismatch" | "internal";
        current?: {
            headerVersion: number;
            header: Uint8Array;
            bodyVersion: number;
            body: Uint8Array;
        };
      };

export async function updateArtifact(params: {
    actorUserId: string;
    artifactId: string;
    header?: { bytes: Uint8Array; expectedVersion: number };
    body?: { bytes: Uint8Array; expectedVersion: number };
}): Promise<UpdateArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";
    const header = params.header;
    const body = params.body;

    if (!actorUserId || !artifactId) {
        return { ok: false, error: "invalid-params" };
    }
    if (!header && !body) {
        return { ok: false, error: "invalid-params" };
    }
    if (header && (!(header.bytes instanceof Uint8Array) || typeof header.expectedVersion !== "number")) {
        return { ok: false, error: "invalid-params" };
    }
    if (body && (!(body.bytes instanceof Uint8Array) || typeof body.expectedVersion !== "number")) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => await updateArtifactTx(tx, { actorUserId, artifactId, header, body }));
    } catch {
        return { ok: false, error: "internal" };
    }
}

export async function updateArtifactTx(
    tx: Tx,
    params: {
        actorUserId: string;
        artifactId: string;
        header?: { bytes: Uint8Array; expectedVersion: number };
        body?: { bytes: Uint8Array; expectedVersion: number };
    },
): Promise<UpdateArtifactResult> {
    const current = await tx.artifact.findFirst({
        where: { id: params.artifactId, accountId: params.actorUserId },
        select: { id: true, seq: true, header: true, headerVersion: true, body: true, bodyVersion: true },
    });

    if (!current) {
        return { ok: false, error: "not-found" };
    }

    const headerMismatch = params.header && current.headerVersion !== params.header.expectedVersion;
    const bodyMismatch = params.body && current.bodyVersion !== params.body.expectedVersion;
    if (headerMismatch || bodyMismatch) {
        return {
            ok: false,
            error: "version-mismatch",
            current: {
                headerVersion: current.headerVersion,
                header: current.header,
                bodyVersion: current.bodyVersion,
                body: current.body,
            },
        };
    }

    const updateData: any = {
        updatedAt: new Date(),
        seq: current.seq + 1,
    };

    let headerUpdate: { bytes: Uint8Array; version: number } | undefined;
    let bodyUpdate: { bytes: Uint8Array; version: number } | undefined;

    if (params.header) {
        updateData.header = Buffer.from(params.header.bytes);
        updateData.headerVersion = params.header.expectedVersion + 1;
        headerUpdate = { bytes: params.header.bytes, version: params.header.expectedVersion + 1 };
    }
    if (params.body) {
        updateData.body = Buffer.from(params.body.bytes);
        updateData.bodyVersion = params.body.expectedVersion + 1;
        bodyUpdate = { bytes: params.body.bytes, version: params.body.expectedVersion + 1 };
    }

    const { count } = await tx.artifact.updateMany({
        where: {
            id: params.artifactId,
            accountId: params.actorUserId,
            ...(params.header && { headerVersion: params.header.expectedVersion }),
            ...(params.body && { bodyVersion: params.body.expectedVersion }),
        },
        data: updateData,
    });

    if (count === 0) {
        const fresh = await tx.artifact.findFirst({
            where: { id: params.artifactId, accountId: params.actorUserId },
            select: { header: true, headerVersion: true, body: true, bodyVersion: true },
        });
        if (!fresh) {
            return { ok: false, error: "not-found" };
        }
        return {
            ok: false,
            error: "version-mismatch",
            current: {
                headerVersion: fresh.headerVersion,
                header: fresh.header,
                bodyVersion: fresh.bodyVersion,
                body: fresh.body,
            },
        };
    }

    const cursor = await markAccountChanged(tx, { accountId: params.actorUserId, kind: "artifact", entityId: params.artifactId });
    return { ok: true, cursor, ...(headerUpdate ? { header: headerUpdate } : {}), ...(bodyUpdate ? { body: bodyUpdate } : {}) };
}

export type DeleteArtifactResult =
    | { ok: true; cursor: Cursor }
    | { ok: false; error: "invalid-params" | "not-found" | "internal" };

export async function deleteArtifact(params: { actorUserId: string; artifactId: string }): Promise<DeleteArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";

    if (!actorUserId || !artifactId) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const artifact = await tx.artifact.findFirst({
                where: { id: artifactId, accountId: actorUserId },
                select: { id: true },
            });
            if (!artifact) {
                return { ok: false, error: "not-found" };
            }

            await tx.artifact.delete({ where: { id: artifactId } });
            const cursor = await markAccountChanged(tx, { accountId: actorUserId, kind: "artifact", entityId: artifactId });
            return { ok: true, cursor };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
