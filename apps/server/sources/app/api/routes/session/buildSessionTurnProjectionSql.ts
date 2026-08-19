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
 * Window functions are used by all three dialects (Postgres 9.4+, SQLite 3.25+, MySQL 8.0+).
 * The frame is stated explicitly rather than relying on the default, because the default frame
 * is RANGE-based and would behave differently in the presence of ties.
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

    // A NULL role predates the role column and is treated as `user` everywhere else on this
    // route (`buildRequestedMessageRoleWhere`), so it must open a turn here too — otherwise
    // legacy rows shift every turn boundary. Each occurrence binds its OWN placeholder,
    // because a reused `?` consumes a further argument under positional binding.
    const isUserRow = () => `(${colRole} IS NULL OR ${colRole} = ${bind("userRole")})`;

    const parts: string[] = [];
    parts.push(`WITH scoped AS (
    SELECT ${colId}, ${colSeq}, ${colRole}
    FROM ${table}
    WHERE ${colSession} = ${bind("sessionId")} AND `);
    parts.push(input.sidechainId === null
        ? `${colSidechain} IS NULL`
        : `${colSidechain} = ${bind("sidechainId")}`);
    if (input.hasBeforeSeq) parts.push(` AND ${colSeq} < ${bind("beforeSeq")}`);
    parts.push(`
),
turned AS (
    SELECT scoped.*, SUM(CASE WHEN ${isUserRow()} THEN 1 ELSE 0 END) OVER (
        ORDER BY ${colSeq} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS turn_no
    FROM scoped
),
anchors AS (
    SELECT DISTINCT turn_no FROM turned WHERE ${isUserRow()}
),
recent AS (
    SELECT turn_no FROM anchors ORDER BY turn_no DESC LIMIT ${bind("turnLimit")}
),
picked AS (
    SELECT ${colId} FROM turned WHERE ${isUserRow()} AND turn_no IN (SELECT turn_no FROM recent)`);

    // The last reply row of each RECENT turn. Restricting to `recent` inside the subquery
    // matters: without it this returns the last reply of every turn in the whole session,
    // which is the over-fetch this projection exists to remove.
    for (const roleParam of ["agentRole", "toolRole"] as const) {
        parts.push(`
    UNION ALL
    SELECT ranked.${colId} FROM (
        SELECT ${colId}, turn_no, ROW_NUMBER() OVER (
            PARTITION BY turn_no ORDER BY ${colSeq} DESC
        ) AS rn
        FROM turned
        WHERE ${colRole} = ${bind(roleParam)}
    ) ranked
    WHERE ranked.rn = 1 AND ranked.turn_no IN (SELECT turn_no FROM recent)`);
    }

    parts.push(`
)
SELECT ${colId} FROM picked`);

    return { sql: parts.join("").trim(), parameterOrder };
}
