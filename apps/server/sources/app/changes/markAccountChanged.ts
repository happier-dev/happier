import { afterTx, getTransactionContext, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { resolveDbSqlDialect } from "@/config/databaseProvider";
import { buildAccountChangeWakeUpdate, buildAccountSettingsChangedUpdate } from "@/app/events/eventPayloadBuilders";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { ChangeKindSchema, readAccountSettingsVersionChangeV1, readArtifactKindsV1, readArtifactKindsChangeHintV1, type ChangeKind } from '@happier-dev/protocol/changes';
import { PluginDomainChangeHintSchema, buildPluginDomainAccountChangeEntityId } from '@happier-dev/protocol/changes/pluginDomain';
import { DISCUSSION_CHANGE_HINT_V1, readDiscussionChangeHintV1, type DiscussionChangeHintV1 } from '@happier-dev/protocol/discussions';
import { isSessionSystemRecordUnchangedHintV1, readSessionSystemRecordChangeV1, type SessionSystemRecordInvalidationV1 } from '@happier-dev/protocol/sessions/board/changeHint';
import { readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { coalesceSessionProjectionChangeHintInTx, retainSessionSourceChangeHint, sessionChangeHint,
    mergeSessionCoalescedHint, sessionCoalescedHintSql } from './sessionProjectionChangeHint';
import { acquireAccountSessionOwnerMetadataFencesInTx, acquireAccountSessionOwnerMetadataPublicationFencesInTx, type AccountAdmissionIntent } from '@/app/encryption/accountSessionOwnerMetadataFence';

/** An allocation intent, resolved only by the transaction's publication phase. */
export interface AccountChangePublication {
    readonly accountId: string;
    resolveCursor(): number;
}

interface AccountChangeWake {
    cursor: number;
    /** Null after a coalesced fact needs the ordinary Account-wide wake. */
    currentViewSessionId: string | null;
    settingsVersion?: number;
    changeKinds: Set<ChangeKind>;
    entityIds: Set<string>;
    artifactKinds?: Set<string> | null;
    sessionSystemRecords?: Map<string, SessionSystemRecordInvalidationV1> | null;
}

interface AccountPublicationPhase {
    phase: 'domain' | 'validating' | 'publishing' | 'projecting' | 'complete';
    accountIds: Set<string>;
    operations: Array<(tx: Tx) => Promise<void>>;
    validations: Array<(tx: Tx) => Promise<void>>;
    projections: Array<(tx: Tx) => Promise<void>>;
    wakes?: Map<string, AccountChangeWake>;
}

const accountPublicationSymbol = Symbol('account-publication');
type PublicationContext = { [accountPublicationSymbol]?: AccountPublicationPhase };

function publicationPhase(tx: Tx): AccountPublicationPhase {
    const owner = getTransactionContext(tx) as PublicationContext;
    return owner[accountPublicationSymbol] ??= {
        phase: 'domain', accountIds: new Set(), operations: [], validations: [], projections: [],
    };
}

function recordPublicationAudience(state: AccountPublicationPhase, accountIds: readonly string[]): void {
    if (state.phase !== 'domain') throw new Error('Account publication audience must be declared during domain work');
    for (const accountId of accountIds) state.accountIds.add(accountId);
}

/** Recheck current audiences after ordered publication locking, without resource locks. */
export function beforeAccountChangePublication(
    tx: Tx, accountIds: readonly string[], validate: (tx: Tx) => Promise<void>,
): void {
    const state = publicationPhase(tx);
    recordPublicationAudience(state, accountIds);
    state.validations.push(validate);
}

/** Validate against the complete union, including audiences added by this transaction. */
export function assertAccountChangePublicationAudienceInTx(tx: Tx, accountIds: readonly string[]): void {
    const state = publicationPhase(tx);
    if (state.phase !== 'validating') throw new Error('Account audience verification requires terminal publication locking');
    if (accountIds.some(accountId => !state.accountIds.has(accountId))) {
        throw new TransactionReplayRequiredError('transaction-account-audience-changed');
    }
}

/** Read final committed-intent facts; callbacks may only read and schedule afterTx work. */
export function afterAccountChangePublication(tx: Tx, project: (tx: Tx) => Promise<void>): void {
    const state = publicationPhase(tx);
    if (state.phase !== 'domain') throw new Error('Account publication projections must be declared during domain work');
    state.projections.push(project);
}

/**
 * Add an Account-owned publication operation to the same terminal phase.
 * Existing resource rows must already be locked; no Session/resource locks may
 * be acquired by the operation. This also owns the Feed's Account counter tail.
 * Sole exception: already-exclusively-admitted physical Account erasure queues
 * its final Account.delete and existing FK cascades after its publications.
 */
export function enqueueAccountChangePublication(
    tx: Tx, accountIds: readonly string[], publish: (tx: Tx) => Promise<void>,
): void {
    const state = publicationPhase(tx);
    recordPublicationAudience(state, accountIds);
    state.operations.push(publish);
}

function pendingCursor(accountId: string) {
    let cursor: number | undefined;
    const publication: AccountChangePublication = {
        accountId,
        resolveCursor() {
            if (cursor === undefined) throw new Error('Account cursor is unavailable before terminal publication');
            return cursor;
        },
    };
    return { publication, resolve: (value: number) => { cursor = value; } };
}

function assertDeclaredPublication(state: AccountPublicationPhase, accountIds: readonly string[]): void {
    if (accountIds.some(accountId => !state.accountIds.has(accountId))) {
        throw new Error('Terminal publication cannot extend its locked Account audience');
    }
}

/** Called exactly once by inTx, after domain work and before commit. */
export async function flushAccountChangesInTx(tx: Tx): Promise<void> {
    const state = (getTransactionContext(tx) as PublicationContext)[accountPublicationSymbol];
    if (!state) return;
    if (state.phase !== 'domain') throw new Error('Account publication phase already started');
    state.phase = 'validating';
    if (state.operations.length > 0) {
        await acquireAccountSessionOwnerMetadataPublicationFencesInTx(tx, [...state.accountIds]);
    }
    for (const validate of state.validations) await validate(tx);
    state.phase = 'publishing';
    for (const publish of state.operations) await publish(tx);
    state.phase = 'projecting';
    for (const project of state.projections) await project(tx);
    state.phase = 'complete';
}

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

async function coalesceDiscussionChangeHintInTx(
    tx: Tx, accountId: string, entityId: string, hint: unknown,
): Promise<DiscussionChangeHintV1> {
    const current = await tx.accountChange.findUnique({
        where: { accountId_kind_entityId: { accountId, kind: 'discussion', entityId } },
        select: { hint: true },
    });
    const next = readDiscussionChangeHintV1(hint) ?? DISCUSSION_CHANGE_HINT_V1;
    if (!current) return next;
    const existing = readDiscussionChangeHintV1(current.hint);
    return {
        v: 1,
        discussions: true,
        changes: {
            ...(existing?.changes.readState || next.changes.readState ? { readState: true } : {}),
            // Unknown retained hints cannot prove that only a cursor changed.
            ...(!existing || existing.changes.resource || next.changes.resource ? { resource: true } : {}),
        },
    };
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

function scheduleAccountChangeWake(
    tx: Tx, accountId: string, cursor: number, kind: ChangeKind, entityIds: readonly string[], hint?: unknown,
    currentViewSessionId?: string,
    artifactKinds?: readonly string[] | null,
): void {
    const state = publicationPhase(tx);
    const wakes: NonNullable<AccountPublicationPhase['wakes']> = state.wakes ??= new Map();
    const pending = wakes.get(accountId);
    const wake: AccountChangeWake = pending ?? {
        cursor, currentViewSessionId: currentViewSessionId ?? null, changeKinds: new Set(), entityIds: new Set(),
    };
    wake.cursor = Math.max(wake.cursor, cursor);
    if (wake.currentViewSessionId !== currentViewSessionId) wake.currentViewSessionId = null;
    const settingsVersion = entityIds.length === 1
        ? readAccountSettingsVersionChangeV1({ kind, entityId: entityIds[0]!, hint }) : null;
    if (settingsVersion !== null) {
        wake.settingsVersion = Math.max(wake.settingsVersion ?? 0, settingsVersion);
    } else {
        wake.changeKinds.add(kind);
        for (const entityId of entityIds) wake.entityIds.add(entityId);
        if (kind === 'artifact' && wake.artifactKinds !== null) {
            if (artifactKinds == null) wake.artifactKinds = null;
            else for (const artifactKind of artifactKinds) (wake.artifactKinds ??= new Set()).add(artifactKind);
        }
        collectSessionSystemRecordWakeTargets(wake, kind, entityIds, hint);
    }
    if (pending) return;
    // Keep one post-commit slot per Account; typed settings facts never widen
    // unrelated Machine/Session changes that committed in the same transaction.
    wakes.set(accountId, wake);
    afterTx(tx, () => {
        if (wake.settingsVersion !== undefined) eventRouter.emitUpdate({
            userId: accountId,
            payload: buildAccountSettingsChangedUpdate(wake.settingsVersion, wake.cursor, randomKeyNaked(12)),
            recipientFilter: { type: 'account-stored-content-v3' },
        });
        if (wake.changeKinds.size === 0) return;
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildAccountChangeWakeUpdate(wake.cursor, randomKeyNaked(12), {
                changeKinds: [...wake.changeKinds], entityIds: [...wake.entityIds],
                ...(wake.artifactKinds ? { artifactKinds: [...wake.artifactKinds] } : {}),
                ...(wake.sessionSystemRecords ? { sessionSystemRecords: [...wake.sessionSystemRecords.values()] } : {}),
            }),
            recipientFilter: { type: 'account-stored-content-v3',
                ...(wake.currentViewSessionId ? { exceptSessionCurrentView: wake.currentViewSessionId } : {}) },
        });
    });
}

function artifactPublicationKinds(hint: unknown, storedKind: unknown): readonly string[] | null {
    // A kind-changing writer supplies both the displaced and committed type;
    // an explicit unknown must not be narrowed by the final row's type.
    return hint !== null && typeof hint === 'object' && !Array.isArray(hint) && 'artifactKinds' in hint
        ? readArtifactKindsChangeHintV1(hint) : readArtifactKindsV1([storedKind]);
}

async function coalesceArtifactChangeHintInTx(
    tx: Tx, accountId: string, entityId: string, hint: unknown, kinds: readonly string[] | null,
): Promise<Record<string, unknown>> {
    const previous = await tx.accountChange.findUnique({
        where: { accountId_kind_entityId: { accountId, kind: 'artifact', entityId } },
        select: { hint: true },
    });
    const retainedKinds = previous ? readArtifactKindsChangeHintV1(previous.hint) : [];
    const base = hint !== null && typeof hint === 'object' && !Array.isArray(hint)
        ? Object.fromEntries(Object.entries(hint).filter(([key]) => key !== 'artifactKinds')) : {};
    // A coalesced row covers every unconsumed change. An older unknown cannot
    // be made precise by a later known write, including after delete/recreate.
    return kinds && retainedKinds
        ? { ...base, artifactKinds: [...new Set([...retainedKinds, ...kinds])] } : base;
}

function collectSessionSystemRecordWakeTargets(
    wake: { sessionSystemRecords?: Map<string, SessionSystemRecordInvalidationV1> | null },
    kind: ChangeKind, entityIds: readonly string[], hint: unknown,
): void {
    // Unknown Account facts retain the existing coarse recovery for the entire
    // committed wake. A later known transcript cannot narrow that audience.
    if (wake.sessionSystemRecords === null) return;
    for (const entityId of entityIds) {
        const record = readSessionSystemRecordChangeV1({ kind, entityId, hint });
        const followReceiver = readSessionFollowReceiverChangeV1({ kind, entityId });
        if (record) {
            (wake.sessionSystemRecords ??= new Map()).set(JSON.stringify([kind, entityId]), record);
        } else if (followReceiver !== null) {
            // This known domain key carries the same receiver as its Session
            // projection, not an unknown Account-wide records invalidation.
            (wake.sessionSystemRecords ??= new Map()).set(JSON.stringify(['session', followReceiver]), { sessionId: followReceiver });
        } else if (kind === 'account' && entityId === 'public-profile') {
            // Disclosure changes do not invalidate private Session records.
            wake.sessionSystemRecords ??= new Map();
        } else if (kind === 'account') {
            wake.sessionSystemRecords = null;
            return;
        } else if (kind === 'session' || kind === 'share') {
            const targets = wake.sessionSystemRecords ??= new Map();
            if (kind !== 'session' || !isSessionSystemRecordUnchangedHintV1(hint)) {
                targets.set(JSON.stringify([kind, entityId]), { sessionId: entityId });
            }
        }
    }
}

export type AccountChangeCursor = Readonly<{ accountId: string; cursor: number }>;

function scheduleAccountProjectionWakes(
    tx: Tx, kind: ChangeKind, requests: readonly { accountId: string; entityId: string }[],
    cursors: readonly AccountChangeCursor[], hint?: unknown,
): void {
    const entityIdsByAccountId = new Map<string, string[]>();
    for (const { accountId, entityId } of requests) {
        const entityIds = entityIdsByAccountId.get(accountId) ?? [];
        entityIds.push(entityId);
        entityIdsByAccountId.set(accountId, entityIds);
    }
    // Both providers return Account/cursor-sorted allocations. The last cursor
    // per Account is its maximum; retain the same Account callback order.
    for (const [index, row] of cursors.entries()) {
        if (cursors[index + 1]?.accountId === row.accountId) continue;
        scheduleAccountChangeWake(tx, row.accountId, row.cursor, kind, entityIdsByAccountId.get(row.accountId)!, hint);
    }
}

/** Admit the complete audience, retaining MySQL's exclusive entry and PostgreSQL stability. */
export async function acquireAccountChangePublicationLocksInTx(
    tx: Tx,
    recipientAccountIds: readonly string[],
    options?: Readonly<{ includeSingleAccount?: boolean; intent?: AccountAdmissionIntent }>,
): Promise<void> {
    const accountIds = [...new Set(recipientAccountIds)].sort();
    if (accountIds.length === 0) return;
    const state = publicationPhase(tx);
    if (state.phase === 'publishing') {
        assertDeclaredPublication(state, accountIds);
        return;
    }
    recordPublicationAudience(state, accountIds);
    await acquireAccountSessionOwnerMetadataFencesInTx(tx, accountIds, options?.intent ?? 'content');
}

/**
 * Marks one shared Account projection changed for an explicit recipient set.
 *
 * Team and Home-governance mutations resolve their audiences transactionally.
 * Publishing those audiences one Account at a time makes the transaction grow
 * by two database round trips per viewer. This set-oriented owner performs
 * one PostgreSQL statement, or a fixed number of portable database
 * operations: increment every recipient cursor, read the resulting cursors,
 * then replace the one coalesced projection row for each Account. The Account
 * update is still the writer fence and all rows plus their content-free wakes
 * retain the surrounding transaction's commit boundary.
 *
 * Hint-bearing changes and other entity kinds take the ordered audience fence
 * before delegating to the point writer, which retains foreign-key and hint
 * coalescing ownership. Hint-free Session and Machine invalidation keep the
 * same foreign keys and provider-specific omitted-hint semantics as that writer.
 */
export async function markAccountsChanged(
    tx: Tx,
    params: Readonly<{
        accountIds: readonly string[];
        entityId: string;
        kind?: ChangeKind;
        hint?: unknown;
        hintForAccount?: (accountId: string) => unknown;
        /** This recipient's current-view publication replaces its duplicate viewer wake. */
        currentViewForAccount?: (accountId: string) => boolean;
    }>,
): Promise<AccountChangePublication[]> {
    const accountIds = [...new Set(params.accountIds
        .map((accountId) => (typeof accountId === "string" ? accountId.trim() : ""))
        .filter(Boolean))].sort();
    const entityId = typeof params.entityId === "string" ? params.entityId.trim() : "";
    const kind = params.kind ?? "account";
    if (!entityId) throw new Error("markAccountsChanged: entityId is required");
    if (accountIds.length === 0) return [];

    if (params.hint !== undefined || params.hintForAccount || params.currentViewForAccount
        || (kind !== "account" && kind !== "savedSecretResource" && kind !== "session" && kind !== "machine")) {
        // Project all caller-owned hints before locking any Account. Cursor
        // allocation and merge-sensitive hints remain solely point-writer-owned.
        const hints = new Map(accountIds.map(accountId => [accountId,
            params.hintForAccount ? params.hintForAccount(accountId) : params.hint]));
        const cursors: AccountChangePublication[] = [];
        for (const accountId of accountIds) {
            cursors.push(await markAccountChanged(tx, { accountId, kind, entityId, hint: hints.get(accountId),
                ...(params.currentViewForAccount?.(accountId) ? { currentViewSessionId: entityId } : {}) }));
        }
        return cursors;
    }

    return markAccountProjectionChanges(tx, kind, new Map([[entityId, accountIds]]));
}

/** Hint-free Session fanout allocates one distinct cursor per Account/entity pair. */
export async function markSessionAccountsChanged(
    tx: Tx,
    recipientsBySession: ReadonlyMap<string, readonly string[]>,
): Promise<AccountChangePublication[]> {
    return markAccountProjectionChanges(tx, "session", recipientsBySession);
}

/** Set-oriented projection publication with optional shared replacement hints.
 * Merge-sensitive and per-recipient hints remain point-writer-owned.
 */
export async function markAccountProjectionChanges(
    tx: Tx,
    kind: "account" | "savedSecretResource" | "session" | "machine",
    recipientsByEntity: ReadonlyMap<string, readonly string[]>,
    hint?: unknown,
): Promise<AccountChangePublication[]> {
    const capturedHint = hint === undefined ? undefined : structuredClone(compactHint(kind, hint));
    const recipients = new Map([...recipientsByEntity].map(([entityId, accountIds]) =>
        [entityId, [...new Set(accountIds)].sort()] as const));
    const accountIds = [...new Set([...recipients.values()].flat())].sort();
    const pending = accountIds.flatMap(accountId => [...recipients.keys()].sort()
        .filter(entityId => recipients.get(entityId)?.includes(accountId))
        .map(() => pendingCursor(accountId)));
    if (pending.length === 0) return [];
    const state = publicationPhase(tx);
    const publish = async (transaction: Tx) => {
        const cursors = await publishAccountProjectionChanges(transaction, kind, recipients, capturedHint);
        if (cursors.length !== pending.length) throw new Error('Account publication allocation count changed');
        cursors.forEach((row, index) => pending[index].resolve(row.cursor));
    };
    if (state.phase === 'publishing') {
        assertDeclaredPublication(state, accountIds);
        await publish(tx);
    } else {
        enqueueAccountChangePublication(tx, accountIds, publish);
    }
    return pending.map(row => row.publication);
}

async function publishAccountProjectionChanges(
    tx: Tx,
    kind: "account" | "savedSecretResource" | "session" | "machine",
    recipientsByEntity: ReadonlyMap<string, readonly string[]>,
    hint?: unknown,
): Promise<AccountChangeCursor[]> {
    const requests = [...recipientsByEntity.keys()].sort().flatMap(entityId =>
        [...new Set(recipientsByEntity.get(entityId))].sort().map(accountId => ({ accountId, entityId })));
    if (requests.length === 0) return [];
    const counts = new Map<string, number>();
    for (const request of requests) counts.set(request.accountId, (counts.get(request.accountId) ?? 0) + 1);
    const accountIds = [...counts.keys()].sort();
    const changedAt = new Date();
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    if (dialect === "postgres") {
        // The terminal publication owner already holds the complete ordered
        // Account writer fence; allocation must not acquire it again.
        // Existing Account batches advanced updatedAt through Prisma; Session
        // and Machine invalidation retain the PostgreSQL point writer's seq-only mutation.
        const rows = await tx.$queryRawUnsafe<Array<{ accountId: string; cursor: number | bigint }>>(
            `WITH requested AS (
                SELECT * FROM jsonb_to_recordset($1::jsonb) AS r("accountId" text, "entityId" text)
            ), totals AS (
                SELECT "accountId", count(*)::int AS total FROM requested GROUP BY "accountId"
            ), next AS (
                UPDATE "Account" SET "seq" = "seq" + totals.total,
                    "updatedAt" = CASE WHEN $2 IN ('session', 'machine') THEN "updatedAt" ELSE $3 END
                FROM totals WHERE "Account"."id" = totals."accountId"
                RETURNING "Account"."id", "Account"."seq"
            )
            INSERT INTO "AccountChange" (
                "accountId", "kind", "entityId", "cursor", "changedAt", "hint", "sessionId", "machineId"
            )
            SELECT next."id", $2, requested."entityId",
                next."seq" - totals.total + row_number() OVER (PARTITION BY next."id" ORDER BY requested."entityId"),
                $3, CASE WHEN $2 = 'session' THEN ${sessionCoalescedHintSql('NULL::jsonb', '$4::jsonb', 'next."seq" - totals.total + row_number() OVER (PARTITION BY next."id" ORDER BY requested."entityId")')} ELSE $4::jsonb END,
                CASE WHEN $2 = 'session' AND EXISTS (
                    SELECT 1 FROM "Session" WHERE "id" = requested."entityId"
                ) THEN requested."entityId" ELSE NULL END,
                CASE WHEN $2 = 'machine' AND EXISTS (
                    SELECT 1 FROM "Machine" WHERE "id" = requested."entityId"
                ) THEN requested."entityId" ELSE NULL END
            FROM requested JOIN next ON next."id" = requested."accountId"
                JOIN totals ON totals."accountId" = next."id"
            ON CONFLICT ("accountId", "kind", "entityId") DO UPDATE SET
                "cursor" = EXCLUDED."cursor",
                "changedAt" = EXCLUDED."changedAt",
                "hint" = CASE WHEN EXCLUDED."kind" = 'session' THEN
                    ${sessionCoalescedHintSql('"AccountChange"."hint"', 'EXCLUDED."hint"', 'EXCLUDED."cursor"')}
                    ELSE EXCLUDED."hint" END,
                "sessionId" = EXCLUDED."sessionId",
                "machineId" = EXCLUDED."machineId",
                "artifactId" = NULL,
                "accountPetPackageId" = NULL
            RETURNING "accountId", "cursor"`,
            JSON.stringify(requests), kind, changedAt, kind === 'session' ? JSON.stringify(sessionChangeHint(hint))
                : hint === undefined ? null : JSON.stringify(hint),
        );
        if (rows.length !== requests.length) {
            throw new Error("markAccountsChanged: every Account recipient must exist");
        }
        const cursors = rows.map(row => {
            const cursor = Number(row.cursor);
            if (!Number.isFinite(cursor)) {
                throw new Error("markAccountsChanged: failed to read every Account cursor");
            }
            return { accountId: row.accountId, cursor };
        }).sort((left, right) => left.accountId < right.accountId ? -1
            : left.accountId > right.accountId ? 1 : left.cursor - right.cursor);
        scheduleAccountProjectionWakes(tx, kind, requests, cursors, hint);
        return cursors;
    }

    await acquireAccountChangePublicationLocksInTx(tx, accountIds);
    const updated = await tx.$executeRawUnsafe(
        `UPDATE \`Account\` SET \`seq\` = \`seq\` + CASE \`id\`
            ${accountIds.map(() => "WHEN ? THEN ?").join(" ")} END, \`updatedAt\` = ?
            WHERE \`id\` IN (${accountIds.map(() => "?").join(", ")})`,
        ...accountIds.flatMap(accountId => [accountId, counts.get(accountId)!]), changedAt, ...accountIds,
    );
    if (updated !== accountIds.length) {
        throw new Error("markAccountsChanged: every Account recipient must exist");
    }

    const cursorRows = await tx.account.findMany({
        where: { id: { in: accountIds } },
        orderBy: { id: "asc" },
        select: { id: true, seq: true },
    });
    if (cursorRows.length !== accountIds.length) {
        throw new Error("markAccountsChanged: failed to read every Account cursor");
    }

    // The point writer's Prisma upsert omits an undefined hint on update.
    // Preserve retained Session/Machine hints after taking the same Account fence.
    const identities = requests.map(({ accountId, entityId }) => ({ accountId, kind, entityId }));
    const retainedEntityHints = kind === "session" || (kind === "machine" && hint === undefined)
        ? await tx.accountChange.findMany({
            where: { OR: identities },
            select: { accountId: true, entityId: true, hint: true },
        })
        : [];
    const hintByIdentity = new Map(retainedEntityHints.map(row => [JSON.stringify([row.accountId, row.entityId]), row.hint]));
    await tx.accountChange.deleteMany({
        where: { OR: identities },
    });
    const nextCursorByAccountId = new Map(cursorRows.map(row => [row.id, row.seq - counts.get(row.id)!]));
    const retainedSessionIds = kind === "session" ? new Set((await tx.session.findMany({
        where: { id: { in: [...recipientsByEntity.keys()] } }, select: { id: true },
    })).map(row => row.id)) : new Set<string>();
    const retainedMachineIds = kind === "machine" ? new Set((await tx.machine.findMany({
        where: { id: { in: [...recipientsByEntity.keys()] } }, select: { id: true },
    })).map(row => row.id)) : new Set<string>();
    const changes = requests.map(({ accountId, entityId }) => {
        const cursor = nextCursorByAccountId.get(accountId)! + 1;
        nextCursorByAccountId.set(accountId, cursor);
        return { accountId, kind, entityId, cursor, changedAt, hint,
            ...(kind === "session" ? { sessionId: retainedSessionIds.has(entityId) ? entityId : null } : {}),
            ...(kind === "machine" ? { machineId: retainedMachineIds.has(entityId) ? entityId : null } : {}),
            ...(kind === "session" || kind === "machine" ? {
                hint: kind === 'session'
                    ? mergeSessionCoalescedHint(hintByIdentity.get(JSON.stringify([accountId, entityId])),
                        hint === undefined ? { ...sessionChangeHint(retainSessionSourceChangeHint(hintByIdentity.get(JSON.stringify([accountId, entityId])))),
                            followReceiverAvailabilityChanged: false } : hint, cursor)
                    : hint === undefined ? hintByIdentity.get(JSON.stringify([accountId, entityId])) ?? undefined : hint,
            } : {}),
        };
    });
    await tx.accountChange.createMany({
        data: changes,
    });

    const cursors = changes.map(({ accountId, cursor }) => ({ accountId, cursor }))
        .sort((left, right) => left.accountId < right.accountId ? -1
            : left.accountId > right.accountId ? 1 : left.cursor - right.cursor);
    scheduleAccountProjectionWakes(tx, kind, requests, cursors, hint);
    return cursors;
}

export interface MarkAccountChangedParams {
    accountId: string;
    kind: ChangeKind;
    entityId: string;
    hint?: unknown;
    /** Retain Machine/other-Session wakes; the current-view publisher covers this Session's viewers. */
    currentViewSessionId?: string;
    /** The coordinator has already locked this existing activation receipt. */
    accountEncryptionTransitionActivation?: Readonly<{
        transitionId: string;
        activatedAt: Date;
        activatedAccountUpdatedAt: Date;
    }>;
}

export async function markAccountChanged(tx: Tx, params: MarkAccountChangedParams): Promise<AccountChangePublication> {
    // Validate before returning an intent, preserving refusal at the owning call.
    if (!params.accountId) throw new Error('markAccountChanged: accountId is required');
    const parsedKind = ChangeKindSchema.safeParse(params.kind);
    if (!parsedKind.success) throw new Error('markAccountChanged: kind is required');
    const kind = parsedKind.data;
    if (!params.entityId) throw new Error('markAccountChanged: entityId is required');
    if (kind === 'pluginDomain') {
        const parsedHint = PluginDomainChangeHintSchema.safeParse(params.hint);
        if (!parsedHint.success) throw new Error('markAccountChanged: pluginDomain hint is invalid');
        if (params.entityId !== buildPluginDomainAccountChangeEntityId(parsedHint.data)) {
            throw new Error('markAccountChanged: pluginDomain entityId does not match the hint identity');
        }
    }
    const captured: MarkAccountChangedParams = {
        accountId: params.accountId,
        kind,
        entityId: params.entityId,
        ...(params.currentViewSessionId ? { currentViewSessionId: params.currentViewSessionId } : {}),
        ...(params.hint === undefined ? {} : { hint: structuredClone(compactHint(kind, params.hint)) }),
        ...(params.accountEncryptionTransitionActivation ? {
            accountEncryptionTransitionActivation: structuredClone(params.accountEncryptionTransitionActivation),
        } : {}),
    };
    const pending = pendingCursor(captured.accountId);
    const state = publicationPhase(tx);
    const publish = async (transaction: Tx) => pending.resolve(await publishAccountChanged(transaction, captured));
    if (state.phase === 'publishing') {
        assertDeclaredPublication(state, [captured.accountId]);
        await publish(tx);
    } else {
        enqueueAccountChangePublication(tx, [captured.accountId], publish);
    }
    return pending.publication;
}

async function publishAccountChanged(
    tx: Tx,
    params: MarkAccountChangedParams,
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
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, "postgres"));
    if (dialect === "postgres" && typeof (tx as { $queryRawUnsafe?: unknown }).$queryRawUnsafe === "function") {
        // Terminal publication already holds PostgreSQL's Account writer fence.
        // Discussion and Session share the ORM hint merge. Artifact projection
        // and union stay in this statement beside the existing foreign-key read;
        // encoded members are classified only by the protocol reader.
        const persistedHint = kind === 'discussion'
            ? await coalesceDiscussionChangeHintInTx(tx, accountId, entityId, hint)
            : kind === 'session' ? await coalesceSessionProjectionChangeHintInTx(tx, accountId, entityId, hint)
            : hint;
        const rows = await (tx as {
            $queryRawUnsafe: <TRow>(query: string, ...values: unknown[]) => Promise<TRow[]>;
        }).$queryRawUnsafe<{ cursor: number | bigint; activationCount?: number; artifactKind?: unknown }>(
            `WITH next AS (
                UPDATE "Account"
                SET "seq" = "seq" + 1
                WHERE "id" = $1
                RETURNING "seq"
            ), artifact_row AS (
                SELECT "id", "kind" FROM "Artifact" WHERE "id" = $8
            ), published AS (
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
                CASE
                    WHEN $2 = 'session' THEN ${sessionCoalescedHintSql('NULL::jsonb', '$5::jsonb', 'next."seq"')}
                    WHEN $2 = 'artifact' THEN
                        (CASE WHEN jsonb_typeof($5::jsonb) = 'object' THEN $5::jsonb ELSE '{}'::jsonb END - 'artifactKinds')
                        || CASE
                            WHEN jsonb_typeof($5::jsonb) = 'object' AND $5::jsonb ? 'artifactKinds'
                            THEN CASE WHEN jsonb_typeof($5::jsonb->'artifactKinds') = 'array'
                                THEN jsonb_build_object('artifactKinds', $5::jsonb->'artifactKinds') ELSE '{}'::jsonb END
                            WHEN (SELECT "kind" FROM artifact_row) IS NOT NULL
                            THEN jsonb_build_object('artifactKinds', jsonb_build_array((SELECT "kind" FROM artifact_row)))
                            ELSE '{}'::jsonb
                        END
                    ELSE $5::jsonb
                END,
                CASE WHEN EXISTS (SELECT 1 FROM "Session" WHERE "id" = $6) THEN $6 ELSE NULL END,
                CASE WHEN EXISTS (SELECT 1 FROM "Machine" WHERE "id" = $7) THEN $7 ELSE NULL END,
                (SELECT "id" FROM artifact_row),
                CASE WHEN EXISTS (SELECT 1 FROM "AccountPetPackage" WHERE "id" = $9) THEN $9 ELSE NULL END
            FROM next
            ON CONFLICT ("accountId", "kind", "entityId")
            DO UPDATE SET
                "cursor" = EXCLUDED."cursor",
                "changedAt" = EXCLUDED."changedAt",
                "hint" = CASE
                    WHEN EXCLUDED."kind" = 'session' THEN
                        ${sessionCoalescedHintSql('"AccountChange"."hint"', 'EXCLUDED."hint"', 'EXCLUDED."cursor"')}
                    WHEN EXCLUDED."kind" = 'artifact' THEN
                        CASE WHEN
                            jsonb_array_length(CASE WHEN jsonb_typeof("AccountChange"."hint"->'artifactKinds') = 'array'
                                THEN "AccountChange"."hint"->'artifactKinds' ELSE '[]'::jsonb END) > 0
                            AND jsonb_array_length(CASE WHEN jsonb_typeof(EXCLUDED."hint"->'artifactKinds') = 'array'
                                THEN EXCLUDED."hint"->'artifactKinds' ELSE '[]'::jsonb END) > 0
                        THEN jsonb_set(EXCLUDED."hint", '{artifactKinds}', (
                            SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(
                                ("AccountChange"."hint"->'artifactKinds') || (EXCLUDED."hint"->'artifactKinds')
                            )
                        ))
                        ELSE EXCLUDED."hint" - 'artifactKinds' END
                    WHEN EXCLUDED."hint"->>'pluginDomain' = 'dataCollection'
                        AND jsonb_typeof(EXCLUDED."hint"->'indexChanges') = 'object'
                    THEN jsonb_set(EXCLUDED."hint", '{indexChanges,previousCursor}', to_jsonb("AccountChange"."cursor"))
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
            RETURNING "cursor"
            )
            ${params.accountEncryptionTransitionActivation ? `, activation AS (
                UPDATE "AccountEncryptionTransition" SET
                    "status" = 'activated',
                    "activeAccountId" = NULL,
                    "activatedAt" = $11,
                    "activatedAccountUpdatedAt" = $12,
                    "activatedAccountCursor" = published."cursor",
                    "activatedAccountVersion" = published."cursor"
                FROM published
                WHERE "AccountEncryptionTransition"."id" = $10
                    AND "AccountEncryptionTransition"."accountId" = $1
                    AND "AccountEncryptionTransition"."status" = 'authorized'
                RETURNING "AccountEncryptionTransition"."id"
            ) SELECT published."cursor", (SELECT "kind" FROM artifact_row) AS "artifactKind",
                (SELECT count(*)::int FROM activation) AS "activationCount" FROM published`
                : 'SELECT "cursor", (SELECT "kind" FROM artifact_row) AS "artifactKind" FROM published'}`,
            accountId,
            kind,
            entityId,
            now,
            persistedHint === undefined ? null : JSON.stringify(persistedHint),
            sessionId,
            machineId,
            artifactId,
            accountPetPackageId,
            ...(params.accountEncryptionTransitionActivation ? [
                params.accountEncryptionTransitionActivation.transitionId,
                params.accountEncryptionTransitionActivation.activatedAt,
                params.accountEncryptionTransitionActivation.activatedAccountUpdatedAt,
            ] : []),
        );
        const cursorValue = rows[0]?.cursor;
        const cursor = typeof cursorValue === "bigint" ? Number(cursorValue) : cursorValue;
        if (!Number.isFinite(cursor)) {
            throw new Error("markAccountChanged: failed to allocate cursor");
        }
        if (params.accountEncryptionTransitionActivation && rows[0]?.activationCount !== 1) {
            throw new Error('Account publication requires its prelocked activation receipt');
        }
        scheduleAccountChangeWake(tx, accountId, cursor, kind, [entityId], hint, params.currentViewSessionId,
            kind === 'artifact' ? artifactPublicationKinds(hint, rows[0]?.artifactKind) : undefined);
        return cursor;
    }

    // These nullable links detect orphaned changes; entityId/hint are the
    // durable removal invalidation. Match ON DELETE SET NULL when domain work
    // removed an entity after recording its publication intent.
    let artifactKinds: readonly string[] | null = null;
    const fk = await (async () => {
        if (sessionId) {
            const row = await tx.session.findUnique({ where: { id: sessionId }, select: { id: true } });
            return { sessionId: row?.id ?? null };
        }
        if (machineId) {
            const row = await tx.machine.findUnique({ where: { id: machineId }, select: { id: true } });
            return { machineId: row?.id ?? null };
        }
        if (artifactId) {
            const row = await tx.artifact.findUnique({ where: { id: artifactId }, select: { id: true, kind: true } });
            artifactKinds = artifactPublicationKinds(hint, row?.kind);
            return { artifactId: row?.id ?? null };
        }
        if (accountPetPackageId) {
            const row = await tx.accountPetPackage.findUnique({ where: { id: accountPetPackageId }, select: { id: true } });
            return { accountPetPackageId: row?.id ?? null };
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
    const parsedCollectionHint = kind === 'pluginDomain' ? PluginDomainChangeHintSchema.safeParse(hint) : undefined;
    const collectionHint = parsedCollectionHint?.success && parsedCollectionHint.data.pluginDomain === 'dataCollection'
        ? parsedCollectionHint.data : undefined;
    const current = collectionHint && !('full' in collectionHint)
        ? await tx.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId,
                    kind,
                    entityId,
                },
            },
            select: { hint: true, cursor: true },
        })
        : null;
    const preciseCollectionHint = collectionHint && 'indexChanges' in collectionHint && collectionHint.indexChanges
        ? { ...collectionHint, indexChanges: { ...collectionHint.indexChanges, previousCursor: current?.cursor ?? 0 } }
        : undefined;
    const persistedHint = kind === 'artifact'
        ? await coalesceArtifactChangeHintInTx(tx, accountId, entityId, hint, artifactKinds)
        : kind === 'discussion'
        ? await coalesceDiscussionChangeHintInTx(tx, accountId, entityId, hint)
        : kind === 'session' ? await coalesceSessionProjectionChangeHintInTx(tx, accountId, entityId, hint, cursor)
        : preciseCollectionHint ?? (current ? preserveCollectionFullHint(current.hint, hint) : hint);

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

    if (params.accountEncryptionTransitionActivation) {
        const updated = await tx.accountEncryptionTransition.updateMany({
            where: { id: params.accountEncryptionTransitionActivation.transitionId, accountId, status: 'authorized' },
            data: {
                status: 'activated', activeAccountId: null,
                activatedAt: params.accountEncryptionTransitionActivation.activatedAt,
                activatedAccountUpdatedAt: params.accountEncryptionTransitionActivation.activatedAccountUpdatedAt,
                activatedAccountCursor: cursor, activatedAccountVersion: cursor,
            },
        });
        if (updated.count !== 1) throw new Error('Account publication requires its prelocked activation receipt');
    }

    scheduleAccountChangeWake(tx, accountId, cursor, kind, [entityId], hint, params.currentViewSessionId, artifactKinds);
    return cursor;
}
