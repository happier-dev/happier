/** Native input refusals preserve the existing deployment error codes/reasons. */
export class PostgresqlInputError extends Error {
    readonly code: 'unsupported_action' | 'invalid_action_input';
    readonly reason: string;
    constructor(code: 'unsupported_action' | 'invalid_action_input', reason: string) {
        super('The PostgreSQL input is unavailable');
        this.name = 'PostgresqlInputError';
        this.code = code;
        this.reason = reason;
    }
}
function refuse(code: 'unsupported_action' | 'invalid_action_input', reason: string): never {
    throw new PostgresqlInputError(code, reason);
}
export type PostgresqlLexicalToken = Readonly<{
    kind: 'word' | 'identifier' | 'literal' | 'parameter' | 'symbol';
    start: number;
    end: number;
}>;
export type PostgresqlStatementRange = Readonly<{ start: number; end: number }>;

/** One incremental lexical owner for psql input, not SQL authorization.
 * Statement consumers observe this scanner rather than tokenizing SQL again. */
export function psqlInputScanner(mode: 'query' | 'dump' | 'statements', observe?: Readonly<{
    token?(token: PostgresqlLexicalToken): void;
    statement?(range: PostgresqlStatementRange): void;
}>) {
    const identifier = (char: string) => /[a-zA-Z0-9_$\u0080-\uFFFF]/.test(char);
    let quote: "'" | '"' | undefined;
    let escapeString = false;
    let dollar: string | undefined;
    let block = 0;
    let lineComment = false;
    let ended = false;
    let statementEnd: number | undefined;
    let hasSql = false;
    let pending = '';
    let position = 0;
    let previous = '';
    let beforePrevious = '';
    let physicalLineStart = true;
    let directive: { name: string; phase: 'command' | 'key' | 'afterKey'; keySeen: boolean } | undefined;
    let word = '';
    let wordStart = 0;
    let quotedStart = 0;
    let statementStart: number | undefined;
    let quotedSetting: string | undefined;
    let depth = 0;
    let firstWord = true;
    let copy = false;
    let copyBinary = false;
    let copyWords = 0;
    let copyDirection: 'FROM' | 'TO' | undefined;
    let copyStdin = false;
    let copyData: 'header' | 'rows' | undefined;
    let dataLine: string | undefined = '';
    let set = false;
    let standardStrings = false;
    let standardStringsOn = false;
    const token = (value: string, quoted = false) => {
        const upper = value.toUpperCase();
        if (firstWord) {
            copy = !quoted && upper === 'COPY';
            if (copy && mode === 'query') refuse('unsupported_action', 'unsupported_native_result');
            set = mode === 'dump' && !quoted && upper === 'SET'; firstWord = false; return;
        }
        if (set && upper === 'STANDARD_CONFORMING_STRINGS') standardStrings = true;
        else if (standardStrings && upper !== 'TO') {
            if (!['ON', 'TRUE', '1'].includes(upper)) refuse('unsupported_action', 'psql_lexical_setting');
            standardStringsOn = true;
        }
        if (!copy || quoted) return;
        if (copyDirection) {
            if (upper === 'PROGRAM') refuse('unsupported_action', 'psql_copy_program');
            copyStdin = copyDirection === 'FROM' && upper === 'STDIN';
            copyDirection = undefined;
        } else if (depth === 0 && (upper === 'FROM' || upper === 'TO')) copyDirection = upper;
        if ((copyWords++ === 0 && upper === 'BINARY') || (copyStdin && (upper === 'CSV' || upper === 'BINARY'))) copyBinary = true;
    };
    const emit = (kind: PostgresqlLexicalToken['kind'], start: number, end: number) => observe?.token?.({ kind, start, end });
    const flushWord = () => {
        if (word) { token(word); emit('word', wordStart, position); word = ''; }
    };
    const finishStatement = (end: number) => {
        if (statementStart !== undefined) observe?.statement?.({ start: statementStart, end });
        statementStart = undefined;
    };
    return {
        write(chunk: string, final = false) {
            if (chunk.includes('\0')) refuse('unsupported_action', 'psql_binary_input');
            pending += chunk;
            let index = 0;
            const advance = (count = 1) => {
                for (const char of pending.slice(index, index + count)) {
                    beforePrevious = previous; previous = char;
                    if (char === '\n') physicalLineStart = true;
                    else if (!/[ \t\r]/.test(char)) physicalLineStart = false;
                }
                index += count;
                position += count;
            };
            while (index < pending.length) {
                const char = pending[index]!;
                const next = pending[index + 1];
                if (directive) {
                    if (char === '\n') {
                        if (!directive.keySeen) refuse('unsupported_action', 'psql_client_command');
                        directive = undefined;
                    } else if (directive.phase === 'command') {
                        if (/[a-z]/.test(char)) {
                            directive.name += char;
                            if (!['restrict', 'unrestrict'].some(name => name.startsWith(directive!.name))) refuse('unsupported_action', 'psql_client_command');
                        } else if (/[ \t]/.test(char) && ['restrict', 'unrestrict'].includes(directive.name)) directive.phase = 'key';
                        else refuse('unsupported_action', 'psql_client_command');
                    } else if (directive.phase === 'key' && /[a-zA-Z0-9]/.test(char)) directive.keySeen = true;
                    else if (/[ \t\r]/.test(char) && directive.keySeen) directive.phase = 'afterKey';
                    else refuse('unsupported_action', 'psql_client_command');
                    advance(); continue;
                }
                if (copyData) {
                    if (copyData === 'header') {
                        if (char === '\n') { copyData = 'rows'; dataLine = ''; }
                        else if (!/[ \t\r]/.test(char)) refuse('unsupported_action', 'unsupported_copy_input');
                    } else if (char === '\n') {
                        if (dataLine === '\\.' || dataLine === '\\.\r') copyData = undefined;
                        dataLine = '';
                    } else if (dataLine !== undefined) {
                        const candidate = dataLine + char;
                        dataLine = '\\.\r'.startsWith(candidate) ? candidate : undefined;
                    }
                    advance(); continue;
                }
                if (lineComment) { if (char === '\n' || char === '\r') lineComment = false; advance(); continue; }
                if (block) {
                    if (!next && !final && (char === '/' || char === '*')) break;
                    if (char === '/' && next === '*') { block++; advance(2); }
                    else if (char === '*' && next === '/') { block--; advance(2); }
                    else advance();
                    continue;
                }
                if (dollar) {
                    if (!final && dollar.startsWith(pending.slice(index)) && pending.length - index < dollar.length) break;
                    if (pending.startsWith(dollar, index)) {
                        advance(dollar.length); dollar = undefined;
                        emit('literal', quotedStart, position);
                    }
                    else advance();
                    continue;
                }
                if (quote) {
                    if (!next && !final && (char === quote || (escapeString && char === '\\'))) break;
                    if (quote === "'" && escapeString && char === '\\') { advance(next ? 2 : 1); continue; }
                    if (char === quote) {
                        if (next === quote) { quotedSetting = undefined; advance(2); }
                        else {
                            const kind = quote === '"' ? 'identifier' : 'literal';
                            quote = undefined;
                            if (quotedSetting !== undefined) token(quotedSetting, true);
                            quotedSetting = undefined;
                            advance();
                            emit(kind, quotedStart, position);
                        }
                    } else {
                        if (quotedSetting !== undefined) {
                            const candidate = quotedSetting + char;
                            quotedSetting = ['STANDARD_CONFORMING_STRINGS', 'ON', 'TRUE', '1', 'TO']
                                .some(value => value.startsWith(candidate.toUpperCase())) ? candidate : undefined;
                        }
                        advance();
                    }
                    continue;
                }
                if (word && identifier(char)) { word += char; advance(); continue; }
                flushWord();
                if (!next && !final && /[-/:$]/.test(char)) break;
                if (char === '-' && next === '-') { lineComment = true; advance(2); continue; }
                if (char === '/' && next === '*') { block = 1; advance(2); continue; }
                if (/\s/.test(char)) { advance(); continue; }
                if (char === '\\') {
                    if (mode !== 'dump' || !physicalLineStart) refuse('unsupported_action', 'psql_client_command');
                    directive = { name: '', phase: 'command', keySeen: false };
                    advance(); continue;
                }
                if (char === ':' && previous !== ':' && /[a-zA-Z_{]/.test(next ?? '')) refuse('unsupported_action', 'unquoted_query_parameter');
                if (char === ';') {
                    finishStatement(position);
                    if (mode === 'query') { statementEnd ??= position; ended = true; }
                    else {
                        if (standardStrings && !standardStringsOn) refuse('unsupported_action', 'psql_lexical_setting');
                        if (mode === 'dump' && copyStdin) {
                            if (copyBinary) refuse('unsupported_action', 'unsupported_copy_input');
                            copyData = 'header';
                        }
                        firstWord = true; copy = false; copyBinary = false; copyWords = 0; copyStdin = false; copyDirection = undefined;
                        set = false; standardStrings = false; standardStringsOn = false; depth = 0;
                    }
                    advance(); continue;
                }
                if (ended) refuse('unsupported_action', 'unsupported_multi_result');
                hasSql = true;
                statementStart ??= position;
                if (char === "'" || char === '"') {
                    quotedStart = position;
                    quote = char;
                    quotedSetting = set ? '' : undefined;
                    escapeString = char === "'" && /e/i.test(previous) && !identifier(beforePrevious);
                    advance();
                } else if (char === '$' && !identifier(previous)) {
                    const remaining = pending.slice(index);
                    const tag = /^\$(?:[a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\u0080-\uFFFF]*)?\$/.exec(remaining)?.[0];
                    if (tag) { quotedStart = position; dollar = tag; advance(tag.length); }
                    else if (!final && /^\$[a-zA-Z0-9_\u0080-\uFFFF]*$/.test(remaining)) break;
                    else {
                        const parameter = /^\$[0-9]+/.exec(remaining)?.[0];
                        const start = position;
                        advance(parameter?.length ?? 1);
                        emit(parameter ? 'parameter' : 'symbol', start, position);
                    }
                } else if (mode === 'statements' && (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(next ?? '')))) {
                    const remaining = pending.slice(index);
                    const numeric = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9][0-9_]*)?)/.exec(remaining)![0];
                    // A chunk may end inside a numeric exponent or base prefix.
                    if (!final && (numeric.length === remaining.length || /^(?:[eE][+-]?|[xXoObB])$/.test(remaining.slice(numeric.length)))) break;
                    const start = position; advance(numeric.length); emit('literal', start, position);
                } else if (identifier(char)) { word = char; wordStart = position; advance(); }
                else {
                    if (char === '(') depth++; else if (char === ')') depth--;
                    const start = position; advance(); emit('symbol', start, position);
                }
            }
            pending = pending.slice(index);
            if (final) {
                flushWord();
                if (directive && !directive.keySeen) refuse('unsupported_action', 'psql_client_command');
                if (copyData === 'rows' && (dataLine === '\\.' || dataLine === '\\.\r')) copyData = undefined;
                if (!hasSql || quote || dollar || block || copyData) refuse('invalid_action_input', 'incomplete_sql_input');
                finishStatement(position);
            }
        },
        get statementEnd() { return statementEnd; },
    };
}

/** Query mode returns the one statement for native CSV framing. Dump mode
 * preserves every admitted byte; its streaming form retains lexical state only. */
export function admitPsqlInput(sql: string, mode: 'query' | 'dump'): string;
export function admitPsqlInput(sql: AsyncIterable<Uint8Array>, mode: 'dump'): Promise<void>;
export function admitPsqlInput(sql: string | AsyncIterable<Uint8Array>, mode: 'query' | 'dump'): string | Promise<void> {
    const scanner = psqlInputScanner(mode);
    if (typeof sql === 'string') {
        scanner.write(sql, true);
        return mode === 'query' ? sql.slice(0, scanner.statementEnd) : sql;
    }
    return (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for await (const chunk of sql) scanner.write(decoder.decode(chunk, { stream: true }));
        scanner.write(decoder.decode(), true);
    })();
}
