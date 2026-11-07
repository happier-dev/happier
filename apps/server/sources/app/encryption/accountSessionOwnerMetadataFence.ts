import { getTransactionContext, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import { resolveDbSqlDialect } from "@/config/databaseProvider";
import type { DbProvider } from "@/storage/db";

export type AccountAdmissionIntent = "content" | "serializing" | "exclusive";

const admissionStrength = { content: 0, serializing: 1, exclusive: 2 } as const;

const admissionSymbol = Symbol("account-admission");
const attributionSymbol = Symbol("account-admission-attribution");
type AccountAdmission = { readonly strength: number; held: boolean };
type AdmissionContext = {
    [admissionSymbol]?: ReadonlyMap<string, AccountAdmission>;
    [attributionSymbol]?: boolean;
};

function assertManagedAdmissionAudience(tx: Tx, ids: readonly string[], strength: number) {
    const context = getTransactionContext(tx, { optional: true });
    // Unmanaged callers retain the primitive SQL contract. Read snapshots do
    // not participate in a managed write transaction's publication ordering.
    if (!context || context.readOnly) return;
    const owner = context as typeof context & AdmissionContext;
    const admitted = owner[admissionSymbol];
    if (!admitted) {
        return owner[admissionSymbol] = new Map(ids.map(id => [id, { strength, held: false }]));
    }
    if (ids.some(id => !admitted.has(id) || strength > admitted.get(id)!.strength)) {
        // The first batch must contain all prospective publication recipients.
        // Never acquire a newly discovered or stronger lock after domain work.
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    return admitted;
}

/** Verify queued recipients against the same entry cohort, without acquiring locks. */
export function assertAccountSessionOwnerMetadataAdmissionAudienceInTx(tx: Tx, accountIds: readonly string[]): void {
    // SQLite's single writer cannot form a row-lock audience cycle. Its Session
    // writers deliberately avoid the row-provider audience census.
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return;
    const context = getTransactionContext(tx, { optional: true });
    if (!context || context.readOnly) return;
    const admitted = (context as typeof context & AdmissionContext)[admissionSymbol];
    // Pure allocator consumers have no domain admission cohort to extend.
    if (admitted && accountIds.some(id => !admitted.has(id))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
}

/** Lock the complete terminal audience, reusing native locks held by entry admission. */
export async function acquireAccountSessionOwnerMetadataPublicationFencesInTx(tx: Tx, accountIds: readonly string[]): Promise<void> {
    const ids = [...new Set(accountIds)].sort();
    assertAccountSessionOwnerMetadataAdmissionAudienceInTx(tx, ids);
    if (ids.length === 0) return;
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (dialect === 'postgres') {
        const context = getTransactionContext(tx, { optional: true });
        const admitted = (context as (typeof context & AdmissionContext))?.[admissionSymbol];
        // NO KEY UPDATE and UPDATE already exclude concurrent publication.
        // KEY SHARE deliberately permits it during domain work, so content
        // admission must still acquire the sorted terminal publication locks.
        if (admitted && ids.every(id => {
            const admission = admitted.get(id);
            return admission?.held && admission.strength >= admissionStrength.serializing;
        })) return;
        await tx.$queryRawUnsafe(
            'SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE', ids,
        );
    } else if (dialect === 'mysql') {
        await tx.$queryRawUnsafe(
            `SELECT \`id\` FROM \`Account\` WHERE \`id\` IN (${ids.map(() => '?').join(', ')}) ORDER BY \`id\` FOR UPDATE`,
            ...ids,
        );
    }
}

export class AccountSessionOwnerMetadataFenceAccountNotFoundError extends Error {
    constructor(accountId: string) {
        super(
            `Account Session owner-metadata fence requires exactly one Account row for ${accountId}`,
        );
        this.name = "AccountSessionOwnerMetadataFenceAccountNotFoundError";
    }
}

function assertExactlyOneAccountRow(
    rowCount: number,
    accountId: string,
): void {
    if (rowCount === 0) {
        throw new AccountSessionOwnerMetadataFenceAccountNotFoundError(accountId);
    }
    if (rowCount !== 1) {
        throw new Error(
            `Account Session owner-metadata fence requires exactly one Account row for ${accountId}`,
        );
    }
}

/**
 * Admits ordinary content before resource locking, serializes aggregate writers
 * compatibly with content admission, or excludes content for Account authority
 * changes. PostgreSQL publication later takes NO KEY UPDATE; callers must choose
 * their strongest intent at entry rather than upgrading after domain work.
 *
 * PostgreSQL-compatible providers and MySQL lock the Account row directly. SQLite reserves
 * the database writer with a bound no-op column update so Prisma's `@updatedAt` behavior is
 * not invoked.
 */
export async function acquireAccountSessionOwnerMetadataFenceInTx(
    tx: Tx,
    accountId: string,
    intent: AccountAdmissionIntent,
    provider: DbProvider = getDbProviderFromEnv(process.env, "postgres"),
): Promise<void> {
    const ids = await acquireAccountSessionOwnerMetadataFencesInTx(tx, [accountId], intent, provider);
    assertExactlyOneAccountRow(ids.length, accountId);
}

/** Admit a complete sorted audience; absent recipients are not publication targets. */
export async function acquireAccountSessionOwnerMetadataFencesInTx(
    tx: Tx,
    accountIds: readonly string[],
    intent: AccountAdmissionIntent,
    provider: DbProvider = getDbProviderFromEnv(process.env, "postgres"),
): Promise<readonly string[]> {
    const ids = [...new Set(accountIds)].sort();
    if (ids.length === 0) return [];
    const dialect = resolveDbSqlDialect(provider);
    const admitted = dialect !== "sqlite"
        ? assertManagedAdmissionAudience(tx, ids, admissionStrength[dialect === "mysql" ? "exclusive" : intent]) : undefined;
    // Native row locks survive until the containing attempt ends. Nested
    // owners need no second SQL/budget refresh for an already-held cohort.
    // Missing rows and failed acquisitions must never count as held locks;
    // unmanaged/read-snapshot callers retain their primitive SQL behavior.
    if (admitted && ids.every(id => admitted.get(id)?.held)) return ids;

    if (dialect === "sqlite") {
        const present: string[] = [];
        for (const id of ids) {
            const affectedRows = await tx.$executeRawUnsafe(
                'UPDATE "Account" SET "settingsVersion" = "settingsVersion" WHERE "id" = ?',
                id,
            );
            if (affectedRows !== 0) {
                assertExactlyOneAccountRow(affectedRows, id);
                present.push(id);
            }
        }
        return present;
    }

    const mode = intent === "content" ? "KEY SHARE" : intent === "serializing" ? "NO KEY UPDATE" : "UPDATE";
    // MySQL has no compatible key-share/non-key-update pair. Its approved
    // admission contract retains the early exclusive fence for every intent.
    const query = dialect === "mysql"
        ? ids.length === 1
            ? "SELECT `id` FROM `Account` WHERE `id` = ? FOR UPDATE"
            : `SELECT \`id\` FROM \`Account\` WHERE \`id\` IN (${ids.map(() => "?").join(", ")}) ORDER BY \`id\` FOR UPDATE`
        : ids.length === 1
            ? `SELECT "id" FROM "Account" WHERE "id" = $1 FOR ${mode}`
            : `SELECT "id" FROM "Account" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR ${mode}`;
    if (dialect === "postgres") {
        const context = getTransactionContext(tx, { optional: true });
        const owner = context as (typeof context & AdmissionContext);
        if (owner && !owner.readOnly && !owner[attributionSymbol]) {
            const requestId = owner.requestId ?? "unattributed";
            const transactionClass = /^[a-zA-Z0-9._-]+$/.test(owner.transactionClass)
                ? owner.transactionClass : "unspecified";
            // PostgreSQL application_name has 63 usable bytes. Keep the full
            // validated request identity and as much of the existing class as fits.
            const applicationName = `${transactionClass.slice(0, 63 - requestId.length - 1)}:${requestId}`;
            // A utility SET leaves the first Serializable snapshot to the
            // Account lock. SELECT set_config (including inside DO) does not.
            // Both components are restricted ASCII, never SQL/input content.
            await tx.$executeRawUnsafe(`SET LOCAL application_name = '${applicationName}'`);
            owner[attributionSymbol] = true;
        }
    }
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        query,
        ...(dialect === "mysql" || ids.length === 1 ? ids : [ids]),
    );
    const present = rows.map(row => row.id);
    if (new Set(present).size !== present.length) {
        throw new Error(`Account Session owner-metadata fence requires exactly one Account row for ${ids.join(", ")}`);
    }
    for (const id of present) {
        const admission = admitted?.get(id);
        if (admission) admission.held = true;
    }
    return present;
}
