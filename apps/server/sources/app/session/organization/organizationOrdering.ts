import type {
    ReorderSessionOrganizationRequest,
    ReorderSessionOrganizationResponse,
} from "@happier-dev/protocol";

import { inTx } from "@/storage/inTx";
import { hashSessionOrganizationKey } from "./hashKeys";
import { markSessionOrganizationChanged } from "./changes";
import { mapSessionOrganizationOrderEntry } from "./organizationSnapshot";
import {
    validateSessionOrganizationOrderRequest,
    validateSessionOrganizationSessionOrderItems,
} from "./organizationOrderValidation";
import type { SessionOrganizationTx } from "./types";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

interface OrderEntryHashGuardRow {
    readonly scopeKey: string;
    readonly itemKind: string;
    readonly itemKey: string;
    readonly itemHash?: string;
}

function hasSessionOrganizationOrderHashCollision(params: Readonly<{
    request: ReorderSessionOrganizationRequest;
    rows: readonly OrderEntryHashGuardRow[];
}>): boolean {
    const expectedItemKeysByKindAndHash = new Map<string, string>();
    for (const entry of params.request.entries) {
        expectedItemKeysByKindAndHash.set(
            `${entry.itemKind}\u0000${hashSessionOrganizationKey(entry.itemKey)}`,
            entry.itemKey,
        );
    }

    for (const row of params.rows) {
        if (row.scopeKey !== params.request.scopeKey) return true;

        const expectedItemKey = expectedItemKeysByKindAndHash.get(
            `${row.itemKind}\u0000${row.itemHash ?? hashSessionOrganizationKey(row.itemKey)}`,
        );
        if (expectedItemKey !== undefined && expectedItemKey !== row.itemKey) {
            return true;
        }
    }

    return false;
}

export async function reorderSessionPinsInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    request: ReorderSessionOrganizationRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<
    | ReorderSessionOrganizationResponse
    | { readonly error: "invalid-session-organization-order" }
> {
    const valid = await validateSessionOrganizationSessionOrderItems({
        accountId: params.accountId,
        entries: params.request.entries,
        reader: tx,
        authentication: params.authentication,
    });
    if (!valid) {
        return { error: "invalid-session-organization-order" };
    }

    const reorderedEntries: ReorderSessionOrganizationRequest["entries"] = [];
    for (const entry of params.request.entries) {
        // Ordering cannot mint membership, including after a last-unpin commits.
        const updated = await tx.sessionPin.updateMany({
            where: {
                accountId: params.accountId,
                sessionId: entry.itemKey,
                OR: [{ listPinned: true }, { railPinned: true }],
            },
            data: {
                sortKey: entry.sortKey,
            },
        });
        if (updated.count > 0) reorderedEntries.push(entry);
    }

    if (reorderedEntries.length > 0) {
        await markSessionOrganizationChanged(tx, {
            accountId: params.accountId,
            scope: "pins",
            sessionIds: reorderedEntries.map((entry) => entry.itemKey),
        });
    }

    return {
        orderEntries: reorderedEntries.map((entry) => ({
            scopeKind: params.request.scopeKind,
            scopeKey: params.request.scopeKey,
            itemKind: entry.itemKind,
            itemKey: entry.itemKey,
            sortKey: entry.sortKey,
        })),
    };
}

export async function reorderSessionPins(params: Readonly<{
    accountId: string;
    request: ReorderSessionOrganizationRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<
    | ReorderSessionOrganizationResponse
    | { readonly error: "invalid-session-organization-order" }
> {
    return await inTx(async (tx) => await reorderSessionPinsInTx(tx, params));
}

export async function reorderSessionOrganizationInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    request: ReorderSessionOrganizationRequest;
    authentication: SessionAccessAuthentication;
}>) {
    const valid = await validateSessionOrganizationOrderRequest({
        accountId: params.accountId,
        request: params.request,
        reader: tx,
        authentication: params.authentication,
    });
    if (!valid) {
        return { error: "invalid-session-organization-order" };
    }

    const scopeHash = hashSessionOrganizationKey(params.request.scopeKey);
    const retainedEntryPredicates = params.request.entries.map((entry) => ({
        itemKind: entry.itemKind,
        itemHash: hashSessionOrganizationKey(entry.itemKey),
    }));
    const existingRowsMatchingRequestedHashes = await tx.sessionOrganizationOrderEntry.findMany({
        where: {
            accountId: params.accountId,
            scopeKind: params.request.scopeKind,
            OR: [
                { scopeHash },
                ...retainedEntryPredicates.map((predicate) => ({
                    scopeHash,
                    itemKind: predicate.itemKind,
                    itemHash: predicate.itemHash,
                })),
            ],
        },
        select: { scopeKey: true, itemKind: true, itemKey: true, itemHash: true },
    }) as OrderEntryHashGuardRow[];
    if (hasSessionOrganizationOrderHashCollision({
        request: params.request,
        rows: existingRowsMatchingRequestedHashes,
    })) {
        return { error: "invalid-session-organization-order" };
    }

    await tx.sessionOrganizationOrderEntry.deleteMany({
        where: {
            accountId: params.accountId,
            scopeKind: params.request.scopeKind,
            scopeHash,
            ...(retainedEntryPredicates.length > 0
                ? { NOT: { OR: retainedEntryPredicates } }
                : {}),
        },
    });

    for (const entry of params.request.entries) {
        const itemHash = hashSessionOrganizationKey(entry.itemKey);
        await tx.sessionOrganizationOrderEntry.upsert({
            where: {
                accountId_scopeKind_scopeHash_itemKind_itemHash: {
                    accountId: params.accountId,
                    scopeKind: params.request.scopeKind,
                    scopeHash,
                    itemKind: entry.itemKind,
                    itemHash,
                },
            },
            create: {
                accountId: params.accountId,
                scopeKind: params.request.scopeKind,
                scopeKey: params.request.scopeKey,
                scopeHash,
                itemKind: entry.itemKind,
                itemKey: entry.itemKey,
                itemHash,
                sortKey: entry.sortKey,
            },
            update: {
                scopeKey: params.request.scopeKey,
                itemKey: entry.itemKey,
                sortKey: entry.sortKey,
            },
        });
    }

    const orderEntries = await tx.sessionOrganizationOrderEntry.findMany({
        where: {
            accountId: params.accountId,
            scopeKind: params.request.scopeKind,
            scopeHash,
        },
        orderBy: { sortKey: "asc" },
        select: { scopeKind: true, scopeKey: true, itemKind: true, itemKey: true, sortKey: true },
    });
    if (orderEntries.some((entry) => entry.scopeKey !== params.request.scopeKey)) {
        return { error: "invalid-session-organization-order" };
    }

    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "order",
        scopeKeys: [params.request.scopeKey],
    });

    return { orderEntries: orderEntries.map(mapSessionOrganizationOrderEntry) };
}

export async function reorderSessionOrganization(params: Readonly<{
    accountId: string;
    request: ReorderSessionOrganizationRequest;
    authentication: SessionAccessAuthentication;
}>) {
    return await inTx(async (tx) => await reorderSessionOrganizationInTx(tx, params));
}
