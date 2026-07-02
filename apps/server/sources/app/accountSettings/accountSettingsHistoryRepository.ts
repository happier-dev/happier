import type { TransactionClient } from "@/storage/prisma";

import { resolveAccountSettingsHistoryLimitFromEnv } from "./accountSettingsHistoryConfig";
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
    const stale = await tx.accountSettingsSnapshot.findMany({
        where: { accountId: params.accountId },
        orderBy: [
            { version: "desc" },
            { createdAt: "desc" },
        ],
        skip: params.limit,
        select: { id: true },
    });
    if (stale.length === 0) return;

    await tx.accountSettingsSnapshot.deleteMany({
        where: {
            id: { in: stale.map((snapshot) => snapshot.id) },
        },
    });
}
