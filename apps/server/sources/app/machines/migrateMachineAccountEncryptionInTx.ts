import {
    machineStoredContentMatchesAccountMode,
    type AccountEncryptionMigrateMachinesDirective,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";

export class MachineAccountEncryptionMigrationConflictError extends Error {
    constructor() {
        super("Machine account-encryption migration lost its version precondition");
        this.name = "MachineAccountEncryptionMigrationConflictError";
    }
}

export type MachineAccountEncryptionMigrationResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type MachineAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

type MachineAccountEncryptionMigrationRow = Readonly<{
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    contentPublicKeyFingerprint: string | null;
}>;

async function readMachineAccountEncryptionMigrationRowsInTx(
    tx: Tx,
    accountId: string,
): Promise<readonly MachineAccountEncryptionMigrationRow[]> {
    return await tx.machine.findMany({
        where: { accountId },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            daemonState: true,
            daemonStateVersion: true,
            dataEncryptionKey: true,
            contentPublicKeyFingerprint: true,
        },
    });
}

function bytesEqual(
    left: Uint8Array | null,
    right: Uint8Array | null,
): boolean {
    if (left === null || right === null) return left === right;
    return left.byteLength === right.byteLength
        && left.every((value, index) => value === right[index]);
}

/**
 * Read-only exact Machine post-state matcher for Account-transition replay.
 */
export async function matchMachineAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive: AccountEncryptionMigrateMachinesDirective;
    }>,
): Promise<MachineAccountEncryptionMigrationPostStateResult> {
    const rows =
        await readMachineAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );
    if (params.directive.action === "assert_empty") {
        return {
            status: rows.length === 0
                ? "matched"
                : "mismatch",
        };
    }
    const itemsById = new Map(
        params.directive.items.map((item) => [
            item.machineId,
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
        const expectedDataEncryptionKey =
            item?.dataEncryptionKey === null
                ? null
                : item
                    ? new Uint8Array(Buffer.from(
                        item.dataEncryptionKey,
                        "base64",
                    ))
                    : null;
        if (
            !item
            || row.metadataVersion
                !== item.expectedMetadataVersion + 1
            || row.daemonStateVersion
                !== item.expectedDaemonStateVersion + 1
            || row.metadata !== item.metadata
            || row.daemonState !== item.daemonState
            || !bytesEqual(
                row.dataEncryptionKey,
                expectedDataEncryptionKey,
            )
            || row.contentPublicKeyFingerprint
                !== item.contentPublicKeyFingerprint
            || !machineStoredContentMatchesAccountMode({
                mode: params.toMode,
                metadata: row.metadata,
                ...(row.daemonState === null
                    ? {}
                    : { daemonState: row.daemonState }),
                dataEncryptionKey: row.dataEncryptionKey,
            })
        ) {
            return { status: "mismatch" };
        }
    }
    return { status: "matched" };
}

export async function migrateMachineAccountEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    toMode: "plain" | "e2ee";
    directive: AccountEncryptionMigrateMachinesDirective;
    markChanged?: (machineId: string) => Promise<unknown>;
}>): Promise<MachineAccountEncryptionMigrationResult> {
    const rows =
        await readMachineAccountEncryptionMigrationRowsInTx(
            params.tx,
            params.accountId,
        );

    if (params.directive.action === "assert_empty") {
        return rows.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }

    const itemsById = new Map(
        params.directive.items.map((item) => [item.machineId, item]),
    );
    if (
        itemsById.size !== params.directive.items.length
        || itemsById.size !== rows.length
    ) {
        return { status: "migration_incomplete" };
    }
    for (const row of rows) {
        const item = itemsById.get(row.id);
        if (
            !item
            || item.expectedMetadataVersion !== row.metadataVersion
            || item.expectedDaemonStateVersion !== row.daemonStateVersion
        ) {
            return { status: "migration_incomplete" };
        }
        if (!machineStoredContentMatchesAccountMode({
            mode: params.toMode,
            metadata: item.metadata,
            ...(item.daemonState === null
                ? {}
                : { daemonState: item.daemonState }),
            dataEncryptionKey: item.dataEncryptionKey,
        })) {
            return { status: "invalid_content" };
        }
    }

    const markChanged =
        params.markChanged
        ?? (async (machineId: string) =>
            await markAccountChanged(params.tx, {
                accountId: params.accountId,
                kind: "machine",
                entityId: machineId,
            }));

    for (const item of params.directive.items) {
        const updated = await params.tx.machine.updateMany({
            where: {
                accountId: params.accountId,
                id: item.machineId,
                metadataVersion: item.expectedMetadataVersion,
                daemonStateVersion: item.expectedDaemonStateVersion,
            },
            data: {
                metadata: item.metadata,
                metadataVersion: item.expectedMetadataVersion + 1,
                daemonState: item.daemonState,
                daemonStateVersion: item.expectedDaemonStateVersion + 1,
                dataEncryptionKey:
                    item.dataEncryptionKey === null
                        ? null
                        : new Uint8Array(
                            Buffer.from(item.dataEncryptionKey, "base64"),
                        ),
                contentPublicKeyFingerprint:
                    item.contentPublicKeyFingerprint,
                updatedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new MachineAccountEncryptionMigrationConflictError();
        }
        await markChanged(item.machineId);
    }

    return { status: "applied" };
}
