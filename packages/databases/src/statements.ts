import { DatabaseStatementError, projectDatabaseParameterSlots, scanSqlStatements, type DatabaseLexicalToken,
    type DatabaseStatementParameterSlotV1, type DatabaseStatementRange, type MysqlLexicalOptions } from './lexer.js';
import { psqlInputScanner } from './postgresql/input.js';

export { DatabaseStatementError, type DatabaseStatementParameterSlotV1 } from './lexer.js';
export { PostgresqlInputError } from './postgresql/input.js';
export type DatabaseConsoleStatementV1 = DatabaseStatementRange & Readonly<{
    parameterSlots: readonly DatabaseStatementParameterSlotV1[];
}>;

/** Browser-safe Console projection of the native operation lexers. */
export function databaseStatementRangesV1(sql: string, engine: string, options?: MysqlLexicalOptions): readonly DatabaseStatementRange[] {
    if (!sql.trim()) return [];
    if (engine === 'postgresql') return postgresqlStatementRanges(sql);
    if (engine === 'mysql' || engine === 'sqlite') return scanSqlStatements(sql, engine, options).ranges;
    throw new DatabaseStatementError('unsupported_database_engine');
}

/** Statement boundaries and parameter slots from the same lexical pass. */
export function databaseConsoleStatementsV1(sql: string, engine: string, options?: MysqlLexicalOptions): readonly DatabaseConsoleStatementV1[] {
    if (!sql.trim()) return [];
    if (engine === 'postgresql') {
        const statements: DatabaseConsoleStatementV1[] = [];
        const parameters: DatabaseLexicalToken[] = [];
        psqlInputScanner('statements', {
            token(token) { if (token.kind === 'parameter') parameters.push(token); },
            statement(range) {
                statements.push({ ...range, parameterSlots: projectDatabaseParameterSlots(sql, engine, parameters) });
                parameters.length = 0;
            },
        }).write(sql, true);
        return statements;
    }
    if (engine === 'mysql' || engine === 'sqlite') {
        const { tokens, ranges } = scanSqlStatements(sql, engine, options);
        let cursor = 0;
        return ranges.map(range => {
            const start = cursor;
            while (cursor < tokens.length && tokens[cursor]!.end <= range.end) cursor++;
            return { ...range, parameterSlots: projectDatabaseParameterSlots(sql, engine, tokens, start, cursor) };
        });
    }
    throw new DatabaseStatementError('unsupported_database_engine');
}

export function postgresqlStatementRanges(sql: string): readonly DatabaseStatementRange[] {
    const ranges: DatabaseStatementRange[] = [];
    psqlInputScanner('statements', { statement: range => ranges.push(range) }).write(sql, true);
    return ranges;
}
