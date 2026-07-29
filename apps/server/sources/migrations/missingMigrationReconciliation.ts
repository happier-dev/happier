function normalizeSqlStatement(statement: string): string {
    return String(statement ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/;$/, "")
        .toLowerCase();
}

export function splitMigrationStatements(sql: string): string[] {
    return String(sql ?? "")
        .replace(/^\s*--.*$/gm, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => `${statement};`);
}

export function isLegacyTransactionWrapperStatement(statement: string): boolean {
    const normalized = normalizeSqlStatement(statement);
    return (
        normalized === "begin" ||
        normalized === "begin transaction" ||
        normalized === "start transaction" ||
        normalized === "commit" ||
        normalized === "commit transaction" ||
        normalized === "end" ||
        normalized === "rollback" ||
        normalized === "rollback transaction" ||
        normalized.startsWith("savepoint ") ||
        normalized.startsWith("release savepoint ") ||
        normalized.startsWith("rollback to savepoint ")
    );
}

// Duplicate-name errors prove object identity, not columns, constraints, or nullability.
// Only operations whose required end state is absence can be reconciled without introspection.
export function isSafeMissingMigrationReconciliationStatement(statement: string): boolean {
    const normalized = normalizeSqlStatement(statement);
    return (
        /^drop\s+(index|table|view|sequence|trigger)\s+if\s+exists\b/.test(normalized) ||
        /^alter\s+table\b.+\bdrop\s+(column|constraint)\s+if\s+exists\b/.test(normalized)
    );
}
