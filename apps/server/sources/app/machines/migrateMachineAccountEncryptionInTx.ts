import * as privacyKit from "privacy-kit";
import { isPlainMachineDataKeyMarker, machineStoredContentMatchesAccountMode, type AccountEncryptionMigrateMachinesDirective } from "@happier-dev/protocol";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { afterTx, type Tx } from "@/storage/inTx";
import { buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { compareAndSwapMachineContentInTx } from "./compareAndSwapMachineContentInTx";

export class MachineAccountEncryptionMigrationConflictError extends Error {
    constructor() {
        super("Machine account-encryption migration lost its content precondition");
        this.name = "MachineAccountEncryptionMigrationConflictError";
    }
}

/** Validates the complete owned inventory before atomically rewriting every content triple. */
export async function migrateMachineAccountEncryptionInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    toMode: "plain" | "e2ee";
    directive?: AccountEncryptionMigrateMachinesDirective;
}>): Promise<"applied" | "requires_upgrade" | "incomplete" | "invalid_content"> {
    const rows = await params.tx.machine.findMany({
        where: { accountId: params.accountId },
        select: { id: true, metadataVersion: true, daemonStateVersion: true, dataEncryptionKey: true, revokedAt: true, replacedByMachineId: true },
    });
    const directive = params.directive;
    // Released clients leave encrypted Machine history unchanged when disabling Account
    // encryption. Enabling it cannot leave an explicitly plain Machine behind.
    if (!directive) {
        return params.toMode === "e2ee" && rows.some((row) => isPlainMachineDataKeyMarker(row.dataEncryptionKey))
            ? "requires_upgrade" : "applied";
    }
    if (directive.action === "assert_empty") return rows.length === 0 ? "applied" : "incomplete";
    const itemsById = new Map(directive.items.map((item) => [item.machineId, item]));
    if (itemsById.size !== directive.items.length || itemsById.size !== rows.length) return "incomplete";
    for (const row of rows) {
        const item = itemsById.get(row.id);
        const currentKey = row.dataEncryptionKey === null ? null : privacyKit.encodeBase64(row.dataEncryptionKey);
        if (!item || item.expected.dataEncryptionKey !== currentKey
            || item.expected.metadataVersion !== row.metadataVersion
            || item.expected.daemonStateVersion !== row.daemonStateVersion) return "incomplete";
        if (!machineStoredContentMatchesAccountMode({
            mode: params.toMode, metadata: item.next.metadata,
            ...(item.next.daemonState === null ? {} : { daemonState: item.next.daemonState }),
            dataEncryptionKey: item.next.dataEncryptionKey,
        })) return "invalid_content";
    }
    for (const row of rows) {
        const item = itemsById.get(row.id)!;
        const written = await compareAndSwapMachineContentInTx({
            tx: params.tx, accountId: params.accountId, machineId: row.id,
            expected: item.expected,
            expectedLifecycle: { revokedAt: row.revokedAt, replacedByMachineId: row.replacedByMachineId },
            next: { ...item.next, contentPublicKeyFingerprint: null },
        });
        if (!written) throw new MachineAccountEncryptionMigrationConflictError();
        const cursor = await markAccountChanged(params.tx, { accountId: params.accountId, kind: "machine", entityId: row.id });
        afterTx(params.tx, () => {
            eventRouter.emitUpdate({
                userId: params.accountId,
                payload: buildUpdateMachineUpdate(row.id, cursor, randomKeyNaked(12),
                    { value: item.next.metadata, version: item.expected.metadataVersion + 1 },
                    { value: item.next.daemonState, version: item.expected.daemonStateVersion + 1 },
                    { dataEncryptionKey: item.next.dataEncryptionKey, contentPublicKeyFingerprint: null }),
                recipientFilter: { type: "machine-scoped-only", machineId: row.id },
            });
        });
    }
    return "applied";
}
