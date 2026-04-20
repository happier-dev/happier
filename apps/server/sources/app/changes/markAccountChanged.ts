import type { Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
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
    const sessionId = kind === "session" || kind === "share" ? entityId : null;
    const machineId = kind === "machine" ? entityId : null;
    const artifactId = kind === "artifact" ? entityId : null;

    // Cursor strategy (locked in a.project.md):
    // - allocate a unique per-account cursor by incrementing Account.seq once per call,
    // - write that cursor value into the coalesced AccountChange row.
    const provider = getDbProviderFromEnv(process.env, "postgres");
    if (provider === "postgres" && typeof (tx as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === "function") {
        const rows = await (tx as {
            $queryRawUnsafe: <TRow>(query: string, ...values: unknown[]) => Promise<TRow[]>;
        }).$queryRawUnsafe<{ cursor: number | bigint }>(
            `WITH next AS (
                UPDATE "Account"
                SET "seq" = "seq" + 1
                WHERE "id" = $1
                RETURNING "seq"
            )
            INSERT INTO "AccountChange" (
                "accountId",
                "kind",
                "entityId",
                "cursor",
                "changedAt",
                "hint",
                "sessionId",
                "machineId",
                "artifactId"
            )
            SELECT
                $1,
                $2,
                $3,
                next."seq",
                $4,
                $5::jsonb,
                $6,
                $7,
                $8
            FROM next
            ON CONFLICT ("accountId", "kind", "entityId")
            DO UPDATE SET
                "cursor" = EXCLUDED."cursor",
                "changedAt" = EXCLUDED."changedAt",
                "hint" = EXCLUDED."hint",
                "sessionId" = EXCLUDED."sessionId",
                "machineId" = EXCLUDED."machineId",
                "artifactId" = EXCLUDED."artifactId"
            RETURNING "cursor"`,
            accountId,
            kind,
            entityId,
            now,
            hint === undefined ? null : JSON.stringify(hint),
            sessionId,
            machineId,
            artifactId,
        );
        const cursorValue = rows[0]?.cursor;
        const cursor = typeof cursorValue === "bigint" ? Number(cursorValue) : cursorValue;
        if (!Number.isFinite(cursor)) {
            throw new Error("markAccountChanged: failed to allocate cursor");
        }
        return cursor;
    }

    const fk = (() => {
        if (sessionId) {
            return { sessionId };
        }
        if (machineId) {
            return { machineId };
        }
        if (artifactId) {
            return { artifactId };
        }
        return {};
    })();
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
            ...fk,
            cursor,
            changedAt: now,
            hint,
        },
        update: {
            ...fk,
            cursor,
            changedAt: now,
            hint,
        },
    });

    return cursor;
}
