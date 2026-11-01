/**
 * Row selection for the session TURN projection.
 *
 * The transcript navigation rail needs one anchor per user turn plus the reply preview shown
 * under it. Today the client gets that by fetching `roles=user,agent` and paging backwards
 * until it has collected enough user turns — but it uses only the LAST reply row of each turn
 * and discards the rest, so an agent-heavy session transfers and decrypts hundreds of rows to
 * keep a handful. Measured on device 2026-08-18: 630 messages fetched and decrypted for a
 * transcript that needed 48.
 *
 * This computes the same set in the database instead: every user row, plus the last `agent`
 * row of each turn, plus the last `tool` row of each turn. The tool row is not optional — the
 * client's preview falls back to tool text when a turn produced no agent text
 * (`activeAgentPreview ?? activeToolPreview` in `buildUserTurnDrafts`), so omitting it would
 * silently blank the subtitle on tool-only turns.
 *
 * It selects IDS ONLY. The caller hydrates those ids through the normal Prisma select, so the
 * response shape, the stored-content envelope and every existing mapper stay untouched and the
 * raw SQL can never influence what a row looks like — only which rows are returned.
 *
 * A turn is a purely STRUCTURAL notion here (`seq` order plus `messageRole`), which is what
 * makes this legal against end-to-end encrypted content: the server never reads a message body.
 */

/**
 * Dialects this server runs against. `pglite` speaks Postgres, so it maps onto `postgres`
 * rather than becoming a fourth branch.
 */
export type SessionTurnProjectionDialect = "postgres" | "sqlite" | "mysql";

export function quoteSessionTurnProjectionIdentifier(
    dialect: SessionTurnProjectionDialect,
    identifier: string,
): string {
    // Identifiers are compile-time constants from the Prisma schema, never user input; the
    // guard is here so that stays true if someone later threads a value through.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Unsafe SQL identifier: ${identifier}`);
    }
    return dialect === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
}

/**
 * Placeholder syntax differs by dialect and `$queryRawUnsafe` passes the string through
 * verbatim, so it has to be emitted correctly rather than normalised later.
 */
export function sessionTurnProjectionPlaceholder(
    dialect: SessionTurnProjectionDialect,
    oneBasedIndex: number,
): string {
    return dialect === "postgres" ? `$${oneBasedIndex}` : "?";
}

export type SessionTurnProjectionSqlInput = Readonly<{
    dialect: SessionTurnProjectionDialect;
    /** Main chain when null; a sidechain id restricts the projection to that chain. */
    sidechainId: string | null;
    /** Exclusive upper bound for backward paging; omitted on the newest page. */
    hasBeforeSeq: boolean;
}>;

export type SessionTurnProjectionSql = Readonly<{
    sql: string;
    /** Names of the bound values, in the order the caller must supply them. */
    parameterOrder: readonly string[];
}>;

/**
 * Builds the id-selection statement.
 *
 * Seek the newest prompts first, then resolve each selected turn's final replies. The only
 * window runs over the bounded prompt page, never over the session's event-heavy history.
 */
export function buildSessionTurnProjectionIdsSql(
    input: SessionTurnProjectionSqlInput,
): SessionTurnProjectionSql {
    const { dialect } = input;
    const ident = (name: string) => quoteSessionTurnProjectionIdentifier(dialect, name);
    const parameterOrder: string[] = [];
    // Placeholders MUST be emitted in the order they appear in the statement: SQLite and MySQL
    // bind `?` positionally, so a helper that is called out of textual order silently binds
    // every value to the wrong slot. `bind` is therefore only ever called inline, at the exact
    // point the placeholder is written, and `parameterOrder` is the caller's argument order.
    const bind = (name: string): string => {
        parameterOrder.push(name);
        return sessionTurnProjectionPlaceholder(dialect, parameterOrder.length);
    };

    const table = ident("SessionMessage");
    const colSession = ident("sessionId");
    const colSidechain = ident("sidechainId");
    const colSeq = ident("seq");
    const colRole = ident("messageRole");
    const colId = ident("id");

    const scopeWhere = (alias = "") => {
        const prefix = alias ? `${alias}.` : "";
        return `${prefix}${colSession} = ${bind("sessionId")} AND ${prefix}${colSidechain} `
            + (input.sidechainId === null ? "IS NULL" : `= ${bind("sidechainId")}`);
    };

    // A NULL role is a legacy prompt. Separate equality seeks let all engines use the
    // existing (sessionId, sidechainId, messageRole, seq) index; an OR/IN plus ordering can
    // instead choose the sequence index and walk every event row (#661).
    const parts: string[] = ["WITH "];
    for (const [index, name] of ["user_prompts", "legacy_prompts"].entries()) {
        if (index > 0) parts.push(",\n");
        parts.push(`${name} AS (
    SELECT ${colId}, ${colSeq} FROM ${table}
    WHERE ${scopeWhere()} AND ${colRole} ${index === 0 ? `= ${bind("userRole")}` : "IS NULL"}`);
        if (input.hasBeforeSeq) parts.push(` AND ${colSeq} < ${bind("beforeSeq")}`);
        parts.push(`
    ORDER BY ${colSeq} DESC LIMIT ${bind("turnLimit")}
)`);
    }
    parts.push(`,
recent AS (
    SELECT ${colId}, ${colSeq} FROM (
        SELECT ${colId}, ${colSeq} FROM user_prompts
        UNION ALL
        SELECT ${colId}, ${colSeq} FROM legacy_prompts
    ) candidates
    ORDER BY ${colSeq} DESC LIMIT ${bind("turnLimit")}
),
turns AS (
    SELECT ${colId}, ${colSeq}, LEAD(${colSeq}) OVER (ORDER BY ${colSeq}) AS next_seq
    FROM recent
),
picked AS (
    SELECT ${colId} FROM turns`);

    for (const roleParam of ["agentRole", "toolRole"] as const) {
        parts.push(`
    UNION ALL
    SELECT (
        SELECT reply.${colId} FROM ${table} reply
        WHERE ${scopeWhere("reply")} AND reply.${colRole} = ${bind(roleParam)}
            AND reply.${colSeq} > turns.${colSeq}
            AND reply.${colSeq} <= COALESCE(turns.next_seq - 1, `);
        // The newest selected turn ends at the cursor, or at the chain's current tail.
        // MAX uses the existing chain/seq index and does not walk message history. Keeping
        // this as a range bound (rather than an OR) also bounds older turns' reply seeks.
        parts.push(input.hasBeforeSeq
            ? `${bind("beforeSeq")} - 1`
            : `(SELECT MAX(edge.${colSeq}) FROM ${table} edge WHERE ${scopeWhere("edge")})`);
        parts.push(`)
        ORDER BY reply.${colSeq} DESC LIMIT 1
    ) AS ${colId} FROM turns`);
    }

    parts.push(`
)
SELECT ${colId} FROM picked WHERE ${colId} IS NOT NULL`);

    return { sql: parts.join("").trim(), parameterOrder };
}
