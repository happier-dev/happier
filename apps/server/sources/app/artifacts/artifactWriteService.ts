import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    deriveAccountEncryptionCurrentnessFromRow,
} from "@/app/encryption/accountContentKeyAdmission";
import type {
    AccountEncryptionMigrateArtifactsDirective,
} from "@happier-dev/protocol";
import { buildPluginDomainAccountChangeEntityId } from "@happier-dev/protocol/changes";
import {
    artifactStoredContentMatchesAccountMode,
    artifactUpdateMatchesStoredMode,
    isPlainArtifactDataKeyBytes,
    openArtifactStoredContentPair,
    storePlainArtifactDbBytes,
} from "./artifactStoredContent";
import {
    artifactClassificationFromRelations,
    artifactOrdinaryWhere,
} from "./artifactClassification";

type Cursor = number;

export class ArtifactAccountEncryptionMigrationConflictError extends Error {
    constructor() {
        super("Artifact account-encryption migration lost its version precondition");
        this.name = "ArtifactAccountEncryptionMigrationConflictError";
    }
}

export type ArtifactAccountEncryptionMigrationResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type ArtifactAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>
    | Readonly<{ status: "migration_incomplete" }>;

type ArtifactAccountEncryptionMigrationRow = Readonly<{
    id: string;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    seq: number;
    pluginUiArtifact: Readonly<{
        release: Readonly<{
            accountId: string;
            pluginId: string;
        }>;
    }> | null;
    packageAssetRelease: Readonly<{
        accountId: string;
        pluginId: string;
    }> | null;
}>;

async function readArtifactAccountEncryptionMigrationRowsInTx(
    tx: Tx,
    accountId: string,
): Promise<readonly ArtifactAccountEncryptionMigrationRow[]> {
    return await tx.artifact.findMany({
        where: { accountId },
        select: {
            id: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
            seq: true,
            pluginUiArtifact: {
                select: {
                    release: {
                        select: {
                            accountId: true,
                            pluginId: true,
                        },
                    },
                },
            },
            packageAssetRelease: {
                select: {
                    accountId: true,
                    pluginId: true,
                },
            },
        },
    });
}

function artifactBytesEqual(
    left: Uint8Array,
    right: Uint8Array,
): boolean {
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

/**
 * Read-only exact Artifact post-state matcher for Account-transition replay.
 */
export async function matchArtifactAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateArtifactsDirective;
    }>,
): Promise<ArtifactAccountEncryptionMigrationPostStateResult> {
    const rows =
        await readArtifactAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (rows.some((row) => artifactClassificationFromRelations({
        pluginUiArtifact: row.pluginUiArtifact,
        packageAssetRelease: row.packageAssetRelease,
    }, params.accountId).kind === "invalid")) {
        // Classification links must remain one Account-local plugin owner.
        // Do not reinterpret corruption as an ordinary Artifact.
        return { status: "migration_incomplete" };
    }
    if (params.directive.action === "assert_empty") {
        return {
            status: rows.length === 0
                ? "matched"
                : "mismatch",
        };
    }
    const itemsById = new Map(
        params.directive.items.map((item) => [
            item.artifactId,
            item,
        ] as const),
    );
    if (
        itemsById.size !== params.directive.items.length
        || itemsById.size !== rows.length
    ) {
        return { status: "mismatch" };
    }
    for (const row of rows) {
        const item = itemsById.get(row.id);
        if (!item) return { status: "mismatch" };
        const expectedHeader =
            new Uint8Array(Buffer.from(item.header, "base64"));
        const expectedBody =
            new Uint8Array(Buffer.from(item.body, "base64"));
        const expectedDataEncryptionKey =
            new Uint8Array(
                Buffer.from(item.dataEncryptionKey, "base64"),
            );
        const opened = openArtifactStoredContentPair({
            accountId: params.accountId,
            artifactId: row.id,
            dataEncryptionKey: row.dataEncryptionKey,
            header: row.header,
            body: row.body,
        });
        if (
            !opened
            || row.headerVersion
                !== item.expectedHeaderVersion + 1
            || row.bodyVersion
                !== item.expectedBodyVersion + 1
            || !artifactBytesEqual(
                opened.header,
                expectedHeader,
            )
            || !artifactBytesEqual(
                opened.body,
                expectedBody,
            )
            || !artifactBytesEqual(
                row.dataEncryptionKey,
                expectedDataEncryptionKey,
            )
            || !artifactStoredContentMatchesAccountMode({
                mode: params.toMode,
                header: opened.header,
                body: opened.body,
                dataEncryptionKey: row.dataEncryptionKey,
            })
        ) {
            return { status: "mismatch" };
        }
    }
    return { status: "matched" };
}

export async function migrateArtifactAccountEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    toMode: "plain" | "e2ee";
    directive: AccountEncryptionMigrateArtifactsDirective;
    markChanged?: (artifactId: string) => Promise<unknown>;
}>): Promise<ArtifactAccountEncryptionMigrationResult> {
    const rows =
        await readArtifactAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (rows.some((row) => artifactClassificationFromRelations({
        pluginUiArtifact: row.pluginUiArtifact,
        packageAssetRelease: row.packageAssetRelease,
    }, params.accountId).kind === "invalid")) {
        return { status: "migration_incomplete" };
    }
    if (params.directive.action === "assert_empty") {
        return rows.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }

    const itemsById = new Map(
        params.directive.items.map((item) => [item.artifactId, item]),
    );
    if (
        itemsById.size !== params.directive.items.length
        || itemsById.size !== rows.length
    ) {
        return { status: "migration_incomplete" };
    }

    const prepared = new Map<string, Readonly<{
        header: Uint8Array;
        body: Uint8Array;
        dataEncryptionKey: Uint8Array;
        seq: number;
    }>>();
    for (const row of rows) {
        const item = itemsById.get(row.id);
        if (
            !item
            || item.expectedHeaderVersion !== row.headerVersion
            || item.expectedBodyVersion !== row.bodyVersion
        ) {
            return { status: "migration_incomplete" };
        }
        const header = new Uint8Array(Buffer.from(item.header, "base64"));
        const body = new Uint8Array(Buffer.from(item.body, "base64"));
        const dataEncryptionKey = new Uint8Array(
            Buffer.from(item.dataEncryptionKey, "base64"),
        );
        if (!artifactStoredContentMatchesAccountMode({
            mode: params.toMode,
            header,
            body,
            dataEncryptionKey,
        })) {
            return { status: "invalid_content" };
        }
        const storedHeader =
            params.toMode === "plain"
                ? storePlainArtifactDbBytes({
                    accountId: params.accountId,
                    artifactId: row.id,
                    field: "header",
                    content: header,
                })
                : header;
        const storedBody =
            params.toMode === "plain"
                ? storePlainArtifactDbBytes({
                    accountId: params.accountId,
                    artifactId: row.id,
                    field: "body",
                    content: body,
                })
                : body;
        if (!storedHeader || !storedBody) {
            return { status: "invalid_content" };
        }
        prepared.set(row.id, {
            header: storedHeader,
            body: storedBody,
            dataEncryptionKey,
            seq: row.seq,
        });
    }

    const pluginIdByArtifactId = new Map(
        rows.flatMap((row) => {
            const classification = artifactClassificationFromRelations({
                pluginUiArtifact: row.pluginUiArtifact,
                packageAssetRelease: row.packageAssetRelease,
            }, params.accountId);
            return classification.kind === "plugin"
                ? [[row.id, classification.pluginId] as const]
                : [];
        }),
    );
    const markChanged =
        params.markChanged
        ?? (async (artifactId: string) => {
            const pluginId = pluginIdByArtifactId.get(artifactId);
            if (pluginId) {
                const hint = {
                    pluginDomain: "availability" as const,
                    pluginId,
                };
                return await markAccountChanged(params.tx, {
                    accountId: params.accountId,
                    kind: "pluginDomain",
                    entityId: buildPluginDomainAccountChangeEntityId(hint),
                    hint,
                });
            }
            return await markAccountChanged(params.tx, {
                accountId: params.accountId,
                kind: "artifact",
                entityId: artifactId,
            });
        });
    for (const item of params.directive.items) {
        const replacement = prepared.get(item.artifactId)!;
        const updated = await params.tx.artifact.updateMany({
            where: {
                accountId: params.accountId,
                id: item.artifactId,
                headerVersion: item.expectedHeaderVersion,
                bodyVersion: item.expectedBodyVersion,
            },
            data: {
                header: Buffer.from(replacement.header),
                headerVersion: item.expectedHeaderVersion + 1,
                body: Buffer.from(replacement.body),
                bodyVersion: item.expectedBodyVersion + 1,
                dataEncryptionKey: Buffer.from(
                    replacement.dataEncryptionKey,
                ),
                seq: replacement.seq + 1,
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new ArtifactAccountEncryptionMigrationConflictError();
        }
        await markChanged(item.artifactId);
    }
    return { status: "applied" };
}

export type CreateArtifactResult =
    | { ok: true; didWrite: true; cursor: Cursor; artifact: ArtifactRow }
    | { ok: true; didWrite: false; artifact: ArtifactRow }
    | {
        ok: false;
        error:
            | "invalid-params"
            | "conflict"
            | "client-upgrade-required"
            | "internal";
      };

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
    supportsCurrentStoredContentProtocol?: boolean;
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
        return await inTx(async (tx) => await createArtifactTx(tx, {
            actorUserId,
            artifactId,
            header,
            body,
            dataEncryptionKey,
            supportsCurrentStoredContentProtocol:
                params.supportsCurrentStoredContentProtocol === true,
        }));
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
        supportsCurrentStoredContentProtocol?: boolean;
        /**
         * A qualified owner may replace the generic Artifact invalidation only
         * while composing its classification in this same transaction.
         */
        markChanged?: (artifactId: string) => Promise<Cursor>;
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
            pluginUiArtifact: {
                select: {
                    release: {
                        select: {
                            accountId: true,
                            pluginId: true,
                        },
                    },
                },
            },
            packageAssetRelease: {
                select: {
                    accountId: true,
                    pluginId: true,
                },
            },
        },
    });

    if (existing) {
        if (
            existing.accountId !== params.actorUserId
            || artifactClassificationFromRelations({
                pluginUiArtifact: existing.pluginUiArtifact,
                packageAssetRelease: existing.packageAssetRelease,
            }, params.actorUserId).kind !== "ordinary"
        ) {
            return { ok: false, error: "conflict" };
        }
        if (
            isPlainArtifactDataKeyBytes(existing.dataEncryptionKey)
            && params.supportsCurrentStoredContentProtocol !== true
        ) {
            return {
                ok: false,
                error: "client-upgrade-required",
            };
        }
        const opened = openArtifactStoredContentPair({
            accountId: existing.accountId,
            artifactId: existing.id,
            dataEncryptionKey: existing.dataEncryptionKey,
            header: existing.header,
            body: existing.body,
        });
        if (!opened) {
            return { ok: false, error: "internal" };
        }
        const {
            accountId: _accountId,
            pluginUiArtifact: _pluginUiArtifact,
            packageAssetRelease: _packageAssetRelease,
            ...artifact
        } = existing;
        return {
            ok: true,
            didWrite: false,
            artifact: {
                ...artifact,
                header: opened.header,
                body: opened.body,
            },
        };
    }

    if (
        isPlainArtifactDataKeyBytes(params.dataEncryptionKey)
        && params.supportsCurrentStoredContentProtocol !== true
    ) {
        return {
            ok: false,
            error: "client-upgrade-required",
        };
    }

    const account = await tx.account.findUnique({
        where: { id: params.actorUserId },
        select: {
            encryptionMode: true,
            publicKey: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (
        currentness?.status !== "ready"
        || !artifactStoredContentMatchesAccountMode({
        mode: currentness.currentness.encryptionMode,
        header: params.header,
        body: params.body,
        dataEncryptionKey: params.dataEncryptionKey,
    })
    ) {
        return { ok: false, error: "invalid-params" };
    }

    const plain = isPlainArtifactDataKeyBytes(params.dataEncryptionKey);
    const storedHeader = plain
        ? storePlainArtifactDbBytes({
            accountId: params.actorUserId,
            artifactId: params.artifactId,
            field: "header",
            content: params.header,
        })
        : params.header;
    const storedBody = plain
        ? storePlainArtifactDbBytes({
            accountId: params.actorUserId,
            artifactId: params.artifactId,
            field: "body",
            content: params.body,
        })
        : params.body;
    if (!storedHeader || !storedBody) {
        return { ok: false, error: "internal" };
    }

    const created = await tx.artifact.create({
        data: {
            id: params.artifactId,
            accountId: params.actorUserId,
            header: Buffer.from(storedHeader),
            headerVersion: 1,
            body: Buffer.from(storedBody),
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

    const cursor = await (
        params.markChanged
        ?? (async (artifactId: string) =>
            await markAccountChanged(tx, {
                accountId: params.actorUserId,
                kind: "artifact",
                entityId: artifactId,
            }))
    )(params.artifactId);
    return {
        ok: true,
        didWrite: true,
        cursor,
        artifact: {
            ...created,
            header: params.header,
            body: params.body,
        },
    };
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
        error:
            | "invalid-params"
            | "not-found"
            | "version-mismatch"
            | "client-upgrade-required"
            | "internal";
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
    supportsCurrentStoredContentProtocol?: boolean;
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
        return await inTx(async (tx) => await updateArtifactTx(tx, {
            actorUserId,
            artifactId,
            header,
            body,
            supportsCurrentStoredContentProtocol:
                params.supportsCurrentStoredContentProtocol === true,
        }));
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
        supportsCurrentStoredContentProtocol?: boolean;
    },
): Promise<UpdateArtifactResult> {
    const current = await tx.artifact.findFirst({
        where: {
            id: params.artifactId,
            accountId: params.actorUserId,
            ...artifactOrdinaryWhere,
        },
        select: {
            id: true,
            seq: true,
            header: true,
            headerVersion: true,
            body: true,
            bodyVersion: true,
            dataEncryptionKey: true,
        },
    });

    if (!current) {
        return { ok: false, error: "not-found" };
    }
    if (
        isPlainArtifactDataKeyBytes(current.dataEncryptionKey)
        && params.supportsCurrentStoredContentProtocol !== true
    ) {
        return {
            ok: false,
            error: "client-upgrade-required",
        };
    }
    if (!artifactUpdateMatchesStoredMode({
        dataEncryptionKey: current.dataEncryptionKey,
        ...(params.header ? { header: params.header.bytes } : {}),
        ...(params.body ? { body: params.body.bytes } : {}),
    })) {
        return { ok: false, error: "invalid-params" };
    }
    const openedCurrent = openArtifactStoredContentPair({
        accountId: params.actorUserId,
        artifactId: current.id,
        dataEncryptionKey: current.dataEncryptionKey,
        header: current.header,
        body: current.body,
    });
    if (!openedCurrent) {
        return { ok: false, error: "internal" };
    }

    const headerMismatch = params.header && current.headerVersion !== params.header.expectedVersion;
    const bodyMismatch = params.body && current.bodyVersion !== params.body.expectedVersion;
    if (headerMismatch || bodyMismatch) {
        return {
            ok: false,
            error: "version-mismatch",
            current: {
                headerVersion: current.headerVersion,
                header: openedCurrent.header,
                bodyVersion: current.bodyVersion,
                body: openedCurrent.body,
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
        const storedHeader = isPlainArtifactDataKeyBytes(current.dataEncryptionKey)
            ? storePlainArtifactDbBytes({
                accountId: params.actorUserId,
                artifactId: current.id,
                field: "header",
                content: params.header.bytes,
            })
            : params.header.bytes;
        if (!storedHeader) return { ok: false, error: "internal" };
        updateData.header = Buffer.from(storedHeader);
        updateData.headerVersion = params.header.expectedVersion + 1;
        headerUpdate = { bytes: params.header.bytes, version: params.header.expectedVersion + 1 };
    }
    if (params.body) {
        const storedBody = isPlainArtifactDataKeyBytes(current.dataEncryptionKey)
            ? storePlainArtifactDbBytes({
                accountId: params.actorUserId,
                artifactId: current.id,
                field: "body",
                content: params.body.bytes,
            })
            : params.body.bytes;
        if (!storedBody) return { ok: false, error: "internal" };
        updateData.body = Buffer.from(storedBody);
        updateData.bodyVersion = params.body.expectedVersion + 1;
        bodyUpdate = { bytes: params.body.bytes, version: params.body.expectedVersion + 1 };
    }

    const { count } = await tx.artifact.updateMany({
        where: {
            id: params.artifactId,
            accountId: params.actorUserId,
            ...(params.header && { headerVersion: params.header.expectedVersion }),
            ...(params.body && { bodyVersion: params.body.expectedVersion }),
            ...artifactOrdinaryWhere,
        },
        data: updateData,
    });

    if (count === 0) {
        const fresh = await tx.artifact.findFirst({
            where: {
                id: params.artifactId,
                accountId: params.actorUserId,
                ...artifactOrdinaryWhere,
            },
            select: {
                id: true,
                header: true,
                headerVersion: true,
                body: true,
                bodyVersion: true,
                dataEncryptionKey: true,
            },
        });
        if (!fresh) {
            return { ok: false, error: "not-found" };
        }
        if (
            isPlainArtifactDataKeyBytes(fresh.dataEncryptionKey)
            && params.supportsCurrentStoredContentProtocol !== true
        ) {
            return {
                ok: false,
                error: "client-upgrade-required",
            };
        }
        const openedFresh = openArtifactStoredContentPair({
            accountId: params.actorUserId,
            artifactId: fresh.id,
            dataEncryptionKey: fresh.dataEncryptionKey,
            header: fresh.header,
            body: fresh.body,
        });
        if (!openedFresh) {
            return { ok: false, error: "internal" };
        }
        return {
            ok: false,
            error: "version-mismatch",
            current: {
                headerVersion: fresh.headerVersion,
                header: openedFresh.header,
                bodyVersion: fresh.bodyVersion,
                body: openedFresh.body,
            },
        };
    }

    const cursor = await markAccountChanged(tx, { accountId: params.actorUserId, kind: "artifact", entityId: params.artifactId });
    return { ok: true, cursor, ...(headerUpdate ? { header: headerUpdate } : {}), ...(bodyUpdate ? { body: bodyUpdate } : {}) };
}

export type DeleteArtifactResult =
    | { ok: true; cursor: Cursor }
    | {
        ok: false;
        error:
            | "invalid-params"
            | "not-found"
            | "client-upgrade-required"
            | "internal";
      };

export async function deleteArtifact(params: {
    actorUserId: string;
    artifactId: string;
    supportsCurrentStoredContentProtocol?: boolean;
}): Promise<DeleteArtifactResult> {
    const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : "";
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : "";
    const supportsCurrentStoredContentProtocol =
        params.supportsCurrentStoredContentProtocol === true;

    if (!actorUserId || !artifactId) {
        return { ok: false, error: "invalid-params" };
    }

    try {
        return await inTx(async (tx) => {
            const artifact = await tx.artifact.findFirst({
                where: {
                    id: artifactId,
                    accountId: actorUserId,
                    ...artifactOrdinaryWhere,
                },
                select: {
                    id: true,
                    dataEncryptionKey: true,
                },
            });
            if (!artifact) {
                return { ok: false, error: "not-found" };
            }
            if (
                isPlainArtifactDataKeyBytes(artifact.dataEncryptionKey)
                && !supportsCurrentStoredContentProtocol
            ) {
                return {
                    ok: false,
                    error: "client-upgrade-required",
                };
            }

            const cursor = await markAccountChanged(tx, { accountId: actorUserId, kind: "artifact", entityId: artifactId });
            await tx.artifact.delete({ where: { id: artifactId } });
            return { ok: true, cursor };
        });
    } catch {
        return { ok: false, error: "internal" };
    }
}
