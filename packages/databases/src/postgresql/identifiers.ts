import type { PostgresqlLexicalToken } from './input.js';

export function quotePostgresqlIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

export function postgresqlStatementWords(sql: string, tokens: readonly PostgresqlLexicalToken[]): string[] {
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
