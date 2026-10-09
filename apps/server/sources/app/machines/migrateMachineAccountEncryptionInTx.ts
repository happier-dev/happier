import {
    machineStoredContentMatchesAccountMode,
    type AccountEncryptionMigrateMachinesDirective,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";
import { compareAndSwapMachineContentInTx } from "./compareAndSwapMachineContentInTx";
import { serializeMachineKeyBasis } from "./machineSerialization";
import { resolveCurrentMachineRecipientAccountIdsInTx } from "./machineAccess";

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
    | Readonly<{ status: "invalid_content" }>
    | Readonly<{ status: "unsupported_machine_kind" }>;

export type MachineAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

type MachineAccountEncryptionMigrationRow = Readonly<{
    id: string;
    kind: "persistent" | "ephemeral_session_runner";
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
            kind: true,
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

    // Runner Machines own a creator-bound content key that the public Account
    // migration directive cannot authenticate or safely replace. Reject the
    // whole inventory before validating replacements or writing any Machine.
    if (rows.some((row) => row.kind === "ephemeral_session_runner")) {
        return { status: "unsupported_machine_kind" };
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
        ?? (async (machineId: string) => {
            for (const accountId of await resolveCurrentMachineRecipientAccountIdsInTx(params.tx, machineId)) {
                await markAccountChanged(params.tx, { accountId, kind: "machine", entityId: machineId });
            }
        });

    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (const item of params.directive.items) {
        const current = rowsById.get(item.machineId);
        if (!current) throw new MachineAccountEncryptionMigrationConflictError();
        const updated = await compareAndSwapMachineContentInTx({
            tx: params.tx,
            accountId: params.accountId,
            machineId: item.machineId,
            expected: {
                dataEncryptionKey: serializeMachineKeyBasis(current).dataEncryptionKey,
                metadataVersion: item.expectedMetadataVersion,
                daemonStateVersion: item.expectedDaemonStateVersion,
            },
            next: {
                metadata: item.metadata,
                daemonState: item.daemonState,
                dataEncryptionKey: item.dataEncryptionKey,
                contentPublicKeyFingerprint: item.contentPublicKeyFingerprint,
            },
        });
        if (!updated) {
            throw new MachineAccountEncryptionMigrationConflictError();
        }
        await markChanged(item.machineId);
    }

    return { status: "applied" };
}
