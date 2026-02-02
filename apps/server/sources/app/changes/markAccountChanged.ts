import type { Tx } from "@/storage/inTx";
import { ChangeKindSchema, type ChangeKind } from "@happier-dev/protocol/changes";

function compactHint(_kind: ChangeKind, hint: unknown): unknown {
    if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
        return hint;
    }

    const record = hint as Record<string, unknown>;

    // Keep `keys` hints small (primarily used by KV/todos). If the hint is too large, degrade to
    // a "full refresh" hint to avoid bloating the DB row.
    const keys = record.keys;
    if (Array.isArray(keys)) {
        const cleaned = keys
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .slice(0, 200);

        // If we had to drop anything, force a full refresh rather than risking partial catch-up.
        if (cleaned.length !== keys.length) {
            return { full: true };
        }

        return { ...record, keys: cleaned };
    }

    // For unknown hint shapes, keep as-is. The write paths should keep hints small.
    return hint;
}

export async function markAccountChanged(
    tx: Tx,
    params: {
        accountId: string;
        kind: ChangeKind;
        entityId: string;
        hint?: unknown;
    },
): Promise<number> {
    const accountId = typeof params.accountId === 'string' ? params.accountId : '';
    const kindRes = ChangeKindSchema.safeParse(params.kind);
    const kind = kindRes.success ? kindRes.data : null;
    const entityId = typeof params.entityId === 'string' ? params.entityId : '';
    const hint = kind ? compactHint(kind, params.hint) : params.hint;

    if (!accountId) throw new Error('markAccountChanged: accountId is required');
    if (!kind) throw new Error('markAccountChanged: kind is required');
    if (!entityId) throw new Error('markAccountChanged: entityId is required');

    const now = new Date();

    // Cursor strategy (locked in a.project.md):
    // - allocate a unique per-account cursor by incrementing Account.seq once per call,
    // - write that cursor value into the coalesced AccountChange row.
    const next = await tx.account.update({
        where: { id: accountId },
        data: { seq: { increment: 1 } },
        select: { seq: true },
    });

    const cursor = next.seq;

    await tx.accountChange.upsert({
        where: {
            accountId_kind_entityId: {
                accountId,
                kind,
                entityId,
            },
        },
        create: {
            accountId,
            kind,
            entityId,
            cursor,
            changedAt: now,
            hint,
        },
        update: {
            cursor,
            changedAt: now,
            hint,
        },
    });

    return cursor;
}
