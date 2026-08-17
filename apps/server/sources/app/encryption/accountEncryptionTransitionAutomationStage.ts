import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
    inspectAutomationAccountEncryptionTransitionInTx,
    type AutomationAccountEncryptionTransitionInventoryItem,
    type AutomationAccountEncryptionTransitionSourceCursor,
    type AutomationAccountEncryptionTransitionStageItem,
} from "@/app/automations/automationCrudService";
import type { Tx } from "@/storage/inTx";
import { getActivePrismaRuntime, getDbProviderFromEnv } from "@/storage/prisma";

export type AccountEncryptionTransitionAutomationStageState = Readonly<{
    transitionId: string;
    sourceParticipantCount: number;
    sourceRunCount: number;
    sourceEncodedBytes: bigint;
    stagedParticipantCount: number;
    stagedRunCount: number;
    stagedSourceBytes: bigint;
    stagedTargetBytes: bigint;
}>;

export type AccountEncryptionTransitionAutomationStoredStage = Readonly<{
    id: string;
    transitionId: string;
    participantKind: "definition" | "run";
    participantId: string;
    automationId: string;
    sourceRevision: number;
    sourceContent: string;
    targetContent: string | null;
    sourceEncodedBytes: bigint;
    targetEncodedBytes: bigint | null;
}>;

export type AccountEncryptionTransitionAutomationStageCursor = Readonly<{
    participantKind: "definition" | "run";
    participantId: string;
}>;

export type AccountEncryptionTransitionAutomationStagePage = Readonly<{
    stages: readonly AccountEncryptionTransitionAutomationStoredStage[];
    nextCursor?: AccountEncryptionTransitionAutomationStageCursor;
}>;

type RawStageClient = Pick<Tx, "$queryRaw" | "$executeRaw">;

const StageAutomationIdSchema = z.string().min(1).max(256);
const StageAutomationRevisionSchema = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER);
const StageAutomationStoredStringSchema = z.string().min(1).max(400_000);
const StageAutomationDefinitionContentSchema = z.object({
    templateCiphertext: z.string().min(1).max(220_000),
    triggerDefinitionEnvelope: StageAutomationStoredStringSchema.nullable(),
}).strict();
const StageAutomationRunSourceContentSchema = z.object({
    triggerEvidenceEnvelope: z.string().min(1).max(220_000).nullable(),
    occurrenceEvidenceEqualityTag: z.string().min(1).max(256).nullable(),
    executionInputEnvelope: z.string().min(1).max(220_512).nullable(),
    resultEnvelope: StageAutomationStoredStringSchema.nullable(),
    replyContextEnvelope: StageAutomationStoredStringSchema.nullable(),
    replyHandoffReceiptEnvelope: StageAutomationStoredStringSchema.nullable(),
    summaryCiphertext: z.string().min(1).max(220_000).nullable(),
}).strict();
const StageAutomationRunTargetContentSchema = z.object({
    triggerEvidenceEnvelope: z.string().min(1).max(220_000).nullable(),
    occurrenceEvidenceEqualityTag: z.string().min(1).max(256).nullable(),
    executionInputEnvelope: z.string().min(1).max(220_512).nullable(),
    resultEnvelope: StageAutomationStoredStringSchema.nullable(),
    replyContextEnvelope: StageAutomationStoredStringSchema.nullable(),
    replyHandoffReceiptEnvelope: StageAutomationStoredStringSchema.nullable(),
}).strict();
const StageAutomationInventoryItemSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("definition"),
        automationId: StageAutomationIdSchema,
        revision: StageAutomationRevisionSchema,
        source: StageAutomationDefinitionContentSchema,
    }).strict(),
    z.object({
        kind: z.literal("run"),
        runId: StageAutomationIdSchema,
        automationId: StageAutomationIdSchema,
        revision: StageAutomationRevisionSchema,
        originKind: z.enum(["scheduled", "manual", "pluginEvent", "conversation"]),
        occurrenceKey: z.string().min(1).max(256).nullable(),
        source: StageAutomationRunSourceContentSchema,
    }).strict(),
]);
const StageAutomationStageItemSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("definition"),
        automationId: StageAutomationIdSchema,
        expectedRevision: StageAutomationRevisionSchema,
        source: StageAutomationDefinitionContentSchema,
        target: StageAutomationDefinitionContentSchema,
    }).strict(),
    z.object({
        kind: z.literal("run"),
        runId: StageAutomationIdSchema,
        automationId: StageAutomationIdSchema,
        expectedRevision: StageAutomationRevisionSchema,
        originKind: z.enum(["scheduled", "manual", "pluginEvent", "conversation"]),
        occurrenceKey: z.string().min(1).max(256).nullable(),
        source: StageAutomationRunSourceContentSchema,
        target: StageAutomationRunTargetContentSchema,
    }).strict(),
]);

function transitionAutomationStageSql() {
    const prisma = getActivePrismaRuntime();
    const quote = getDbProviderFromEnv(process.env, "postgres") === "mysql"
        ? "`"
        : "\"";
    const identifier = (value: string) => prisma.raw(`${quote}${value}${quote}`);
    return {
        prisma,
        stateTable: identifier("AccountEncryptionTransitionAutomationStageState"),
        stageTable: identifier("AccountEncryptionTransitionAutomationStage"),
        id: identifier("id"),
        transitionId: identifier("transitionId"),
        sourceParticipantCount: identifier("sourceParticipantCount"),
        sourceRunCount: identifier("sourceRunCount"),
        sourceEncodedBytes: identifier("sourceEncodedBytes"),
        stagedParticipantCount: identifier("stagedParticipantCount"),
        stagedRunCount: identifier("stagedRunCount"),
        stagedSourceBytes: identifier("stagedSourceBytes"),
        stagedTargetBytes: identifier("stagedTargetBytes"),
        participantKind: identifier("participantKind"),
        participantId: identifier("participantId"),
        automationId: identifier("automationId"),
        sourceRevision: identifier("sourceRevision"),
        sourceContent: identifier("sourceContent"),
        targetContent: identifier("targetContent"),
        targetEncodedBytes: identifier("targetEncodedBytes"),
        createdAt: identifier("createdAt"),
        updatedAt: identifier("updatedAt"),
    };
}

function nonNegativeBigInt(value: unknown): bigint | null {
    if (typeof value === "bigint") return value >= 0n ? value : null;
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0
            ? BigInt(value)
            : null;
    }
    if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
        return BigInt(value);
    }
    return null;
}

const RawStageStateSchema = z.object({
    transitionId: z.string().uuid(),
    sourceParticipantCount: z.number().int().nonnegative(),
    sourceRunCount: z.number().int().nonnegative(),
    sourceEncodedBytes: z.union([z.bigint(), z.number(), z.string()]),
    stagedParticipantCount: z.number().int().nonnegative(),
    stagedRunCount: z.number().int().nonnegative(),
    stagedSourceBytes: z.union([z.bigint(), z.number(), z.string()]),
    stagedTargetBytes: z.union([z.bigint(), z.number(), z.string()]),
}).strict();

const RawStoredStageSchema = z.object({
    id: z.string().uuid(),
    transitionId: z.string().uuid(),
    participantKind: z.enum(["definition", "run"]),
    participantId: z.string().min(1).max(256),
    automationId: z.string().min(1).max(256),
    sourceRevision: z.number().int().nonnegative(),
    sourceContent: z.string().min(1),
    targetContent: z.string().min(1).nullable(),
    sourceEncodedBytes: z.union([z.bigint(), z.number(), z.string()]),
    targetEncodedBytes: z.union([z.bigint(), z.number(), z.string()]).nullable(),
}).strict();

function parseStageState(value: unknown): AccountEncryptionTransitionAutomationStageState | null {
    const parsed = RawStageStateSchema.safeParse(value);
    if (!parsed.success) return null;
    const sourceEncodedBytes = nonNegativeBigInt(parsed.data.sourceEncodedBytes);
    const stagedSourceBytes = nonNegativeBigInt(parsed.data.stagedSourceBytes);
    const stagedTargetBytes = nonNegativeBigInt(parsed.data.stagedTargetBytes);
    if (
        sourceEncodedBytes === null
        || stagedSourceBytes === null
        || stagedTargetBytes === null
        || parsed.data.sourceRunCount > parsed.data.sourceParticipantCount
        || parsed.data.stagedRunCount > parsed.data.stagedParticipantCount
    ) {
        return null;
    }
    return {
        transitionId: parsed.data.transitionId,
        sourceParticipantCount: parsed.data.sourceParticipantCount,
        sourceRunCount: parsed.data.sourceRunCount,
        sourceEncodedBytes,
        stagedParticipantCount: parsed.data.stagedParticipantCount,
        stagedRunCount: parsed.data.stagedRunCount,
        stagedSourceBytes,
        stagedTargetBytes,
    };
}

function parseStoredStage(value: unknown): AccountEncryptionTransitionAutomationStoredStage | null {
    const parsed = RawStoredStageSchema.safeParse(value);
    if (!parsed.success) return null;
    const sourceEncodedBytes = nonNegativeBigInt(parsed.data.sourceEncodedBytes);
    const targetEncodedBytes = parsed.data.targetEncodedBytes === null
        ? null
        : nonNegativeBigInt(parsed.data.targetEncodedBytes);
    if (
        sourceEncodedBytes === null
        || (parsed.data.targetEncodedBytes !== null && targetEncodedBytes === null)
        || (parsed.data.targetContent === null) !== (targetEncodedBytes === null)
    ) {
        return null;
    }
    return {
        id: parsed.data.id,
        transitionId: parsed.data.transitionId,
        participantKind: parsed.data.participantKind,
        participantId: parsed.data.participantId,
        automationId: parsed.data.automationId,
        sourceRevision: parsed.data.sourceRevision,
        sourceContent: parsed.data.sourceContent,
        targetContent: parsed.data.targetContent,
        sourceEncodedBytes,
        targetEncodedBytes,
    };
}

function sourceItemIdentity(
    item: AutomationAccountEncryptionTransitionInventoryItem,
): Readonly<{
    participantKind: "definition" | "run";
    participantId: string;
    automationId: string;
    sourceRevision: number;
}> {
    return item.kind === "definition"
        ? {
            participantKind: "definition",
            participantId: item.automationId,
            automationId: item.automationId,
            sourceRevision: item.revision,
        }
        : {
            participantKind: "run",
            participantId: item.runId,
            automationId: item.automationId,
            sourceRevision: item.revision,
        };
}

function sourceItemContent(item: AutomationAccountEncryptionTransitionInventoryItem): string {
    return JSON.stringify(item);
}

/**
 * The staged source fact is the exact, protocol-shaped inventory item. This
 * is intentionally owned with the durable representation so Account-level
 * counters cannot grow a second JSON-size rule in a coordinator or route.
 */
export function measureAccountEncryptionTransitionAutomationSourceItemBytes(
    item: AutomationAccountEncryptionTransitionInventoryItem,
): bigint {
    return BigInt(new TextEncoder().encode(sourceItemContent(item)).byteLength);
}

function stageItemContent(item: AutomationAccountEncryptionTransitionStageItem): string {
    return JSON.stringify(item);
}

/** The durable target fact is the complete source-bound stage item. */
export function measureAccountEncryptionTransitionAutomationStageItemBytes(
    item: AutomationAccountEncryptionTransitionStageItem,
): bigint {
    return BigInt(new TextEncoder().encode(stageItemContent(item)).byteLength);
}

function jsonEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (
        left === null
        || right === null
        || typeof left !== "object"
        || typeof right !== "object"
        || Array.isArray(left)
        || Array.isArray(right)
    ) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        return left.length === right.length
            && left.every((value, index) => jsonEqual(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => (
            key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key])
        ));
}

function parseJson(value: string): unknown | null {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function storedStageMatchesSource(
    stage: AccountEncryptionTransitionAutomationStoredStage,
    item: AutomationAccountEncryptionTransitionInventoryItem,
): boolean {
    const identity = sourceItemIdentity(item);
    return stage.participantKind === identity.participantKind
        && stage.participantId === identity.participantId
        && stage.automationId === identity.automationId
        && stage.sourceRevision === identity.sourceRevision
        && stage.sourceEncodedBytes
            === measureAccountEncryptionTransitionAutomationSourceItemBytes(item);
}

/**
 * Parses an opaque durable source fact only after checking it still agrees
 * with the indexed identity/revision columns. Consumers must not trust one
 * representation without the other.
 */
export function sourceItemFromAccountEncryptionTransitionAutomationStage(
    stage: AccountEncryptionTransitionAutomationStoredStage,
): AutomationAccountEncryptionTransitionInventoryItem | null {
    const raw = parseJson(stage.sourceContent);
    const parsed = StageAutomationInventoryItemSchema.safeParse(raw);
    if (!parsed.success || !storedStageMatchesSource(stage, parsed.data)) return null;
    return parsed.data as AutomationAccountEncryptionTransitionInventoryItem;
}

/**
 * Parses a durable target only when it remains bound to the exact persisted
 * source fact. This prevents a target JSON row from becoming a second source
 * of identity or revision authority.
 */
export function targetItemFromAccountEncryptionTransitionAutomationStage(
    stage: AccountEncryptionTransitionAutomationStoredStage,
): AutomationAccountEncryptionTransitionStageItem | null {
    if (stage.targetContent === null || stage.targetEncodedBytes === null) return null;
    const raw = parseJson(stage.targetContent);
    const parsed = StageAutomationStageItemSchema.safeParse(raw);
    if (
        !parsed.success
        || stage.targetEncodedBytes
            !== measureAccountEncryptionTransitionAutomationStageItemBytes(parsed.data)
    ) {
        return null;
    }
    const source = sourceItemFromAccountEncryptionTransitionAutomationStage(stage);
    if (!source) return null;
    if (parsed.data.kind === "definition") {
        return source.kind === "definition"
            && parsed.data.automationId === source.automationId
            && parsed.data.expectedRevision === source.revision
            && jsonEqual(parsed.data.source, source.source)
            ? parsed.data as AutomationAccountEncryptionTransitionStageItem
            : null;
    }
    return source.kind === "run"
        && parsed.data.runId === source.runId
        && parsed.data.automationId === source.automationId
        && parsed.data.expectedRevision === source.revision
        && parsed.data.originKind === source.originKind
        && parsed.data.occurrenceKey === source.occurrenceKey
        && jsonEqual(parsed.data.source, source.source)
        ? parsed.data as AutomationAccountEncryptionTransitionStageItem
        : null;
}

export async function readAccountEncryptionTransitionAutomationStageStateInTx(
    tx: RawStageClient,
    transitionId: string,
): Promise<AccountEncryptionTransitionAutomationStageState | null> {
    const sql = transitionAutomationStageSql();
    const rows = await tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT
            ${sql.transitionId} AS ${sql.transitionId},
            ${sql.sourceParticipantCount} AS ${sql.sourceParticipantCount},
            ${sql.sourceRunCount} AS ${sql.sourceRunCount},
            ${sql.sourceEncodedBytes} AS ${sql.sourceEncodedBytes},
            ${sql.stagedParticipantCount} AS ${sql.stagedParticipantCount},
            ${sql.stagedRunCount} AS ${sql.stagedRunCount},
            ${sql.stagedSourceBytes} AS ${sql.stagedSourceBytes},
            ${sql.stagedTargetBytes} AS ${sql.stagedTargetBytes}
        FROM ${sql.stateTable}
        WHERE ${sql.transitionId} = ${transitionId}
    `);
    if (rows.length !== 1) return null;
    return parseStageState(rows[0]);
}

export type AccountEncryptionTransitionAutomationSourceStageResult =
    | Readonly<{
        status: "complete";
        state: AccountEncryptionTransitionAutomationStageState;
    }>
    | Readonly<{ status: "invalid_content" }>;

/**
 * The Account coordinator calls this only after complete source/capacity
 * admission. It writes every exact source fact in 500-item pages, then writes
 * the one state row last; a state row therefore proves even a zero census was
 * deliberately staged rather than silently omitted.
 */
export async function stageAccountEncryptionTransitionAutomationSourceCensusInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        transitionId: string;
        sourceMode: "plain" | "e2ee";
    }>,
): Promise<AccountEncryptionTransitionAutomationSourceStageResult> {
    const sql = transitionAutomationStageSql();
    let cursor: AutomationAccountEncryptionTransitionSourceCursor | undefined;
    let sourceParticipantCount = 0;
    let sourceRunCount = 0;
    let sourceEncodedBytes = 0n;
    for (;;) {
        const inspected = await inspectAutomationAccountEncryptionTransitionInTx({
            tx: params.tx,
            accountId: params.accountId,
            sourceMode: params.sourceMode,
            ...(cursor ? { cursor } : {}),
        });
        if (inspected.status !== "complete") return inspected;
        const { items } = inspected.page;
        if (!Number.isSafeInteger(sourceParticipantCount + items.length)) {
            return { status: "invalid_content" };
        }
        if (items.length > 0) {
            const values = items.map((item) => {
                const identity = sourceItemIdentity(item);
                const sourceContent = sourceItemContent(item);
                return sql.prisma.sql`(
                    ${randomUUID()},
                    ${params.transitionId},
                    ${identity.participantKind},
                    ${identity.participantId},
                    ${identity.automationId},
                    ${identity.sourceRevision},
                    ${sourceContent},
                    ${measureAccountEncryptionTransitionAutomationSourceItemBytes(item)},
                    ${new Date()},
                    ${new Date()}
                )`;
            });
            await params.tx.$executeRaw(sql.prisma.sql`
                INSERT INTO ${sql.stageTable} (
                    ${sql.id},
                    ${sql.transitionId},
                    ${sql.participantKind},
                    ${sql.participantId},
                    ${sql.automationId},
                    ${sql.sourceRevision},
                    ${sql.sourceContent},
                    ${sql.sourceEncodedBytes},
                    ${sql.createdAt},
                    ${sql.updatedAt}
                ) VALUES ${sql.prisma.join(values)}
            `);
        }
        sourceParticipantCount += items.length;
        sourceRunCount += inspected.page.runCount;
        sourceEncodedBytes += inspected.page.sourceEncodedBytes;
        if (!inspected.page.nextCursor) break;
        cursor = inspected.page.nextCursor;
    }
    const now = new Date();
    await params.tx.$executeRaw(sql.prisma.sql`
        INSERT INTO ${sql.stateTable} (
            ${sql.transitionId},
            ${sql.sourceParticipantCount},
            ${sql.sourceRunCount},
            ${sql.sourceEncodedBytes},
            ${sql.stagedParticipantCount},
            ${sql.stagedRunCount},
            ${sql.stagedSourceBytes},
            ${sql.stagedTargetBytes},
            ${sql.createdAt},
            ${sql.updatedAt}
        ) VALUES (
            ${params.transitionId},
            ${sourceParticipantCount},
            ${sourceRunCount},
            ${sourceEncodedBytes},
            ${0},
            ${0},
            ${0n},
            ${0n},
            ${now},
            ${now}
        )
    `);
    return {
        status: "complete",
        state: {
            transitionId: params.transitionId,
            sourceParticipantCount,
            sourceRunCount,
            sourceEncodedBytes,
            stagedParticipantCount: 0,
            stagedRunCount: 0,
            stagedSourceBytes: 0n,
            stagedTargetBytes: 0n,
        },
    };
}

export async function readAccountEncryptionTransitionAutomationStagePageInTx(
    params: Readonly<{
        tx: RawStageClient;
        transitionId: string;
        cursor?: AccountEncryptionTransitionAutomationStageCursor;
    }>,
): Promise<AccountEncryptionTransitionAutomationStagePage | null> {
    const sql = transitionAutomationStageSql();
    const limit = 500;
    const rows = params.cursor
        ? await params.tx.$queryRaw<unknown[]>(sql.prisma.sql`
            SELECT
                ${sql.id} AS ${sql.id},
                ${sql.transitionId} AS ${sql.transitionId},
                ${sql.participantKind} AS ${sql.participantKind},
                ${sql.participantId} AS ${sql.participantId},
                ${sql.automationId} AS ${sql.automationId},
                ${sql.sourceRevision} AS ${sql.sourceRevision},
                ${sql.sourceContent} AS ${sql.sourceContent},
                ${sql.targetContent} AS ${sql.targetContent},
                ${sql.sourceEncodedBytes} AS ${sql.sourceEncodedBytes},
                ${sql.targetEncodedBytes} AS ${sql.targetEncodedBytes}
            FROM ${sql.stageTable}
            WHERE ${sql.transitionId} = ${params.transitionId}
                AND (
                    ${sql.participantKind} > ${params.cursor.participantKind}
                    OR (
                        ${sql.participantKind} = ${params.cursor.participantKind}
                        AND ${sql.participantId} > ${params.cursor.participantId}
                    )
                )
            ORDER BY ${sql.participantKind} ASC, ${sql.participantId} ASC
            LIMIT ${limit + 1}
        `)
        : await params.tx.$queryRaw<unknown[]>(sql.prisma.sql`
            SELECT
                ${sql.id} AS ${sql.id},
                ${sql.transitionId} AS ${sql.transitionId},
                ${sql.participantKind} AS ${sql.participantKind},
                ${sql.participantId} AS ${sql.participantId},
                ${sql.automationId} AS ${sql.automationId},
                ${sql.sourceRevision} AS ${sql.sourceRevision},
                ${sql.sourceContent} AS ${sql.sourceContent},
                ${sql.targetContent} AS ${sql.targetContent},
                ${sql.sourceEncodedBytes} AS ${sql.sourceEncodedBytes},
                ${sql.targetEncodedBytes} AS ${sql.targetEncodedBytes}
            FROM ${sql.stageTable}
            WHERE ${sql.transitionId} = ${params.transitionId}
            ORDER BY ${sql.participantKind} ASC, ${sql.participantId} ASC
            LIMIT ${limit + 1}
        `);
    const stages: AccountEncryptionTransitionAutomationStoredStage[] = [];
    for (const row of rows.slice(0, limit)) {
        const stage = parseStoredStage(row);
        if (!stage || stage.transitionId !== params.transitionId) return null;
        stages.push(stage);
    }
    const last = stages.at(-1);
    return {
        stages,
        ...(rows.length > stages.length && last
            ? {
                nextCursor: {
                    participantKind: last.participantKind,
                    participantId: last.participantId,
                },
            }
            : {}),
    };
}

export async function readAccountEncryptionTransitionAutomationStagesByIdentityInTx(
    params: Readonly<{
        tx: RawStageClient;
        transitionId: string;
        identities: readonly AccountEncryptionTransitionAutomationStageCursor[];
    }>,
): Promise<readonly AccountEncryptionTransitionAutomationStoredStage[] | null> {
    if (params.identities.length === 0) return [];
    const unique = new Set(
        params.identities.map((identity) => (
            `${identity.participantKind}\u0000${identity.participantId}`
        )),
    );
    if (unique.size !== params.identities.length) return null;
    const sql = transitionAutomationStageSql();
    const predicates = params.identities.map((identity) => sql.prisma.sql`
        (
            ${sql.participantKind} = ${identity.participantKind}
            AND ${sql.participantId} = ${identity.participantId}
        )
    `);
    const rows = await params.tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT
            ${sql.id} AS ${sql.id},
            ${sql.transitionId} AS ${sql.transitionId},
            ${sql.participantKind} AS ${sql.participantKind},
            ${sql.participantId} AS ${sql.participantId},
            ${sql.automationId} AS ${sql.automationId},
            ${sql.sourceRevision} AS ${sql.sourceRevision},
            ${sql.sourceContent} AS ${sql.sourceContent},
            ${sql.targetContent} AS ${sql.targetContent},
            ${sql.sourceEncodedBytes} AS ${sql.sourceEncodedBytes},
            ${sql.targetEncodedBytes} AS ${sql.targetEncodedBytes}
        FROM ${sql.stageTable}
        WHERE ${sql.transitionId} = ${params.transitionId}
            AND (${sql.prisma.join(predicates, " OR ")})
    `);
    const stages: AccountEncryptionTransitionAutomationStoredStage[] = [];
    for (const row of rows) {
        const stage = parseStoredStage(row);
        if (!stage || stage.transitionId !== params.transitionId) return null;
        stages.push(stage);
    }
    return stages;
}

export type AccountEncryptionTransitionAutomationStageTargetWriteResult =
    | Readonly<{
        status: "staged";
        state: AccountEncryptionTransitionAutomationStageState;
    }>
    | Readonly<{ status: "migration_incomplete" | "stage_conflict" }>;

/**
 * Writes a previously validated bounded target batch. Each target is CASed
 * from null so a retry can only replay the same source-bound bytes; the state
 * counter advances for newly written rows only.
 */
export async function writeAccountEncryptionTransitionAutomationStageTargetsInTx(
    params: Readonly<{
        tx: RawStageClient;
        transitionId: string;
        items: readonly Readonly<{
            stage: AccountEncryptionTransitionAutomationStoredStage;
            item: AutomationAccountEncryptionTransitionStageItem;
        }>[];
    }>,
): Promise<AccountEncryptionTransitionAutomationStageTargetWriteResult> {
    const state = await readAccountEncryptionTransitionAutomationStageStateInTx(
        params.tx,
        params.transitionId,
    );
    if (!state) return { status: "migration_incomplete" };
    const sql = transitionAutomationStageSql();
    const pending: Array<Readonly<{
        candidate: (typeof params.items)[number];
        targetContent: string;
        targetEncodedBytes: bigint;
    }>> = [];
    let addedParticipantCount = 0;
    let addedRunCount = 0;
    let addedSourceBytes = 0n;
    let addedTargetBytes = 0n;
    for (const candidate of params.items) {
        if (
            candidate.stage.transitionId !== params.transitionId
            || sourceItemFromAccountEncryptionTransitionAutomationStage(candidate.stage)
                === null
        ) {
            return { status: "migration_incomplete" };
        }
        const targetContent = stageItemContent(candidate.item);
        const targetEncodedBytes =
            measureAccountEncryptionTransitionAutomationStageItemBytes(candidate.item);
        const existing = targetItemFromAccountEncryptionTransitionAutomationStage(
            candidate.stage,
        );
        if (existing) {
            if (!jsonEqual(existing, candidate.item)) return { status: "stage_conflict" };
            continue;
        }
        if (
            candidate.stage.targetContent !== null
            || candidate.stage.targetEncodedBytes !== null
        ) {
            return { status: "migration_incomplete" };
        }
        pending.push({ candidate, targetContent, targetEncodedBytes });
        addedParticipantCount += 1;
        if (candidate.stage.participantKind === "run") addedRunCount += 1;
        addedSourceBytes += candidate.stage.sourceEncodedBytes;
        addedTargetBytes += targetEncodedBytes;
    }
    const nextParticipantCount = state.stagedParticipantCount + addedParticipantCount;
    const nextRunCount = state.stagedRunCount + addedRunCount;
    const nextSourceBytes = state.stagedSourceBytes + addedSourceBytes;
    const nextTargetBytes = state.stagedTargetBytes + addedTargetBytes;
    if (
        !Number.isSafeInteger(nextParticipantCount)
        || !Number.isSafeInteger(nextRunCount)
        || nextParticipantCount > state.sourceParticipantCount
        || nextRunCount > state.sourceRunCount
        || nextSourceBytes > state.sourceEncodedBytes
    ) {
        return { status: "migration_incomplete" };
    }
    // Complete every non-mutating check before the first stage write. A CAS
    // miss after this point means the Account-owned transaction fence was
    // bypassed, so throw and let the enclosing transaction roll all earlier
    // target writes back rather than retaining a partial batch.
    for (const pendingTarget of pending) {
        const updated = await params.tx.$executeRaw(sql.prisma.sql`
            UPDATE ${sql.stageTable}
            SET
                ${sql.targetContent} = ${pendingTarget.targetContent},
                ${sql.targetEncodedBytes} = ${pendingTarget.targetEncodedBytes},
                ${sql.updatedAt} = ${new Date()}
            WHERE ${sql.id} = ${pendingTarget.candidate.stage.id}
                AND ${sql.transitionId} = ${params.transitionId}
                AND ${sql.targetContent} IS NULL
        `);
        if (updated !== 1) {
            throw new Error("Automation transition stage changed after target validation");
        }
    }
    if (addedParticipantCount > 0) {
        const updated = await params.tx.$executeRaw(sql.prisma.sql`
            UPDATE ${sql.stateTable}
            SET
                ${sql.stagedParticipantCount} = ${nextParticipantCount},
                ${sql.stagedRunCount} = ${nextRunCount},
                ${sql.stagedSourceBytes} = ${nextSourceBytes},
                ${sql.stagedTargetBytes} = ${nextTargetBytes},
                ${sql.updatedAt} = ${new Date()}
            WHERE ${sql.transitionId} = ${params.transitionId}
        `);
        if (updated !== 1) {
            throw new Error("Automation transition stage state changed after target validation");
        }
    }
    return {
        status: "staged",
        state: {
            ...state,
            stagedParticipantCount: nextParticipantCount,
            stagedRunCount: nextRunCount,
            stagedSourceBytes: nextSourceBytes,
            stagedTargetBytes: nextTargetBytes,
        },
    };
}

export async function listAccountEncryptionTransitionAutomationStageIdsForCleanupInTx(
    tx: RawStageClient,
    transitionId: string,
    take: number,
): Promise<readonly string[]> {
    const sql = transitionAutomationStageSql();
    const rows = await tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT ${sql.id} AS ${sql.id}
        FROM ${sql.stageTable}
        WHERE ${sql.transitionId} = ${transitionId}
        ORDER BY ${sql.participantKind} ASC, ${sql.participantId} ASC
        LIMIT ${take}
    `);
    const parsed = z.array(z.object({ id: z.string().uuid() }).strict()).safeParse(rows);
    return parsed.success ? parsed.data.map((row) => row.id) : [];
}

export async function deleteAccountEncryptionTransitionAutomationStagesByIdsInTx(
    tx: RawStageClient,
    ids: readonly string[],
): Promise<number> {
    if (ids.length === 0) return 0;
    const sql = transitionAutomationStageSql();
    return await tx.$executeRaw(sql.prisma.sql`
        DELETE FROM ${sql.stageTable}
        WHERE ${sql.id} IN (${sql.prisma.join(ids)})
    `);
}

export async function deleteAccountEncryptionTransitionAutomationStagesInTx(
    tx: RawStageClient,
    transitionId: string,
): Promise<number> {
    const sql = transitionAutomationStageSql();
    return await tx.$executeRaw(sql.prisma.sql`
        DELETE FROM ${sql.stageTable}
        WHERE ${sql.transitionId} = ${transitionId}
    `);
}

export async function deleteAccountEncryptionTransitionAutomationStageStateInTx(
    tx: RawStageClient,
    transitionId: string,
): Promise<number> {
    const sql = transitionAutomationStageSql();
    return await tx.$executeRaw(sql.prisma.sql`
        DELETE FROM ${sql.stateTable}
        WHERE ${sql.transitionId} = ${transitionId}
    `);
}

export async function readAccountEncryptionTransitionAutomationStagesInTx(
    tx: RawStageClient,
    transitionId: string,
): Promise<readonly AccountEncryptionTransitionAutomationStoredStage[] | null> {
    const sql = transitionAutomationStageSql();
    const rows = await tx.$queryRaw<unknown[]>(sql.prisma.sql`
        SELECT
            ${sql.id} AS ${sql.id},
            ${sql.transitionId} AS ${sql.transitionId},
            ${sql.participantKind} AS ${sql.participantKind},
            ${sql.participantId} AS ${sql.participantId},
            ${sql.automationId} AS ${sql.automationId},
            ${sql.sourceRevision} AS ${sql.sourceRevision},
            ${sql.sourceContent} AS ${sql.sourceContent},
            ${sql.targetContent} AS ${sql.targetContent},
            ${sql.sourceEncodedBytes} AS ${sql.sourceEncodedBytes},
            ${sql.targetEncodedBytes} AS ${sql.targetEncodedBytes}
        FROM ${sql.stageTable}
        WHERE ${sql.transitionId} = ${transitionId}
        ORDER BY ${sql.participantKind} ASC, ${sql.participantId} ASC
    `);
    const parsed: AccountEncryptionTransitionAutomationStoredStage[] = [];
    for (const row of rows) {
        const stage = parseStoredStage(row);
        if (!stage) return null;
        parsed.push(stage);
    }
    return parsed;
}
