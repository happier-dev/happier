import type { LanguageIntelligenceQueryResult, LanguageIntelligenceRange } from '@happier-dev/protocol/machines/languageIntelligence';

export type CodeSemanticRole = 'function' | 'keyword' | 'string' | 'number' | 'comment';
export type CodeLineSemanticToken = Readonly<{ start: number; end: number; role: CodeSemanticRole }>;

/** Engine-neutral theme roles; unknown server types leave the syntax baseline intact. */
function semanticRole(type: string | undefined): CodeSemanticRole | null {
    if (type && ['function', 'method', 'class', 'interface', 'type', 'typeParameter', 'enum', 'namespace', 'property'].includes(type)) return 'function';
    if (type && ['keyword', 'modifier', 'operator'].includes(type)) return 'keyword';
    if (type === 'string' || type === 'regexp') return 'string';
    return type === 'number' || type === 'comment' ? type : null;
}

/** Decode the controller's admitted range answer, retaining only the requested UTF-16 viewport. */
export function projectCodeSemanticTokens(
    sources: Extract<LanguageIntelligenceQueryResult, { kind: 'semanticTokens' }>['tokens'],
    range: LanguageIntelligenceRange,
): ReadonlyMap<number, readonly CodeLineSemanticToken[]> {
    const byLine = new Map<number, CodeLineSemanticToken[]>();
    for (const source of sources) {
        let line = 0, character = 0;
        const data = source.data ?? [];
        for (let index = 0; index + 4 < data.length; index += 5) {
            line += data[index];
            character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
            if (line > range.end.line) break;
            const end = character + data[index + 2];
            const role = semanticRole(source.legend.tokenTypes[data[index + 3]]);
            if (!role || end <= character || line < range.start.line
                || line === range.start.line && character < range.start.character
                || line === range.end.line && end > range.end.character) continue;
            const tokens = byLine.get(line + 1) ?? [];
            tokens.push({ start: character, end, role });
            byLine.set(line + 1, tokens);
        }
    }
    return byLine;
}
