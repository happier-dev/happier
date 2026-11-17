export type DatabaseStatementRange = Readonly<{ start: number; end: number }>;
export type NormalizedDatabaseStatement = Readonly<{ shape: string; fingerprint: string }>;
export type DatabaseLexicalToken = Readonly<{
    kind: 'word' | 'identifier' | 'literal' | 'parameter' | 'symbol';
    start: number;
    end: number;
}>;

export class DatabaseStatementError extends Error {
    readonly code = 'unsupported_action';
    constructor(readonly reason: string) { super('The database statement is unavailable'); this.name = 'DatabaseStatementError'; }
}

export type MysqlLexicalOptions = Readonly<{ noBackslashEscapes?: boolean; ansiQuotes?: boolean }>;

/** Shared lexical mechanics for the two SQL dialects without psql's streaming
 * dump grammar. Each dialect chooses its own quoting/comment rules here. */
export function scanSqlStatements(sql: string, engine: 'mysql' | 'sqlite', options: MysqlLexicalOptions = {}): Readonly<{
    tokens: readonly DatabaseLexicalToken[];
    ranges: readonly DatabaseStatementRange[];
}> {
    if (sql.includes('\0')) throw new DatabaseStatementError('binary_sql_input');
    const tokens: DatabaseLexicalToken[] = [];
    const ranges: DatabaseStatementRange[] = [];
    let index = 0;
    let statementStart: number | undefined;
    let statementEnd = 0;
    let executableComment = false;
    const emit = (kind: DatabaseLexicalToken['kind'], start: number) => {
        tokens.push({ kind, start, end: index });
        statementEnd = index;
    };
    const finish = (end: number) => {
        if (statementStart !== undefined) ranges.push({ start: statementStart, end });
        statementStart = undefined;
    };
    while (index < sql.length) {
        const char = sql[index]!;
        const next = sql[index + 1];
        if (/\s/.test(char)) { index++; continue; }
        if (executableComment && char === '*' && next === '/') {
            index += 2; executableComment = false; statementEnd = index; continue;
        }
        if ((char === '-' && next === '-' && (engine === 'sqlite' || /\s/.test(sql[index + 2] ?? ' ')))
            || (engine === 'mysql' && char === '#')) {
            while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
            continue;
        }
        if (char === '/' && next === '*') {
            if (engine === 'mysql' && sql[index + 2] === '!') {
                statementStart ??= index;
                executableComment = true; index += 3;
                while (/[0-9]/.test(sql[index] ?? '')) index++;
            } else {
                const end = sql.indexOf('*/', index + 2);
                if (end === -1) throw new DatabaseStatementError('incomplete_sql_input');
                index = end + 2;
            }
            continue;
        }
        if (char === ';') { finish(index); index++; continue; }
        const start = index;
        statementStart ??= start;
        const quotedIdentifier = char === '`' || (engine === 'sqlite' && (char === '"' || char === '['))
            || (engine === 'mysql' && char === '"' && options.ansiQuotes === true);
        if (char === "'" || char === '"' || quotedIdentifier) {
            const closing = char === '[' ? ']' : char;
            index++;
            let closed = false;
            while (index < sql.length) {
                if (!quotedIdentifier && engine === 'mysql' && options.noBackslashEscapes !== true && sql[index] === '\\') { index += 2; continue; }
                if (sql[index] === closing) {
                    if (closing !== ']' && sql[index + 1] === closing) { index += 2; continue; }
                    index++; closed = true; break;
                }
                index++;
            }
            if (!closed) throw new DatabaseStatementError('incomplete_sql_input');
            emit(quotedIdentifier ? 'identifier' : 'literal', start);
        } else if (char === '?' || (engine === 'sqlite' && /[:@$]/.test(char))) {
            const parameter = engine === 'sqlite' ? /^(?:\?[0-9]*|[:@$][a-zA-Z0-9_\u0080-\uFFFF]+(?:::[a-zA-Z0-9_\u0080-\uFFFF]+)*(?:\([^)]*\))?)/.exec(sql.slice(index))?.[0] : '?';
            index += parameter?.length ?? 1;
            emit(parameter ? 'parameter' : 'symbol', start);
        } else if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next ?? ''))) {
            const number = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9][0-9_]*)?)/.exec(sql.slice(index))![0];
            index += number.length; emit('literal', start);
        } else if (/[a-zA-Z_$\u0080-\uFFFF]/.test(char)) {
            index++;
            while (/[a-zA-Z0-9_$\u0080-\uFFFF]/.test(sql[index] ?? '')) index++;
            emit('word', start);
        } else { index++; emit('symbol', start); }
    }
    if (executableComment) throw new DatabaseStatementError('incomplete_sql_input');
    finish(statementEnd);
    if (!ranges.length) throw new DatabaseStatementError('incomplete_sql_input');
    return { tokens, ranges };
}

export function databaseStatementWords(sql: string, tokens: readonly DatabaseLexicalToken[]): string[] {
    return tokens.map(token => {
        const raw = sql.slice(token.start, token.end);
        return token.kind === 'word' ? raw.toUpperCase()
            : token.kind === 'identifier' ? raw.slice(1, -1).replace(/``/g, '`').replace(/""/g, '"').toUpperCase() : '';
    });
}
