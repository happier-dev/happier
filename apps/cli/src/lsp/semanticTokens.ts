import type { LanguageIntelligenceRange, LanguageIntelligenceSemanticTokens } from '@happier-dev/protocol/machines/languageIntelligence';
import { normalizeSemanticTokens } from './languageServerEditingResults';
import { readLspObject } from './languageServerResults';

export type SemanticTokenBaseline = Readonly<{ data: readonly number[]; resultId?: string }>;

/** Native delta offsets address the same previous array, including when edits arrive unsorted. */
export function readSemanticTokenBaseline(serverId: string, legend: LanguageIntelligenceSemanticTokens['legend'],
    response: unknown, previous?: SemanticTokenBaseline): SemanticTokenBaseline {
    const tokens = normalizeSemanticTokens(serverId, { ...(readLspObject(response) ?? { data: [] }), legend });
    let data = tokens.data;
    if (data === undefined) {
        if (!previous || !tokens.edits) throw new Error('Missing semantic token baseline');
        data = [];
        let cursor = 0;
        for (const edit of [...tokens.edits].sort((a, b) => a.start - b.start)) {
            if (edit.start < cursor || edit.start + edit.deleteCount > previous.data.length) throw new Error('Invalid semantic token edit');
            for (let index = cursor; index < edit.start; index++) data.push(previous.data[index]!);
            for (const value of edit.data ?? []) data.push(value);
            cursor = edit.start + edit.deleteCount;
        }
        for (let index = cursor; index < previous.data.length; index++) data.push(previous.data[index]!);
    }
    if (data.length % 5 !== 0) throw new Error('Invalid semantic token data');
    return { data, ...(tokens.resultId === undefined ? {} : { resultId: tokens.resultId }) };
}

/** Re-encode only visible tokens; their first position remains relative to the document origin. */
export function selectSemanticTokenRange(data: readonly number[], range: LanguageIntelligenceRange): number[] {
    const selected: number[] = [];
    let line = 0, character = 0, previousLine = 0, previousCharacter = 0;
    for (let index = 0; index < data.length; index += 5) {
        line += data[index]!;
        character = data[index] === 0 ? character + data[index + 1]! : data[index + 1]!;
        if (line > range.end.line) break;
        const length = data[index + 2]!;
        if (line < range.start.line || line === range.start.line && character < range.start.character
            || line === range.end.line && character + length > range.end.character) continue;
        selected.push(line - previousLine, line === previousLine ? character - previousCharacter : character,
            length, data[index + 3]!, data[index + 4]!);
        previousLine = line;
        previousCharacter = character;
    }
    return selected;
}
