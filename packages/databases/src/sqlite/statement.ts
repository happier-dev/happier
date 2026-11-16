import { DatabaseStatementError, databaseStatementWords, normalizeScannedStatement, scanSqlStatements } from '../statement.js';

export const scanSqliteStatements = (sql: string) => scanSqlStatements(sql, 'sqlite');
export const sqliteStatementRanges = (sql: string) => scanSqlStatements(sql, 'sqlite').ranges;
export const normalizeSqliteStatement = (sql: string) => normalizeScannedStatement(sql, scanSqlStatements(sql, 'sqlite'));

/** File read-only opening enforces effects; the statement boundary keeps the
 * operation inside its owning transaction and selected database. */
export function admitSqliteWorkbenchStatement(sql: string): string {
    const { tokens, ranges } = scanSqlStatements(sql, 'sqlite');
    if (ranges.length !== 1) throw new DatabaseStatementError('unsupported_multi_result');
    const words = databaseStatementWords(sql, tokens);
    const first = words[0];
    const transaction = ['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE'].includes(first ?? '');
    // SQLite also accepts a string-literal PRAGMA name and an optional schema.
    // Read-only introspection has no argument; both assignment syntaxes mutate.
    const pragmaNameIndex = sql.slice(tokens[2]?.start, tokens[2]?.end) === '.' ? 3 : 1;
    const pragmaNameToken = tokens[pragmaNameIndex];
    const pragmaName = pragmaNameToken?.kind === 'literal'
        ? sql.slice(pragmaNameToken.start + 1, pragmaNameToken.end - 1).replace(/''/g, "'").toUpperCase()
        : words[pragmaNameIndex];
    const pragmaArgument = tokens[pragmaNameIndex + 1];
    const modeSetting = first === 'PRAGMA' && pragmaName === 'QUERY_ONLY' && pragmaArgument?.kind === 'symbol'
        && ['=', '('].includes(sql.slice(pragmaArgument.start, pragmaArgument.end));
    // Read-only main-file opening still permits ATTACH writes and VACUUM INTO
    // to another file. Both cross this operation's selected-file boundary.
    const otherFile = first === 'ATTACH' || first === 'DETACH' || (first === 'VACUUM' && words.includes('INTO'));
    if (transaction || modeSetting || otherFile) throw new DatabaseStatementError('sqlite_transaction_control');
    return sql.slice(ranges[0]!.start, ranges[0]!.end);
}
