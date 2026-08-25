import type { Prisma } from "@prisma/client";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS,
    buildPluginDomainAccountChangeEntityId,
    pluginJsonValuesEqual,
    type AccountEncryptionMigrateCollectionStageItem,
    type PluginCollectionContentEnvelopeV1,
} from "@happier-dev/protocol";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

import { readMaterializedPluginCollectionContract } from "./contracts";
import {
    assertPluginCollectionStoredContentForAccountTransition,
    PluginCollectionMutationOperationError,
} from "./mutation";

const COLLECTION_TRANSITION_PAGE_SIZE =
    ACCOUNT_ENCRYPTION_MIGRATE_TRANSITION_COLLECTION_PAGE_MAX_ITEMS;
const textEncoder = new TextEncoder();

type CollectionIdentity = Readonly<{
    pluginId: string;
    collectionId: string;
    rowId: string;
}>;

export type PluginCollectionAccountEncryptionTransitionRow = Readonly<
    CollectionIdentity & {
        revision: number;
        sourceEnvelope: PluginCollectionContentEnvelopeV1;
        schemaVersion: number;
        contractDigest: string;
    }
>;

export type PluginCollectionAccountEncryptionTransitionCensus =
    | Readonly<{
        status: "complete";
        items: readonly PluginCollectionAccountEncryptionTransitionRow[];
        rowCount: number;
        sourceContentBytes: bigint;
        nextCursor?: CollectionIdentity;
    }>
    | Readonly<{
        status: "invalid_content";
        row: CollectionIdentity;
    }>
    | Readonly<{
        status: "identity_relocation_unsupported";
        row: CollectionIdentity;
    }>;

/**
 * Structural seam for the Protocol Collection directive. The Account
 * coordinator owns request parsing, stages, aggregate limits, confirmation,
 * and final mode activation; this adapter only consumes its closed exact
 * inventory inside that coordinator's fenced transaction.
 */
export type PluginCollectionAccountEncryptionTransitionDirective =
    | Readonly<{ action: "assert_empty" }>
    | Readonly<{
        action: "migrate";
        items: readonly AccountEncryptionMigrateCollectionStageItem[];
    }>;

export class PluginCollectionAccountEncryptionTransitionConflictError extends Error {
    constructor() {
        super("Collection account-encryption transition lost its row currentness precondition");
        this.name = "PluginCollectionAccountEncryptionTransitionConflictError";
    }
}

export type PluginCollectionAccountEncryptionTransitionResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>
    | Readonly<{ status: "identity_relocation_unsupported" }>;

/**
 * These values are supplied by the Account transition owner after its
 * measured aggregate/capacity decision. Collection deliberately has no
 * fallback ceiling and cannot apply an unbounded activation.
 */
export type PluginCollectionAccountEncryptionTransitionLimits = Readonly<{
    participantLimit: number;
    encodedByteLimit: bigint;
}>;

const pluginCollectionTransitionRowSelect = {
    id: true,
    pluginId: true,
    collectionId: true,
    rowId: true,
    revision: true,
    schemaVersion: true,
    contractId: true,
    contractDigest: true,
    contentEnvelope: true,
    contract: {
        select: {
            pluginId: true,
            collectionId: true,
            schemaVersion: true,
            contractDigest: true,
            normalizedSchema: true,
            indexes: true,
            relations: true,
            privacyProjection: true,
        },
    },
    projections: {
        select: {
            fieldId: true,
            typedEncodedValue: true,
            rowRevision: true,
        },
        orderBy: { fieldId: "asc" },
    },
} as const satisfies Prisma.PluginCollectionRowSelect;

type PersistedTransitionRow = Prisma.PluginCollectionRowGetPayload<{
    select: typeof pluginCollectionTransitionRowSelect;
}>;

type ValidatedTransitionRow = Readonly<{
    persisted: PersistedTransitionRow;
    sourceEnvelope: PluginCollectionContentEnvelopeV1;
    contract: ReturnType<typeof readMaterializedPluginCollectionContract>;
}>;

function identityOf(row: CollectionIdentity): CollectionIdentity {
    return {
        pluginId: row.pluginId,
        collectionId: row.collectionId,
        rowId: row.rowId,
    };
}

function identityKey(row: CollectionIdentity): string {
    return `${row.pluginId}\u0000${row.collectionId}\u0000${row.rowId}`;
}

function contentBytes(content: PluginCollectionContentEnvelopeV1): bigint {
    return BigInt(textEncoder.encode(JSON.stringify(content)).byteLength);
}

/**
 * The Collection owner defines the exact encoded-byte measurement used by the
 * Account transition capacity record. Keeping it here prevents the Account
 * coordinator from growing a second envelope-serialization rule.
 */
export function measurePluginCollectionAccountEncryptionTransitionContentBytes(
    content: PluginCollectionContentEnvelopeV1,
): bigint {
    return contentBytes(content);
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new PluginCollectionAccountEncryptionTransitionConflictError();
    }
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function afterIdentity(cursor: CollectionIdentity): {
    OR: Prisma.PluginCollectionRowWhereInput[];
} {
    return {
        OR: [
            { pluginId: { gt: cursor.pluginId } },
            {
                pluginId: cursor.pluginId,
                collectionId: { gt: cursor.collectionId },
            },
            {
                pluginId: cursor.pluginId,
                collectionId: cursor.collectionId,
                rowId: { gt: cursor.rowId },
            },
        ],
    };
}

async function readValidatedTransitionPageInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sourceMode: "plain" | "e2ee";
    cursor?: CollectionIdentity;
}>): Promise<
    | Readonly<{
        status: "complete";
        rows: readonly ValidatedTransitionRow[];
        nextCursor?: CollectionIdentity;
    }>
    | Readonly<{ status: "invalid_content"; row: CollectionIdentity }>
    | Readonly<{ status: "identity_relocation_unsupported"; row: CollectionIdentity }>
> {
    const residualTombstone = await params.tx.pluginCollectionRow.findFirst({
        where: {
            accountId: params.accountId,
            deletedAt: { not: null },
            contentEnvelope: { not: getActivePrismaRuntime().JsonNull },
        },
        orderBy: [
            { pluginId: "asc" },
            { collectionId: "asc" },
            { rowId: "asc" },
        ],
        select: {
            pluginId: true,
            collectionId: true,
            rowId: true,
            contentEnvelope: true,
        },
    });
    if (residualTombstone) {
        return { status: "invalid_content", row: identityOf(residualTombstone) };
    }

    const page = await params.tx.pluginCollectionRow.findMany({
        where: {
            accountId: params.accountId,
            deletedAt: null,
            ...(params.cursor ? afterIdentity(params.cursor) : {}),
        },
        orderBy: [
            { pluginId: "asc" },
            { collectionId: "asc" },
            { rowId: "asc" },
        ],
        take: COLLECTION_TRANSITION_PAGE_SIZE + 1,
        select: pluginCollectionTransitionRowSelect,
    });
    const currentPage = page.slice(0, COLLECTION_TRANSITION_PAGE_SIZE);
    const rows: ValidatedTransitionRow[] = [];
    for (const row of currentPage) {
        const identity = identityOf(row);
        try {
            const contract = readMaterializedPluginCollectionContract(row.contract);
            if (
                row.pluginId !== contract.pluginId
                || row.collectionId !== contract.collectionId
                || row.schemaVersion !== contract.schemaVersion
                || row.contractDigest !== contract.contractDigest
                || row.projections.some((projection) => projection.rowRevision !== row.revision)
            ) {
                return { status: "invalid_content", row: identity };
            }
            // A live row of a collection that declares mode-derived identity
            // cannot survive the transition. Its address and its indexed
            // identity values are derived from the Account's encryption mode,
            // and the platform holds neither the Account key material nor the
            // plugin's private components, so it cannot compute where the row
            // would have to move. Refusing here — before the capacity ceiling
            // and before any writer — is the only outcome that keeps the row
            // reachable at the address its own plugin can still derive.
            if (contract.identityFields.length > 0) {
                return { status: "identity_relocation_unsupported", row: identity };
            }
            const stored = assertPluginCollectionStoredContentForAccountTransition({
                contract,
                encryptionMode: params.sourceMode,
                rowId: row.rowId,
                contentEnvelope: row.contentEnvelope,
                projections: row.projections,
            });
            rows.push({
                persisted: row,
                sourceEnvelope: stored.content,
                contract,
            });
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                return { status: "invalid_content", row: identity };
            }
            return { status: "invalid_content", row: identity };
        }
    }
    const last = currentPage.at(-1);
    return {
        status: "complete",
        rows,
        ...(page.length > COLLECTION_TRANSITION_PAGE_SIZE && last
            ? { nextCursor: identityOf(last) }
            : {}),
    };
}

async function loadBoundedValidatedTransitionRowsInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    sourceMode: "plain" | "e2ee";
    limits: PluginCollectionAccountEncryptionTransitionLimits;
}>): Promise<
    | Readonly<{ status: "complete"; rows: readonly ValidatedTransitionRow[] }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content"; row: CollectionIdentity }>
    | Readonly<{ status: "identity_relocation_unsupported"; row: CollectionIdentity }>
> {
    const rows: ValidatedTransitionRow[] = [];
    let sourceContentBytes = 0n;
    let cursor: CollectionIdentity | undefined;
    for (;;) {
        const page = await readValidatedTransitionPageInTx({ ...params, ...(cursor ? { cursor } : {}) });
        if (page.status === "invalid_content") return page;
        if (page.status === "identity_relocation_unsupported") return page;
        for (const row of page.rows) {
            rows.push(row);
            sourceContentBytes += contentBytes(row.sourceEnvelope);
            if (
                rows.length > params.limits.participantLimit
                || sourceContentBytes > params.limits.encodedByteLimit
            ) {
                return { status: "migration_incomplete" };
            }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
    }
    return { status: "complete", rows };
}

/**
 * Read-only exact live-row census for the Account-owned transition prepare
 * path. It exposes at most one fixed 500-row keyset page. The Account owner
 * accumulates/persists aggregate measurements and decides capacity; this
 * domain never creates an unbounded inventory or a fallback limit.
 */
export async function inspectPluginCollectionAccountEncryptionTransitionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        sourceMode: "plain" | "e2ee";
        cursor?: CollectionIdentity;
    }>,
): Promise<PluginCollectionAccountEncryptionTransitionCensus> {
    const loaded = await readValidatedTransitionPageInTx(params);
    if (loaded.status === "invalid_content") return loaded;
    if (loaded.status === "identity_relocation_unsupported") return loaded;
    const items = loaded.rows.map((row) => ({
        ...identityOf(row.persisted),
        revision: row.persisted.revision,
        sourceEnvelope: row.sourceEnvelope,
        schemaVersion: row.persisted.schemaVersion,
        contractDigest: row.persisted.contractDigest,
    }));
    return {
        status: "complete",
        items,
        rowCount: items.length,
        sourceContentBytes: items.reduce(
            (total, row) => total + contentBytes(row.sourceEnvelope),
            0n,
        ),
        ...(loaded.nextCursor ? { nextCursor: loaded.nextCursor } : {}),
    };
}

export type PluginCollectionAccountEncryptionTransitionStageValidationResult =
    | Readonly<{
        status: "validated";
        items: readonly Readonly<{
            item: AccountEncryptionMigrateCollectionStageItem;
            sourceEncodedBytes: bigint;
            targetEncodedBytes: bigint;
        }>[];
    }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>
    | Readonly<{ status: "identity_relocation_unsupported" }>;

/**
 * Validates a bounded candidate stage through the existing Collection
 * envelope/contract owner without writing row content. The Account coordinator
 * still owns the transition record and aggregate stage state; this adapter
 * merely canonicalizes the exact facts it is allowed to persist for a later
 * all-row CAS activation.
 */
export async function validatePluginCollectionAccountEncryptionTransitionStageInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        limits: PluginCollectionAccountEncryptionTransitionLimits;
        items: readonly AccountEncryptionMigrateCollectionStageItem[];
    }>,
): Promise<PluginCollectionAccountEncryptionTransitionStageValidationResult> {
    if (
        !Number.isSafeInteger(params.limits.participantLimit)
        || params.limits.participantLimit < 0
        || params.limits.encodedByteLimit < 0n
        || params.items.length > params.limits.participantLimit
    ) {
        return { status: "invalid_content" };
    }
    const loaded = await loadBoundedValidatedTransitionRowsInTx({
        tx: params.tx,
        accountId: params.accountId,
        sourceMode: params.fromMode,
        limits: params.limits,
    });
    if (loaded.status === "invalid_content") return { status: "invalid_content" };
    if (loaded.status === "identity_relocation_unsupported") {
        return { status: "identity_relocation_unsupported" };
    }
    if (loaded.status === "migration_incomplete") {
        return { status: "migration_incomplete" };
    }

    const requestedByIdentity = new Map(
        params.items.map((item) => [identityKey(item), item] as const),
    );
    if (requestedByIdentity.size !== params.items.length) {
        return { status: "migration_incomplete" };
    }

    const validated: Array<Readonly<{
        item: AccountEncryptionMigrateCollectionStageItem;
        sourceEncodedBytes: bigint;
        targetEncodedBytes: bigint;
    }>> = [];
    let targetEncodedBytes = 0n;
    for (const row of loaded.rows) {
        const requested = requestedByIdentity.get(identityKey(row.persisted));
        if (!requested) continue;
        if (
            requested.expectedRevision !== row.persisted.revision
            || requested.schemaVersion !== row.persisted.schemaVersion
            || requested.contractDigest !== row.persisted.contractDigest
            || !pluginJsonValuesEqual(requested.sourceEnvelope, row.sourceEnvelope)
        ) {
            return { status: "migration_incomplete" };
        }
        try {
            const target = assertPluginCollectionStoredContentForAccountTransition({
                contract: row.contract,
                encryptionMode: params.toMode,
                rowId: row.persisted.rowId,
                contentEnvelope: requested.targetEnvelope,
                projections: row.persisted.projections,
            });
            const targetBytes = contentBytes(target.content);
            targetEncodedBytes += targetBytes;
            if (targetEncodedBytes > params.limits.encodedByteLimit) {
                return { status: "migration_incomplete" };
            }
            validated.push({
                item: {
                    pluginId: row.persisted.pluginId,
                    collectionId: row.persisted.collectionId,
                    rowId: row.persisted.rowId,
                    expectedRevision: row.persisted.revision,
                    sourceEnvelope: row.sourceEnvelope,
                    targetEnvelope: target.content,
                    schemaVersion: row.persisted.schemaVersion,
                    contractDigest: row.persisted.contractDigest,
                },
                sourceEncodedBytes: contentBytes(row.sourceEnvelope),
                targetEncodedBytes: targetBytes,
            });
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                return { status: "invalid_content" };
            }
            return { status: "invalid_content" };
        }
    }
    if (validated.length !== params.items.length) {
        return { status: "migration_incomplete" };
    }
    return { status: "validated", items: validated };
}

type IndexedCollectionGroup = Readonly<{
    key: string;
    pluginId: string;
    collectionId: string;
    contractId: string;
    contractDigest: string;
    rows: readonly ValidatedTransitionRow[];
}>;

function groupRowsByCollection(rows: readonly ValidatedTransitionRow[]): readonly IndexedCollectionGroup[] {
    const groups = new Map<string, {
        pluginId: string;
        collectionId: string;
        contractId: string;
        contractDigest: string;
        rows: ValidatedTransitionRow[];
    }>();
    for (const row of rows) {
        const key = [
            row.persisted.pluginId,
            row.persisted.collectionId,
            row.persisted.contractId,
            row.persisted.contractDigest,
        ].join("\u0000");
        const group = groups.get(key);
        if (group) {
            group.rows.push(row);
            continue;
        }
        groups.set(key, {
            pluginId: row.persisted.pluginId,
            collectionId: row.persisted.collectionId,
            contractId: row.persisted.contractId,
            contractDigest: row.persisted.contractDigest,
            rows: [row],
        });
    }
    return [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, group]) => ({ key, ...group }));
}

/**
 * Applies a fully staged Collection directive inside the existing Account
 * coordinator transaction. The caller must already hold the Account-first
 * fence and pass its authoritative source mode; this adapter deliberately
 * owns neither a route nor transition lifecycle/activation authority.
 */
export async function applyPluginCollectionAccountEncryptionTransitionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        fromMode: "plain" | "e2ee";
        toMode: "plain" | "e2ee";
        limits: PluginCollectionAccountEncryptionTransitionLimits;
        directive: PluginCollectionAccountEncryptionTransitionDirective;
    }>,
): Promise<PluginCollectionAccountEncryptionTransitionResult> {
    if (
        !Number.isSafeInteger(params.limits.participantLimit)
        || params.limits.participantLimit < 0
        || params.limits.encodedByteLimit < 0n
    ) {
        return { status: "invalid_content" };
    }
    const loaded = await loadBoundedValidatedTransitionRowsInTx({
        tx: params.tx,
        accountId: params.accountId,
        sourceMode: params.fromMode,
        limits: params.limits,
    });
    if (loaded.status === "invalid_content") return { status: "invalid_content" };
    if (loaded.status === "identity_relocation_unsupported") {
        return { status: "identity_relocation_unsupported" };
    }
    if (loaded.status === "migration_incomplete") {
        return { status: "migration_incomplete" };
    }
    if (params.directive.action === "assert_empty") {
        return loaded.rows.length === 0
            ? { status: "applied" }
            : { status: "migration_incomplete" };
    }

    const targetsByIdentity = new Map(
        params.directive.items.map((item) => [identityKey(item), item] as const),
    );
    if (
        targetsByIdentity.size !== params.directive.items.length
        || targetsByIdentity.size !== loaded.rows.length
        || params.directive.items.length > params.limits.participantLimit
    ) {
        return { status: "migration_incomplete" };
    }

    let targetContentBytes = 0n;

    const targetContentByRowId = new Map<string, PluginCollectionContentEnvelopeV1>();
    for (const row of loaded.rows) {
        const item = targetsByIdentity.get(identityKey(row.persisted));
        if (!item) return { status: "migration_incomplete" };
        if (
            item.expectedRevision !== row.persisted.revision
            || item.schemaVersion !== row.persisted.schemaVersion
            || item.contractDigest !== row.persisted.contractDigest
            || !pluginJsonValuesEqual(item.sourceEnvelope, row.sourceEnvelope)
        ) {
            return { status: "migration_incomplete" };
        }
        try {
            const target = assertPluginCollectionStoredContentForAccountTransition({
                contract: row.contract,
                encryptionMode: params.toMode,
                rowId: row.persisted.rowId,
                contentEnvelope: item.targetEnvelope,
                projections: row.persisted.projections,
            });
            targetContentBytes += contentBytes(target.content);
            if (targetContentBytes > params.limits.encodedByteLimit) {
                return { status: "migration_incomplete" };
            }
            targetContentByRowId.set(row.persisted.id, target.content);
        } catch (error) {
            if (error instanceof PluginCollectionMutationOperationError) {
                return { status: "invalid_content" };
            }
            return { status: "invalid_content" };
        }
    }

    const groups = groupRowsByCollection(loaded.rows);
    const maximumRevisionByCollection = new Map<string, number>();
    for (const row of loaded.rows) {
        const key = `${row.persisted.pluginId}\u0000${row.persisted.collectionId}`;
        maximumRevisionByCollection.set(
            key,
            Math.max(
                maximumRevisionByCollection.get(key) ?? 0,
                row.persisted.revision,
            ),
        );
    }
    const allIndexStates = await params.tx.pluginCollectionIndexState.findMany({
        where: { accountId: params.accountId },
        select: {
            id: true,
            pluginId: true,
            collectionId: true,
            contractId: true,
            contractDigest: true,
            buildState: true,
            indexId: true,
            indexedThroughRevision: true,
        },
    });
    const allSourceRelations = await params.tx.pluginCollectionRelation.findMany({
        where: {
            accountId: params.accountId,
            sourceRowDbId: { in: loaded.rows.map((row) => row.persisted.id) },
            deletedAt: null,
        },
        select: { sourceRowDbId: true, sourceRevision: true },
    });
    const relationsByRowId = new Map<string, number[]>();
    for (const relation of allSourceRelations) {
        const revisions = relationsByRowId.get(relation.sourceRowDbId) ?? [];
        revisions.push(relation.sourceRevision);
        relationsByRowId.set(relation.sourceRowDbId, revisions);
    }

    const statesByGroup = new Map<string, typeof allIndexStates>();
    for (const group of groups) {
        const states = allIndexStates.filter((state) => (
            state.pluginId === group.pluginId
            && state.collectionId === group.collectionId
            && state.contractId === group.contractId
            && state.contractDigest === group.contractDigest
        ));
        const expectedIndexIds = new Set(group.rows[0]!.contract.indexes.map((index) => index.id));
        if (
            states.length !== expectedIndexIds.size
            || states.some((state) => (
                state.buildState !== "ready"
                || state.indexedThroughRevision === null
                || !expectedIndexIds.has(state.indexId)
            ))
        ) {
            return { status: "invalid_content" };
        }
        const maximumRevision = maximumRevisionByCollection.get(
            `${group.pluginId}\u0000${group.collectionId}`,
        );
        if (maximumRevision === undefined) {
            throw new PluginCollectionAccountEncryptionTransitionConflictError();
        }
        if (states.some((state) => state.indexedThroughRevision !== maximumRevision)) {
            return { status: "invalid_content" };
        }
        statesByGroup.set(group.key, states);
    }

    for (const row of loaded.rows) {
        if ((relationsByRowId.get(row.persisted.id) ?? []).some((revision) => revision !== row.persisted.revision)) {
            return { status: "invalid_content" };
        }
    }

    for (const group of groups) {
        const states = statesByGroup.get(group.key) ?? [];
        if (states.length === 0 || group.rows.length === 0) continue;
        const entries = await params.tx.pluginCollectionIndexEntry.findMany({
            where: {
                indexStateId: { in: states.map((state) => state.id) },
                rowId: { in: group.rows.map((row) => row.persisted.rowId) },
            },
            select: { indexStateId: true, rowId: true, rowRevision: true },
        });
        if (entries.length !== states.length * group.rows.length) {
            return { status: "invalid_content" };
        }
        const expectedEntryKeys = new Set<string>();
        // One pass over the group instead of a linear scan per entry: the
        // entry set is `states.length * group.rows.length`, so the scan made
        // verification quadratic in the number of rows an Account holds.
        const groupRowsByRowId = new Map<string, (typeof group.rows)[number]>();
        for (const state of states) {
            for (const row of group.rows) {
                expectedEntryKeys.add(`${state.id}\u0000${row.persisted.rowId}`);
            }
        }
        for (const row of group.rows) {
            if (!groupRowsByRowId.has(row.persisted.rowId)) {
                groupRowsByRowId.set(row.persisted.rowId, row);
            }
        }
        for (const entry of entries) {
            const expectedRow = groupRowsByRowId.get(entry.rowId);
            if (
                !expectedRow
                || entry.rowRevision !== expectedRow.persisted.revision
                || !expectedEntryKeys.delete(`${entry.indexStateId}\u0000${entry.rowId}`)
            ) {
                return { status: "invalid_content" };
            }
        }
        if (expectedEntryKeys.size !== 0) return { status: "invalid_content" };
    }

    // The first group that holds a row, resolved once. The row loop below used
    // to rescan every group's rows per row, which is the same quadratic shape
    // as the entry verification above.
    const firstGroupByRowDbId = new Map<string, (typeof groups)[number]>();
    for (const group of groups) {
        for (const candidate of group.rows) {
            if (!firstGroupByRowDbId.has(candidate.persisted.id)) {
                firstGroupByRowDbId.set(candidate.persisted.id, group);
            }
        }
    }

    for (const row of loaded.rows) {
        const target = targetContentByRowId.get(row.persisted.id);
        if (!target) throw new PluginCollectionAccountEncryptionTransitionConflictError();
        const updated = await params.tx.pluginCollectionRow.updateMany({
            where: {
                id: row.persisted.id,
                accountId: params.accountId,
                revision: row.persisted.revision,
                deletedAt: null,
            },
            data: {
                contentEnvelope: toPrismaJson(target),
                revision: { increment: 1 },
            },
        });
        if (updated.count !== 1) {
            throw new PluginCollectionAccountEncryptionTransitionConflictError();
        }
        const projections = await params.tx.pluginCollectionProjection.updateMany({
            where: {
                rowDbId: row.persisted.id,
                rowRevision: row.persisted.revision,
            },
            data: { rowRevision: row.persisted.revision + 1 },
        });
        if (projections.count !== row.persisted.projections.length) {
            throw new PluginCollectionAccountEncryptionTransitionConflictError();
        }
        const relations = await params.tx.pluginCollectionRelation.updateMany({
            where: {
                sourceRowDbId: row.persisted.id,
                sourceRevision: row.persisted.revision,
                deletedAt: null,
            },
            data: { sourceRevision: row.persisted.revision + 1 },
        });
        if (relations.count !== (relationsByRowId.get(row.persisted.id) ?? []).length) {
            throw new PluginCollectionAccountEncryptionTransitionConflictError();
        }
        const owningGroup = firstGroupByRowDbId.get(row.persisted.id);
        if (owningGroup) {
            for (const state of statesByGroup.get(owningGroup.key) ?? []) {
                const entries = await params.tx.pluginCollectionIndexEntry.updateMany({
                    where: {
                        indexStateId: state.id,
                        rowId: row.persisted.rowId,
                        rowRevision: row.persisted.revision,
                    },
                    data: { rowRevision: row.persisted.revision + 1 },
                });
                if (entries.count !== 1) {
                    throw new PluginCollectionAccountEncryptionTransitionConflictError();
                }
            }
        }
    }

    for (const group of groups) {
        const states = statesByGroup.get(group.key) ?? [];
        const currentMaximumRevision = maximumRevisionByCollection.get(
            `${group.pluginId}\u0000${group.collectionId}`,
        );
        if (currentMaximumRevision === undefined) {
            throw new PluginCollectionAccountEncryptionTransitionConflictError();
        }
        const revision = currentMaximumRevision + 1;
        if (states.length > 0) {
            const readiness = await params.tx.pluginCollectionIndexState.updateMany({
                where: {
                    id: { in: states.map((state) => state.id) },
                    buildState: "ready",
                },
                data: { indexedThroughRevision: revision },
            });
            if (readiness.count !== states.length) {
                throw new PluginCollectionAccountEncryptionTransitionConflictError();
            }
        }
    }

    // AccountChange identity is one plugin/collection entity, even when
    // retained rows span several compatible contracts. Keep one full reread
    // hint and choose its representative digest deterministically; the CLI
    // broker projects that collection-level hint to each active contract.
    const changesByCollection = new Map<string, {
        pluginId: string;
        collectionId: string;
        contractDigest: string;
        revision: number;
    }>();
    for (const row of loaded.rows) {
        const key = `${row.persisted.pluginId}\u0000${row.persisted.collectionId}`;
        const candidate = {
            pluginId: row.persisted.pluginId,
            collectionId: row.persisted.collectionId,
            contractDigest: row.persisted.contractDigest,
            revision: row.persisted.revision + 1,
        };
        const existing = changesByCollection.get(key);
        if (
            !existing
            || candidate.revision > existing.revision
            || (
                candidate.revision === existing.revision
                && candidate.contractDigest > existing.contractDigest
            )
        ) {
            changesByCollection.set(key, candidate);
        }
    }
    for (const change of [...changesByCollection.values()].sort((left, right) => (
        left.pluginId.localeCompare(right.pluginId)
        || left.collectionId.localeCompare(right.collectionId)
    ))) {
        const hint = {
            pluginDomain: "dataCollection" as const,
            pluginId: change.pluginId,
            collectionId: change.collectionId,
            contractDigest: change.contractDigest,
            revision: change.revision,
            full: true as const,
        };
        await markAccountChanged(params.tx, {
            accountId: params.accountId,
            kind: "pluginDomain",
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
    }
    return { status: "applied" };
}
