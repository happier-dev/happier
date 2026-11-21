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

const TIGHT_BEFORE = new Set(['.', ',', ')', ']', ';', ':']);
const TIGHT_AFTER = new Set(['.', '(', '[', ':']);
/** Words a parenthesis keeps its space after ("in (?, ?)"); any other name before one is a call ("count(*)"). */
const SPACED_BEFORE_PAREN = new Set(['and', 'as', 'by', 'exists', 'from', 'in', 'into', 'join', 'not', 'on', 'or', 'over',
    'select', 'set', 'then', 'using', 'values', 'when', 'where', 'with', 'else', 'union', 'all', 'any', 'some', 'returning']);

/**
 * The person-facing text of a statement shape. The shape joins every lexical token with one space and stays the
 * fingerprint key; this reads it as SQL: no space around `.`, `::` and inside brackets, none before `,`, and a call's
 * parenthesis against its name. Quoted names keep their own spaces.
 */
export function displayDatabaseStatementShape(shape: string): string {
    const tokens = shape.match(/"(?:[^"]|"")*"|`(?:[^`]|``)*`|\S+/g) ?? [];
    let text = '';
    tokens.forEach((token, index) => {
        const previous = tokens[index - 1];
        const tight = previous === undefined || TIGHT_BEFORE.has(token) || TIGHT_AFTER.has(previous)
            || (token === '(' && /^[A-Za-z_][\w$]*$/.test(previous) && !SPACED_BEFORE_PAREN.has(previous.toLowerCase()));
        text += (tight ? '' : ' ') + token;
    });
    return text;
}
