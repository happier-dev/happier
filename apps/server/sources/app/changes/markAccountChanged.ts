import { afterTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { buildAccountChangeWakeUpdate } from "@/app/events/eventPayloadBuilders";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    ChangeKindSchema,
    PluginDomainChangeHintSchema,
    buildPluginDomainAccountChangeEntityId,
    type ChangeKind,
} from "@happier-dev/protocol/changes";

function preserveCollectionFullHint(existingHint: unknown, nextHint: unknown): unknown {
    const existing = PluginDomainChangeHintSchema.safeParse(existingHint);
    const next = PluginDomainChangeHintSchema.safeParse(nextHint);
    if (
        !existing.success
        || !next.success
        || existing.data.pluginDomain !== "dataCollection"
        || next.data.pluginDomain !== "dataCollection"
        || !("full" in existing.data && existing.data.full === true)
        || ("full" in next.data && next.data.full === true)
        || existing.data.pluginId !== next.data.pluginId
        || existing.data.collectionId !== next.data.collectionId
    ) {
        return nextHint;
    }

    // AccountChange coalesces one plugin/collection entity across every
    // compatible retained Collection contract. An exact successor cannot
    // narrow a pending full reread, but its newer digest/revision remains the
    // most current diagnostic fact for the qualified collection.
    return {
        pluginDomain: "dataCollection" as const,
        pluginId: next.data.pluginId,
        collectionId: next.data.collectionId,
        contractDigest: next.data.contractDigest,
        revision: next.data.revision,
        full: true as const,
    };
}

function isExactCollectionHint(hint: unknown): boolean {
    const parsed = PluginDomainChangeHintSchema.safeParse(hint);
    return parsed.success
        && parsed.data.pluginDomain === "dataCollection"
        && !("full" in parsed.data && parsed.data.full === true);
}

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

function scheduleAccountChangeWake(tx: Tx, accountId: string, cursor: number): void {
    afterTx(tx, () => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildAccountChangeWakeUpdate(cursor, randomKeyNaked(12)),
            recipientFilter: { type: 'account-stored-content-v3' },
        });
    });
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

    if (!accountId) throw new Error('markAccountChanged: accountId is required');
    if (!kind) throw new Error('markAccountChanged: kind is required');
    if (!entityId) throw new Error('markAccountChanged: entityId is required');

    const pluginDomainHint = kind === 'pluginDomain'
        ? PluginDomainChangeHintSchema.safeParse(params.hint)
        : null;
    if (pluginDomainHint && !pluginDomainHint.success) {
        throw new Error('markAccountChanged: pluginDomain hint is invalid');
    }
    if (
        pluginDomainHint?.success
        && entityId !== buildPluginDomainAccountChangeEntityId(pluginDomainHint.data)
    ) {
        throw new Error('markAccountChanged: pluginDomain entityId does not match the hint identity');
    }
    const hint = pluginDomainHint?.success
        ? pluginDomainHint.data
        : compactHint(kind, params.hint);

    const now = new Date();
    const sessionId = kind === "session" || kind === "share" ? entityId : null;
    const machineId = kind === "machine" ? entityId : null;
    const artifactId = kind === "artifact" ? entityId : null;
    const accountPetPackageId = kind === "pet" ? entityId : null;

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
                "artifactId",
                "accountPetPackageId"
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
                $8,
                $9
            FROM next
            ON CONFLICT ("accountId", "kind", "entityId")
            DO UPDATE SET
                "cursor" = EXCLUDED."cursor",
                "changedAt" = EXCLUDED."changedAt",
                "hint" = CASE
                    WHEN
                        "AccountChange"."hint"->>'pluginDomain' = 'dataCollection'
                        AND "AccountChange"."hint"->>'full' = 'true'
                        AND "AccountChange"."hint"->>'pluginId' = EXCLUDED."hint"->>'pluginId'
                        AND "AccountChange"."hint"->>'collectionId' = EXCLUDED."hint"->>'collectionId'
                        AND EXCLUDED."hint"->>'pluginDomain' = 'dataCollection'
                        AND COALESCE(EXCLUDED."hint"->>'full', 'false') <> 'true'
                    THEN jsonb_build_object(
                        'pluginDomain', 'dataCollection',
                        'pluginId', EXCLUDED."hint"->'pluginId',
                        'collectionId', EXCLUDED."hint"->'collectionId',
                        'contractDigest', EXCLUDED."hint"->'contractDigest',
                        'revision', EXCLUDED."hint"->'revision',
                        'full', true
                    )
                    ELSE EXCLUDED."hint"
                END,
                "sessionId" = EXCLUDED."sessionId",
                "machineId" = EXCLUDED."machineId",
                "artifactId" = EXCLUDED."artifactId",
                "accountPetPackageId" = EXCLUDED."accountPetPackageId"
            RETURNING "cursor"`,
            accountId,
            kind,
            entityId,
            now,
            hint === undefined ? null : JSON.stringify(hint),
            sessionId,
            machineId,
            artifactId,
            accountPetPackageId,
        );
        const cursorValue = rows[0]?.cursor;
        const cursor = typeof cursorValue === "bigint" ? Number(cursorValue) : cursorValue;
        if (!Number.isFinite(cursor)) {
            throw new Error("markAccountChanged: failed to allocate cursor");
        }
        scheduleAccountChangeWake(tx, accountId, cursor);
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
        if (accountPetPackageId) {
            return { accountPetPackageId };
        }
        return {};
    })();
    const next = await tx.account.update({
        where: { id: accountId },
        data: { seq: { increment: 1 } },
        select: { seq: true },
    });

    const cursor = next.seq;

    // The Account update above is the shared per-Account writer fence for the
    // Prisma providers. Read the coalesced row only after it, so a later
    // exact Collection write cannot observe and overwrite a stale full scope.
    const current = isExactCollectionHint(hint)
        ? await tx.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId,
                    kind,
                    entityId,
                },
            },
            select: { hint: true },
        })
        : null;
    const persistedHint = current
        ? preserveCollectionFullHint(current.hint, hint)
        : hint;

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
            hint: persistedHint,
        },
        update: {
            ...fk,
            cursor,
            changedAt: now,
            hint: persistedHint,
        },
    });

    scheduleAccountChangeWake(tx, accountId, cursor);
    return cursor;
}
