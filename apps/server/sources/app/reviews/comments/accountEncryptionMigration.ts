import { ZodError } from "zod";

import type {
    BoundReviewCommentEventSensitiveEnvelopeV1,
    ReviewCommentEventV1,
    ReviewCommentEventSensitiveMigrationLayoutV1,
    ReviewCommentSensitiveMigrationSourceV1,
    ReviewCommentStructuralV1,
    StoredJsonContentEnvelope,
} from "@happier-dev/protocol";
import {
    BoundReviewCommentEventSensitiveEnvelopeV1Schema,
    ReviewCommentEventV1Schema,
    ReviewCommentSensitiveMigrationSourceV1Schema,
    StoredJsonContentEnvelopeSchema,
    reviewCommentEventSensitiveBindingMatchesV1,
} from "@happier-dev/protocol";

export const REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS = 200;
export const REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS = 2_000;

export type ReviewCommentAccountEncryptionMigrationStoredEvent = Readonly<{
    event: ReviewCommentEventV1;
    sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
    sourceLayout: ReviewCommentEventSensitiveMigrationLayoutV1;
}>;

export type ReviewCommentAccountEncryptionMigrationStoredComment = Readonly<{
    commentId: string;
    accountId: string;
    serverRevision: number;
    bodyVersion: number;
    structural: ReviewCommentStructuralV1;
    sensitiveSource: ReviewCommentSensitiveMigrationSourceV1;
    events: readonly ReviewCommentAccountEncryptionMigrationStoredEvent[];
}>;

export type ReviewCommentAccountEncryptionMigrationItem = Readonly<{
    commentId: string;
    expectedServerRevision: number;
    expectedBodyVersion: number;
    expectedSensitiveSource: ReviewCommentSensitiveMigrationSourceV1;
    targetSensitiveEnvelope: StoredJsonContentEnvelope;
    events: readonly Readonly<{
        eventId: string;
        expectedSensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
        targetSensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
    }>[];
}>;

export type ReviewCommentAccountEncryptionMigrationDirective =
    | Readonly<{ action: "assert_empty" }>
    | Readonly<{
        action: "migrate";
        items: readonly ReviewCommentAccountEncryptionMigrationItem[];
    }>;

export type ReviewCommentAccountEncryptionMigrationFailureStatus =
    | "not_empty"
    | "migration_incomplete"
    | "invalid_content"
    | "migration_too_large";

export function classifyReviewCommentAccountEncryptionMigrationError(
    error: unknown,
): ReviewCommentAccountEncryptionMigrationFailureStatus | null {
    if (error instanceof ZodError) return "invalid_content";
    if (!(error instanceof Error)) return null;
    if (error.message === "review_comment_migration_inventory_not_empty") {
        return "not_empty";
    }
    if (error.message === "review_comment_migration_inventory_too_large") {
        return "migration_too_large";
    }
    if (
        error.message === "review_comment_migration_inventory_mismatch"
        || error.message === "review_comment_migration_envelope_mismatch"
    ) {
        return "migration_incomplete";
    }
    if (
        error.message === "review_comment_migration_event_binding_mismatch"
        || error.message === "review_comment_migration_comment_binding_mismatch"
    ) {
        return "invalid_content";
    }
    return null;
}

export interface ReviewCommentAccountEncryptionMigrationPersistence {
    readInventory(accountId: string): Promise<readonly ReviewCommentAccountEncryptionMigrationStoredComment[]>;
    rewriteCommentSensitiveEnvelope(params: Readonly<{
        accountId: string;
        commentId: string;
        expectedServerRevision: number;
        expectedBodyVersion: number;
        expectedSensitiveSource: ReviewCommentSensitiveMigrationSourceV1;
        targetSensitiveEnvelope: StoredJsonContentEnvelope;
    }>): Promise<void>;
    rewriteEventSensitiveEnvelope(params: Readonly<{
        accountId: string;
        commentId: string;
        eventId: string;
        expectedSensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
        targetSensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
    }>): Promise<void>;
}

export type ReviewCommentAccountEncryptionMigrationPostState = Readonly<{
    comments: readonly Readonly<{
        commentId: string;
        serverRevision: number;
        bodyVersion: number;
        sensitiveEnvelope: StoredJsonContentEnvelope;
        events: readonly Readonly<{
            eventId: string;
            sensitiveEnvelope: BoundReviewCommentEventSensitiveEnvelopeV1;
        }>[];
    }>[];
}>;

export async function migrateReviewCommentAccountEncryptionInTx(_params: Readonly<{
    accountId: string;
    targetMode: "plain" | "e2ee";
    directive: ReviewCommentAccountEncryptionMigrationDirective;
    persistence: ReviewCommentAccountEncryptionMigrationPersistence;
}>): Promise<ReviewCommentAccountEncryptionMigrationPostState> {
    const params = _params;
    const inventory = await readValidatedInventory(params.persistence, params.accountId);
    if (params.directive.action === "assert_empty") {
        if (inventory.length !== 0) {
            throw new Error("review_comment_migration_inventory_not_empty");
        }
        return { comments: [] };
    }
    const prepared = prepareMigration({
        accountId: params.accountId,
        targetMode: params.targetMode,
        inventory,
        items: params.directive.items,
    });
    for (const item of prepared) {
        await params.persistence.rewriteCommentSensitiveEnvelope({
            accountId: params.accountId,
            commentId: item.commentId,
            expectedServerRevision: item.expectedServerRevision,
            expectedBodyVersion: item.expectedBodyVersion,
            expectedSensitiveSource: item.expectedSensitiveSource,
            targetSensitiveEnvelope: item.targetSensitiveEnvelope,
        });
        for (const eventItem of item.events) {
            await params.persistence.rewriteEventSensitiveEnvelope({
                accountId: params.accountId,
                commentId: item.commentId,
                eventId: eventItem.eventId,
                expectedSensitiveEnvelope: eventItem.expectedSensitiveEnvelope,
                targetSensitiveEnvelope: eventItem.targetSensitiveEnvelope,
            });
        }
    }
    return postStateFromItems(prepared);
}

export async function reviewCommentAccountEncryptionPostStateMatches(_params: Readonly<{
    accountId: string;
    targetMode: "plain" | "e2ee";
    directive: ReviewCommentAccountEncryptionMigrationDirective;
    persistence: ReviewCommentAccountEncryptionMigrationPersistence;
}>): Promise<boolean> {
    const params = _params;
    const inventory = await readValidatedInventory(params.persistence, params.accountId);
    if (params.directive.action === "assert_empty") {
        return inventory.length === 0;
    }
    try {
        const items = params.directive.items;
        validateBounds(items);
        const itemByCommentId = uniqueBy(
            items,
            (item) => item.commentId,
            "review_comment_migration_inventory_mismatch",
        );
        if (itemByCommentId.size !== inventory.length) return false;
        for (const row of inventory) {
            const item = itemByCommentId.get(row.commentId);
            if (
                !item
                || row.serverRevision !== item.expectedServerRevision
                || row.bodyVersion !== item.expectedBodyVersion
                || !exactJson(
                    row.sensitiveSource,
                    canonicalSource(item.targetSensitiveEnvelope),
                )
            ) {
                return false;
            }
            assertEnvelopeMode(item.targetSensitiveEnvelope, params.targetMode);
            const eventItemById = uniqueBy(
                item.events,
                (eventItem) => eventItem.eventId,
                "review_comment_migration_inventory_mismatch",
            );
            if (eventItemById.size !== row.events.length) return false;
            for (const eventRow of row.events) {
                const eventItem = eventItemById.get(eventRow.event.eventId);
                if (
                    !eventItem
                    || !eventEnvelopeMatchesEvent(eventItem.targetSensitiveEnvelope, eventRow.event)
                    || !exactJson(eventRow.sensitiveEnvelope, eventItem.targetSensitiveEnvelope)
                ) {
                    return false;
                }
                assertEnvelopeMode(eventItem.targetSensitiveEnvelope.sensitive, params.targetMode);
            }
        }
        return true;
    } catch {
        return false;
    }
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
}

function exactJson(left: unknown, right: unknown): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

function uniqueBy<T>(
    values: readonly T[],
    key: (value: T) => string,
    errorCode: string,
): Map<string, T> {
    const result = new Map<string, T>();
    for (const value of values) {
        const id = key(value);
        if (result.has(id)) throw new Error(errorCode);
        result.set(id, value);
    }
    return result;
}

function assertEnvelopeMode(
    envelopeInput: StoredJsonContentEnvelope,
    mode: "plain" | "e2ee",
): void {
    const envelope = StoredJsonContentEnvelopeSchema.parse(envelopeInput);
    if (
        (mode === "plain" && envelope.t !== "plain")
        || (mode === "e2ee" && envelope.t !== "encrypted")
    ) {
        throw new Error("review_comment_migration_envelope_mismatch");
    }
}

function canonicalSource(
    envelopeInput: StoredJsonContentEnvelope,
): ReviewCommentSensitiveMigrationSourceV1 {
    return ReviewCommentSensitiveMigrationSourceV1Schema.parse({
        v: 1,
        layout: "canonical_v1",
        envelope: envelopeInput,
    });
}

function assertSourceMode(
    sourceInput: ReviewCommentSensitiveMigrationSourceV1,
    targetMode: "plain" | "e2ee",
): void {
    const source = ReviewCommentSensitiveMigrationSourceV1Schema.parse(sourceInput);
    const sourceMode = source.layout === "canonical_v1"
        ? source.envelope.t === "encrypted" ? "e2ee" : "plain"
        : source.sourceMode;
    const expectedSourceMode = targetMode === "plain" ? "e2ee" : "plain";
    if (sourceMode !== expectedSourceMode) {
        throw new Error("review_comment_migration_envelope_mismatch");
    }
}

function eventEnvelopeMatchesEvent(
    envelopeInput: BoundReviewCommentEventSensitiveEnvelopeV1,
    eventInput: ReviewCommentEventV1,
): boolean {
    const envelope = BoundReviewCommentEventSensitiveEnvelopeV1Schema.safeParse(envelopeInput);
    const event = ReviewCommentEventV1Schema.safeParse(eventInput);
    return envelope.success
        && event.success
        && reviewCommentEventSensitiveBindingMatchesV1({
            event: event.data,
            bound: envelope.data,
        });
}

async function readValidatedInventory(
    persistence: ReviewCommentAccountEncryptionMigrationPersistence,
    accountId: string,
): Promise<readonly ReviewCommentAccountEncryptionMigrationStoredComment[]> {
    const inventory = await persistence.readInventory(accountId);
    if (inventory.length > REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS) {
        throw new Error("review_comment_migration_inventory_too_large");
    }
    let eventCount = 0;
    const commentIds = new Set<string>();
    const eventIds = new Set<string>();
    for (const row of inventory) {
        if (row.accountId !== accountId || commentIds.has(row.commentId)) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        commentIds.add(row.commentId);
        if (
            row.structural.id !== row.commentId
            || row.structural.accountId !== accountId
            || row.structural.serverRevision !== row.serverRevision
            || row.structural.bodyVersion !== row.bodyVersion
        ) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        ReviewCommentSensitiveMigrationSourceV1Schema.parse(row.sensitiveSource);
        for (const eventRow of row.events) {
            eventCount += 1;
            const event = ReviewCommentEventV1Schema.parse(eventRow.event);
            if (
                event.accountId !== accountId
                || event.commentId !== row.commentId
                || eventIds.has(event.eventId)
                || !eventEnvelopeMatchesEvent(eventRow.sensitiveEnvelope, event)
            ) {
                throw new Error("review_comment_migration_event_binding_mismatch");
            }
            eventIds.add(event.eventId);
        }
    }
    if (eventCount > REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS) {
        throw new Error("review_comment_migration_inventory_too_large");
    }
    return inventory;
}

function validateBounds(items: readonly ReviewCommentAccountEncryptionMigrationItem[]): void {
    if (items.length > REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_COMMENTS) {
        throw new Error("review_comment_migration_inventory_too_large");
    }
    const eventCount = items.reduce((sum, item) => sum + item.events.length, 0);
    if (eventCount > REVIEW_COMMENT_ACCOUNT_ENCRYPTION_MIGRATION_MAX_EVENTS) {
        throw new Error("review_comment_migration_inventory_too_large");
    }
}

function prepareMigration(params: Readonly<{
    accountId: string;
    targetMode: "plain" | "e2ee";
    inventory: readonly ReviewCommentAccountEncryptionMigrationStoredComment[];
    items: readonly ReviewCommentAccountEncryptionMigrationItem[];
}>): readonly ReviewCommentAccountEncryptionMigrationItem[] {
    validateBounds(params.items);
    const itemByCommentId = uniqueBy(
        params.items,
        (item) => item.commentId,
        "review_comment_migration_inventory_mismatch",
    );
    if (itemByCommentId.size !== params.inventory.length) {
        throw new Error("review_comment_migration_inventory_mismatch");
    }
    for (const row of params.inventory) {
        const item = itemByCommentId.get(row.commentId);
        if (
            !item
            || row.accountId !== params.accountId
            || item.expectedServerRevision !== row.serverRevision
            || item.expectedBodyVersion !== row.bodyVersion
        ) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        if (!exactJson(item.expectedSensitiveSource, row.sensitiveSource)) {
            throw new Error("review_comment_migration_envelope_mismatch");
        }
        assertSourceMode(item.expectedSensitiveSource, params.targetMode);
        assertEnvelopeMode(item.targetSensitiveEnvelope, params.targetMode);
        const eventItemById = uniqueBy(
            item.events,
            (eventItem) => eventItem.eventId,
            "review_comment_migration_inventory_mismatch",
        );
        if (eventItemById.size !== row.events.length) {
            throw new Error("review_comment_migration_inventory_mismatch");
        }
        for (const eventRow of row.events) {
            const eventItem = eventItemById.get(eventRow.event.eventId);
            if (!eventItem) {
                throw new Error("review_comment_migration_inventory_mismatch");
            }
            if (!exactJson(eventItem.expectedSensitiveEnvelope, eventRow.sensitiveEnvelope)) {
                throw new Error("review_comment_migration_envelope_mismatch");
            }
            assertEnvelopeMode(eventItem.targetSensitiveEnvelope.sensitive, params.targetMode);
            if (!eventEnvelopeMatchesEvent(eventItem.targetSensitiveEnvelope, eventRow.event)) {
                throw new Error("review_comment_migration_event_binding_mismatch");
            }
        }
    }
    return params.items;
}

function postStateFromItems(
    items: readonly ReviewCommentAccountEncryptionMigrationItem[],
): ReviewCommentAccountEncryptionMigrationPostState {
    return {
        comments: items.map((item) => ({
            commentId: item.commentId,
            serverRevision: item.expectedServerRevision,
            bodyVersion: item.expectedBodyVersion,
            sensitiveEnvelope: item.targetSensitiveEnvelope,
            events: item.events.map((eventItem) => ({
                eventId: eventItem.eventId,
                sensitiveEnvelope: eventItem.targetSensitiveEnvelope,
            })),
        })),
    };
}
