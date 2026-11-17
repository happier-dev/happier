import { computeSha256HexDigest } from '@happier-dev/plugin-sdk';
import { scanSqlStatements, type DatabaseLexicalToken, type NormalizedDatabaseStatement } from './lexer.js';
export * from './lexer.js';

/** Fingerprints contain only the masked shape, never original SQL or values. */
export function fingerprintDatabaseStatement(shape: string): NormalizedDatabaseStatement {
    return { shape, fingerprint: computeSha256HexDigest(shape) };
}

export function normalizeDatabaseTokens(sql: string, tokens: readonly DatabaseLexicalToken[]): NormalizedDatabaseStatement {
    const shape: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        const raw = sql.slice(token.start, token.end);
        const next = tokens[index + 1];
        // PostgreSQL/MySQL literal introducers belong to the literal, not its
        // shape. Identifiers with the same spelling remain ordinary tokens.
        if (token.kind === 'word' && /^(?:[ebxn]|_[a-zA-Z0-9_]+)$/i.test(raw) && next?.kind === 'literal' && token.end === next.start) continue;
        if (token.kind === 'word' && /^u$/i.test(raw) && next?.kind === 'symbol'
            && sql.slice(next.start, next.end) === '&' && token.end === next.start
            && tokens[index + 2]?.kind === 'literal' && next.end === tokens[index + 2]!.start) {
            index++; continue;
        }
        shape.push(token.kind === 'literal' || token.kind === 'parameter' || (token.kind === 'word' && /^(null|true|false)$/i.test(raw))
            ? '?' : token.kind === 'word' ? raw.toLowerCase() : raw);
    }
    return fingerprintDatabaseStatement(shape.join(' '));
}

export function normalizeScannedStatement(sql: string, scanned: ReturnType<typeof scanSqlStatements>): NormalizedDatabaseStatement {
    let tokenIndex = 0;
    const shapes = scanned.ranges.map(range => {
        const start = tokenIndex;
        while (tokenIndex < scanned.tokens.length && scanned.tokens[tokenIndex]!.end <= range.end) tokenIndex++;
        return normalizeDatabaseTokens(sql, scanned.tokens.slice(start, tokenIndex)).shape;
    });
    return fingerprintDatabaseStatement(shapes.join(' ; '));
}
