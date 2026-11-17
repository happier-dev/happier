import { DatabaseStatementError, scanSqlStatements, type DatabaseStatementRange, type MysqlLexicalOptions } from './lexer.js';
import { psqlInputScanner } from './postgresql/input.js';

/** Browser-safe Console projection of the native operation lexers. */
export function databaseStatementRangesV1(sql: string, engine: string, options?: MysqlLexicalOptions): readonly DatabaseStatementRange[] {
    if (!sql.trim()) return [];
    if (engine === 'postgresql') return postgresqlStatementRanges(sql);
    if (engine === 'mysql' || engine === 'sqlite') return scanSqlStatements(sql, engine, options).ranges;
    throw new DatabaseStatementError('unsupported_database_engine');
}

export function postgresqlStatementRanges(sql: string): readonly DatabaseStatementRange[] {
    const ranges: DatabaseStatementRange[] = [];
    psqlInputScanner('statements', { statement: range => ranges.push(range) }).write(sql, true);
    return ranges;
}
