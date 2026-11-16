import { fingerprintDatabaseStatement, normalizeDatabaseTokens, type NormalizedDatabaseStatement } from '../statement.js';
import { PostgresqlInputError, psqlInputScanner, type PostgresqlLexicalToken, type PostgresqlStatementRange } from './input.js';

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

function statementWords(sql: string, tokens: readonly PostgresqlLexicalToken[]): string[] {
    const words: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        const raw = sql.slice(token.start, token.end);
        const ampersand = tokens[index + 1];
        const quoted = tokens[index + 2];
        if (token.kind === 'word' && /^u$/i.test(raw) && ampersand?.kind === 'symbol'
            && sql.slice(ampersand.start, ampersand.end) === '&' && quoted?.kind === 'identifier'
            && token.end === ampersand.start && ampersand.end === quoted.start) {
            let escape = '\\';
            const escapeWord = tokens[index + 3];
            const escapeValue = tokens[index + 4];
            if (escapeWord?.kind === 'word' && /^uescape$/i.test(sql.slice(escapeWord.start, escapeWord.end)) && escapeValue?.kind === 'literal') {
                escape = sql.slice(escapeValue.start + 1, escapeValue.end - 1).replace(/''/g, "'");
                index += 2;
            }
            const value = sql.slice(quoted.start + 1, quoted.end - 1).replace(/""/g, '"');
            let decoded = '';
            for (let offset = 0; offset < value.length; offset++) {
                if (value[offset] !== escape) { decoded += value[offset]; continue; }
                if (value[offset + 1] === escape) { decoded += escape; offset++; continue; }
                const digits = value[offset + 1] === '+' ? 6 : 4;
                const start = offset + (digits === 6 ? 2 : 1);
                const hex = value.slice(start, start + digits);
                if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex)) { decoded += value[offset]; continue; }
                const point = Number.parseInt(hex, 16);
                if (point > 0x10ffff) { decoded += value[offset]; continue; }
                decoded += String.fromCodePoint(point);
                offset = start + digits - 1;
            }
            words.push(decoded.toUpperCase());
            index += 2;
        } else if (token.kind === 'word' || token.kind === 'identifier') {
            words.push((token.kind === 'identifier' ? raw.slice(1, -1).replace(/""/g, '"') : raw).toUpperCase());
        } else words.push('');
    }
    return words;
}

/** The engine enforces read/write effects; this boundary only keeps a console
 * statement inside its caller-owned transaction and transaction mode. */
export function admitPostgresqlWorkbenchStatement(sql: string): string {
    const tokens: PostgresqlLexicalToken[] = [];
    const scanner = psqlInputScanner('query', { token: token => tokens.push(token) });
    scanner.write(sql, true);
    const statement = sql.slice(0, scanner.statementEnd);
    const words = statementWords(statement, tokens);
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
