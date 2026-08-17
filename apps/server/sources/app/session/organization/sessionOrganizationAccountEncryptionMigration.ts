import type {
    SessionOrganizationAccountEncryptionMigrationInventory,
    SessionOrganizationContentEnvelope,
    SessionOrganizationLabel,
} from "@happier-dev/protocol";
import { SessionOrganizationAccountEncryptionMigrationInventorySchema } from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";

import { markSessionOrganizationDisplayMigrationChanged } from "./changes";
import {
    parseSessionOrganizationDisplayEnvelope,
    serializeSessionOrganizationDisplayEnvelope,
} from "./contentEnvelope";

export type SessionOrganizationAccountEncryptionMigrationDisplayItem =
    Readonly<{
        expectedDisplay: SessionOrganizationContentEnvelope;
        display: SessionOrganizationContentEnvelope;
    }>;

export type SessionOrganizationAccountEncryptionMigrationDirective =
    | Readonly<{ action: "assert_empty" }>
    | Readonly<{
        action: "migrate";
        expectedVersion: number;
        folders: readonly (
            SessionOrganizationAccountEncryptionMigrationDisplayItem
            & Readonly<{ folderId: string }>
        )[];
        tags: readonly (
            SessionOrganizationAccountEncryptionMigrationDisplayItem
            & Readonly<{ tagId: string }>
        )[];
        labels: readonly (
            SessionOrganizationAccountEncryptionMigrationDisplayItem
            & Readonly<{
                labelKind: SessionOrganizationLabel["labelKind"];
                scopeKey: string;
            }>
        )[];
    }>;

export type SessionOrganizationAccountEncryptionMigrationResult =
    | Readonly<{ status: "applied" }>
    | Readonly<{ status: "not_empty" }>
    | Readonly<{ status: "migration_incomplete" }>
    | Readonly<{ status: "invalid_content" }>;

export type SessionOrganizationAccountEncryptionMigrationPostStateResult =
    | Readonly<{ status: "matched" }>
    | Readonly<{ status: "mismatch" }>;

export class SessionOrganizationAccountEncryptionMigrationConflictError
    extends Error {
    constructor() {
        super(
            "Session Organization account-encryption migration lost its currentness precondition",
        );
        this.name =
            "SessionOrganizationAccountEncryptionMigrationConflictError";
    }
}

export class SessionOrganizationAccountEncryptionMigrationInvalidContentError
    extends Error {
    constructor() {
        super(
            "Session Organization migration inventory contains invalid display content",
        );
        this.name =
            "SessionOrganizationAccountEncryptionMigrationInvalidContentError";
    }
}

type DisplayRow = Readonly<{
    id: string;
    displayDbValue: string;
    updatedAt: Date;
}>;

type LabelDisplayRow = DisplayRow & Readonly<{
    labelKind: string;
    scopeKey: string;
}>;

type SessionOrganizationDisplayInventory = Readonly<{
    version: number;
    folders: readonly DisplayRow[];
    tags: readonly DisplayRow[];
    labels: readonly LabelDisplayRow[];
}>;

async function loadDisplayInventory(
    tx: Tx,
    accountId: string,
): Promise<SessionOrganizationDisplayInventory> {
    const [checkpoint, folders, tags, labels] = await Promise.all([
        tx.sessionOrganizationCheckpoint.findUnique({
            where: { accountId },
            select: { version: true },
        }),
        tx.sessionOrganizationFolder.findMany({
            where: { accountId, displayDbValue: { not: null } },
            select: {
                id: true,
                displayDbValue: true,
                updatedAt: true,
            },
        }),
        tx.sessionOrganizationTag.findMany({
            where: { accountId, displayDbValue: { not: null } },
            select: {
                id: true,
                displayDbValue: true,
                updatedAt: true,
            },
        }),
        tx.sessionOrganizationLabel.findMany({
            where: { accountId, displayDbValue: { not: null } },
            select: {
                id: true,
                labelKind: true,
                scopeKey: true,
                displayDbValue: true,
                updatedAt: true,
            },
        }),
    ]);
    return {
        version: checkpoint?.version ?? 0,
        folders: folders.filter(
            (row): row is DisplayRow => row.displayDbValue !== null,
        ),
        tags: tags.filter(
            (row): row is DisplayRow => row.displayDbValue !== null,
        ),
        labels: labels.filter(
            (row): row is LabelDisplayRow => row.displayDbValue !== null,
        ),
    };
}

function parseRequiredStoredDisplay(
    value: string,
): SessionOrganizationContentEnvelope {
    const parsed = parseSessionOrganizationDisplayEnvelope(value);
    if (parsed.status !== "ready" || parsed.display === null) {
        throw new SessionOrganizationAccountEncryptionMigrationInvalidContentError();
    }
    return parsed.display;
}

export async function readSessionOrganizationAccountEncryptionMigrationInventoryInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
    }>,
): Promise<SessionOrganizationAccountEncryptionMigrationInventory> {
    const inventory = await loadDisplayInventory(
        params.tx,
        params.accountId,
    );
    const parsed =
        SessionOrganizationAccountEncryptionMigrationInventorySchema.safeParse({
        version: inventory.version,
        folders: inventory.folders.map((row) => ({
            folderId: row.id,
            display: parseRequiredStoredDisplay(row.displayDbValue),
        })),
        tags: inventory.tags.map((row) => ({
            tagId: row.id,
            display: parseRequiredStoredDisplay(row.displayDbValue),
        })),
        labels: inventory.labels.map((row) => ({
            labelKind:
                row.labelKind as SessionOrganizationLabel["labelKind"],
            scopeKey: row.scopeKey,
            display: parseRequiredStoredDisplay(row.displayDbValue),
        })),
    });
    if (!parsed.success) {
        throw new SessionOrganizationAccountEncryptionMigrationInvalidContentError();
    }
    return parsed.data;
}

function storedDisplayIsValid(value: string): boolean {
    const parsed = parseSessionOrganizationDisplayEnvelope(value);
    return parsed.status === "ready" && parsed.display !== null;
}

function serializeDirectiveDisplay(
    display: SessionOrganizationContentEnvelope,
): string | null {
    try {
        return serializeSessionOrganizationDisplayEnvelope(display);
    } catch {
        return null;
    }
}

function labelIdentity(labelKind: string, scopeKey: string): string {
    return `${labelKind}\u0000${scopeKey}`;
}

function hasDuplicateIdentities(
    values: readonly string[],
): boolean {
    return new Set(values).size !== values.length;
}

function directiveModesAreValid(
    toMode: "plain" | "e2ee",
    directive: Extract<
        SessionOrganizationAccountEncryptionMigrationDirective,
        { action: "migrate" }
    >,
): boolean {
    const sourceType = toMode === "plain" ? "encrypted" : "plain";
    const targetType = toMode === "plain" ? "plain" : "encrypted";
    return [
        ...directive.folders,
        ...directive.tags,
        ...directive.labels,
    ].every(
        (item) =>
            item.expectedDisplay.t === sourceType
            && item.display.t === targetType
            && serializeDirectiveDisplay(item.expectedDisplay) !== null
            && serializeDirectiveDisplay(item.display) !== null,
    );
}

function inventoryMatchesDirective(params: Readonly<{
    inventory: SessionOrganizationDisplayInventory;
    directive: Extract<
        SessionOrganizationAccountEncryptionMigrationDirective,
        { action: "migrate" }
    >;
    useTarget: boolean;
}>): boolean {
    const { inventory, directive, useTarget } = params;
    if (
        inventory.folders.length !== directive.folders.length
        || inventory.tags.length !== directive.tags.length
        || inventory.labels.length !== directive.labels.length
    ) {
        return false;
    }
    const folderById = new Map(inventory.folders.map((row) => [row.id, row]));
    const tagById = new Map(inventory.tags.map((row) => [row.id, row]));
    const labelByIdentity = new Map(
        inventory.labels.map((row) => [
            labelIdentity(row.labelKind, row.scopeKey),
            row,
        ]),
    );
    return directive.folders.every((item) => {
        const row = folderById.get(item.folderId);
        const expected = useTarget ? item.display : item.expectedDisplay;
        return row !== undefined
            && storedDisplayIsValid(row.displayDbValue)
            && row.displayDbValue === serializeDirectiveDisplay(expected);
    }) && directive.tags.every((item) => {
        const row = tagById.get(item.tagId);
        const expected = useTarget ? item.display : item.expectedDisplay;
        return row !== undefined
            && storedDisplayIsValid(row.displayDbValue)
            && row.displayDbValue === serializeDirectiveDisplay(expected);
    }) && directive.labels.every((item) => {
        const row = labelByIdentity.get(
            labelIdentity(item.labelKind, item.scopeKey),
        );
        const expected = useTarget ? item.display : item.expectedDisplay;
        return row !== undefined
            && storedDisplayIsValid(row.displayDbValue)
            && row.displayDbValue === serializeDirectiveDisplay(expected);
    });
}

function directiveHasUniqueIdentities(
    directive: Extract<
        SessionOrganizationAccountEncryptionMigrationDirective,
        { action: "migrate" }
    >,
): boolean {
    return !hasDuplicateIdentities(
        directive.folders.map((item) => item.folderId),
    ) && !hasDuplicateIdentities(
        directive.tags.map((item) => item.tagId),
    ) && !hasDuplicateIdentities(
        directive.labels.map((item) =>
            labelIdentity(item.labelKind, item.scopeKey)),
    );
}

function inventoryContentIsValid(
    inventory: SessionOrganizationDisplayInventory,
): boolean {
    return [
        ...inventory.folders,
        ...inventory.tags,
        ...inventory.labels,
    ].every((row) => storedDisplayIsValid(row.displayDbValue));
}

export async function migrateSessionOrganizationAccountEncryptionInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive:
        SessionOrganizationAccountEncryptionMigrationDirective;
    }>,
): Promise<SessionOrganizationAccountEncryptionMigrationResult> {
    const inventory = await loadDisplayInventory(
        params.tx,
        params.accountId,
    );
    if (params.directive.action === "assert_empty") {
        return inventory.folders.length === 0
            && inventory.tags.length === 0
            && inventory.labels.length === 0
            ? { status: "applied" }
            : { status: "not_empty" };
    }
    if (!directiveModesAreValid(params.toMode, params.directive)) {
        return { status: "invalid_content" };
    }
    if (!inventoryContentIsValid(inventory)) {
        return { status: "invalid_content" };
    }
    if (
        inventory.version !== params.directive.expectedVersion
        || !directiveHasUniqueIdentities(params.directive)
        || !inventoryMatchesDirective({
            inventory,
            directive: params.directive,
            useTarget: false,
        })
    ) {
        return { status: "migration_incomplete" };
    }

    const checkpoint = await params.tx.sessionOrganizationCheckpoint.updateMany({
        where: {
            accountId: params.accountId,
            version: params.directive.expectedVersion,
        },
        data: { version: params.directive.expectedVersion + 1 },
    });
    if (checkpoint.count !== 1) {
        throw new SessionOrganizationAccountEncryptionMigrationConflictError();
    }

    const folderById = new Map(inventory.folders.map((row) => [row.id, row]));
    const tagById = new Map(inventory.tags.map((row) => [row.id, row]));
    const labelByIdentity = new Map(
        inventory.labels.map((row) => [
            labelIdentity(row.labelKind, row.scopeKey),
            row,
        ]),
    );
    for (const item of params.directive.folders) {
        const row = folderById.get(item.folderId)!;
        const updated = await params.tx.sessionOrganizationFolder.updateMany({
            where: {
                accountId: params.accountId,
                id: item.folderId,
                displayDbValue: row.displayDbValue,
            },
            data: {
                displayDbValue:
                    serializeDirectiveDisplay(item.display)!,
                updatedAt: row.updatedAt,
            },
        });
        if (updated.count !== 1) {
            throw new SessionOrganizationAccountEncryptionMigrationConflictError();
        }
    }
    for (const item of params.directive.tags) {
        const row = tagById.get(item.tagId)!;
        const updated = await params.tx.sessionOrganizationTag.updateMany({
            where: {
                accountId: params.accountId,
                id: item.tagId,
                displayDbValue: row.displayDbValue,
            },
            data: {
                displayDbValue:
                    serializeDirectiveDisplay(item.display)!,
                updatedAt: row.updatedAt,
            },
        });
        if (updated.count !== 1) {
            throw new SessionOrganizationAccountEncryptionMigrationConflictError();
        }
    }
    for (const item of params.directive.labels) {
        const row = labelByIdentity.get(
            labelIdentity(item.labelKind, item.scopeKey),
        )!;
        const updated = await params.tx.sessionOrganizationLabel.updateMany({
            where: {
                accountId: params.accountId,
                id: row.id,
                displayDbValue: row.displayDbValue,
            },
            data: {
                displayDbValue:
                    serializeDirectiveDisplay(item.display)!,
                updatedAt: row.updatedAt,
            },
        });
        if (updated.count !== 1) {
            throw new SessionOrganizationAccountEncryptionMigrationConflictError();
        }
    }

    await markSessionOrganizationDisplayMigrationChanged(params.tx, {
        accountId: params.accountId,
        folderIds: params.directive.folders.map((item) => item.folderId),
        tagIds: params.directive.tags.map((item) => item.tagId),
        scopeKeys: params.directive.labels.map((item) => item.scopeKey),
    });
    return { status: "applied" };
}

export async function matchSessionOrganizationAccountEncryptionMigrationPostStateInTx(
    params: Readonly<{
        tx: Tx;
        accountId: string;
        toMode: "plain" | "e2ee";
        directive:
        SessionOrganizationAccountEncryptionMigrationDirective;
    }>,
): Promise<SessionOrganizationAccountEncryptionMigrationPostStateResult> {
    const inventory = await loadDisplayInventory(
        params.tx,
        params.accountId,
    );
    if (params.directive.action === "assert_empty") {
        return inventory.folders.length === 0
            && inventory.tags.length === 0
            && inventory.labels.length === 0
            ? { status: "matched" }
            : { status: "mismatch" };
    }
    if (
        !directiveModesAreValid(params.toMode, params.directive)
        || !inventoryContentIsValid(inventory)
        || !directiveHasUniqueIdentities(params.directive)
        || inventory.version !== params.directive.expectedVersion + 1
        || !inventoryMatchesDirective({
            inventory,
            directive: params.directive,
            useTarget: true,
        })
    ) {
        return { status: "mismatch" };
    }
    return { status: "matched" };
}
