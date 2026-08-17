import type { TransactionClient } from "@/storage/prisma";

import {
    ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES,
    resolveAccountSettingsHistoryLimitFromEnv,
} from "./accountSettingsHistoryConfig";
import {
    resolveAccountSettingsSnapshotContentKind,
    type AccountSettingsSnapshotEncryptionMode,
} from "./accountSettingsHistoryContent";

export type AccountSettingsSnapshotInput = Readonly<{
    accountId: string;
    version: number;
    settingsDbValue: string | null;
    encryptionMode: AccountSettingsSnapshotEncryptionMode;
}>;

export async function recordAccountSettingsSnapshotsForWrite(params: Readonly<{
    tx: TransactionClient;
    previous: AccountSettingsSnapshotInput;
    next: AccountSettingsSnapshotInput;
    env?: NodeJS.ProcessEnv;
}>): Promise<void> {
    const limit = resolveAccountSettingsHistoryLimitFromEnv(params.env ?? process.env);
    if (limit === 0) {
        await params.tx.accountSettingsSnapshot.deleteMany({
            where: { accountId: params.next.accountId },
        });
        return;
    }

    await ensureAccountSettingsSnapshot(params.tx, params.previous);
    await ensureAccountSettingsSnapshot(params.tx, params.next);
    await pruneAccountSettingsSnapshots(params.tx, {
        accountId: params.next.accountId,
        limit,
    });
}

async function ensureAccountSettingsSnapshot(
    tx: TransactionClient,
    snapshot: AccountSettingsSnapshotInput,
): Promise<void> {
    await tx.accountSettingsSnapshot.upsert({
        where: {
            accountId_version: {
                accountId: snapshot.accountId,
                version: snapshot.version,
            },
        },
        create: {
            accountId: snapshot.accountId,
            version: snapshot.version,
            settingsDbValue: snapshot.settingsDbValue,
            encryptionMode: snapshot.encryptionMode,
            contentKind: resolveAccountSettingsSnapshotContentKind(snapshot),
        },
        update: {},
    });
}

async function pruneAccountSettingsSnapshots(
    tx: TransactionClient,
    params: Readonly<{ accountId: string; limit: number }>,
): Promise<void> {
    const snapshots = await tx.accountSettingsSnapshot.findMany({
        where: { accountId: params.accountId },
        orderBy: [
            { version: "desc" },
            { createdAt: "desc" },
        ],
        select: {
            id: true,
            settingsDbValue: true,
        },
    });
    const stale: string[] = [];
    let retainedCount = 0;
    let retainedBytes = 0;
    let pruningOlderSnapshots = false;
    for (const snapshot of snapshots) {
        const snapshotBytes = Buffer.byteLength(snapshot.settingsDbValue ?? "", "utf8");
        if (
            // Snapshots are newest first: once one cannot stay, retaining an older
            // row would create a hole instead of one contiguous newest suffix.
            pruningOlderSnapshots
            || retainedCount >= params.limit
            || retainedBytes + snapshotBytes > ACCOUNT_SETTINGS_HISTORY_MAX_AGGREGATE_BYTES
        ) {
            stale.push(snapshot.id);
            pruningOlderSnapshots = true;
            continue;
        }
        retainedCount += 1;
        retainedBytes += snapshotBytes;
    }
    if (stale.length === 0) return;

    await tx.accountSettingsSnapshot.deleteMany({
        where: {
            id: { in: stale },
        },
    });
}
