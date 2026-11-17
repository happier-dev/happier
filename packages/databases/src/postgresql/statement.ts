import { fingerprintDatabaseStatement, normalizeDatabaseTokens, type NormalizedDatabaseStatement } from '../statement.js';
import { PostgresqlInputError, psqlInputScanner, type PostgresqlLexicalToken, type PostgresqlStatementRange } from './input.js';
import { postgresqlStatementWords } from './identifiers.js';

function scan(sql: string, observe?: Readonly<{ token?(token: PostgresqlLexicalToken): void }>) {
    const tokens: PostgresqlLexicalToken[] = [];
    const ranges: PostgresqlStatementRange[] = [];
    const scanner = psqlInputScanner('statements', { token: token => { tokens.push(token); observe?.token?.(token); }, statement: range => ranges.push(range) });
    scanner.write(sql, true);
    return { tokens, ranges };
}

export function postgresqlStatementRanges(sql: string): readonly PostgresqlStatementRange[] {
    const ranges: PostgresqlStatementRange[] = [];
    psqlInputScanner('statements', { statement: range => ranges.push(range) }).write(sql, true);
    return ranges;
}

export function normalizePostgresqlStatement(sql: string, observe?: Readonly<{ token?(token: PostgresqlLexicalToken): void }>): NormalizedDatabaseStatement {
    const { tokens, ranges } = scan(sql, observe);
    if (ranges.length === 1) return normalizeDatabaseTokens(sql, tokens);
    let tokenIndex = 0;
    const shapes = ranges.map(range => {
        const start = tokenIndex;
        while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= range.end) tokenIndex++;
        return normalizeDatabaseTokens(sql, tokens.slice(start, tokenIndex)).shape;
    });
    return fingerprintDatabaseStatement(shapes.join(' ; '));
}


/** The engine enforces read/write effects; this boundary only keeps a console
 * statement inside its caller-owned transaction and transaction mode. */
export function admitPostgresqlWorkbenchStatement(sql: string): string {
    const tokens: PostgresqlLexicalToken[] = [];
    const scanner = psqlInputScanner('query', { token: token => tokens.push(token) });
    scanner.write(sql, true);
    const statement = sql.slice(0, scanner.statementEnd);
    const words = postgresqlStatementWords(statement, tokens);
    const first = words[0];
    let escaped = ['BEGIN', 'COMMIT', 'ROLLBACK', 'END', 'ABORT', 'SAVEPOINT', 'RELEASE'].includes(first ?? '')
        || ((first === 'START' || first === 'PREPARE') && words[1] === 'TRANSACTION');
    if (first === 'SET' || first === 'RESET') {
        const setting = words[1] === 'LOCAL' || words[1] === 'SESSION' ? 2 : 1;
        escaped ||= words[setting] === 'TRANSACTION' || words[setting] === 'TRANSACTION_READ_ONLY'
            || words[setting] === 'DEFAULT_TRANSACTION_READ_ONLY'
            || words[setting] === 'STANDARD_CONFORMING_STRINGS'
            || (first === 'SET' && words[1] === 'SESSION' && words[2] === 'CHARACTERISTICS')
            || (first === 'RESET' && words[1] === 'ALL');
    }
    if (escaped) throw new PostgresqlInputError('unsupported_action', 'postgresql_transaction_control');
    return statement;
}
