import type { RawJSONLines } from '../../types';
import { INTERNAL_CLAUDE_EVENT_TYPES } from '../../utils/internalClaudeEventTypes';
import { normalizeClaudeToolUseNamesInRawJsonLines } from '../../utils/normalizeClaudeToolUseNames';
import { parseRawJsonLinesObject } from '../../utils/parseRawJsonLines';

export function projectClaudeJsonlLineToRawMessage(lineValue: unknown): RawJSONLines | null {
    const rawObject = (() => {
        if (!lineValue) return null;
        if (typeof lineValue === 'string') {
            const trimmed = lineValue.trim();
            if (!trimmed) return null;
            try {
                return JSON.parse(trimmed) as unknown;
            } catch {
                return null;
            }
        }
        if (typeof lineValue === 'object' && !Array.isArray(lineValue)) {
            return lineValue;
        }
        return null;
    })();

    if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) {
        return null;
    }

    const rawType = (rawObject as { type?: unknown }).type;
    if (typeof rawType === 'string' && INTERNAL_CLAUDE_EVENT_TYPES.has(rawType)) {
        return null;
    }

    const parsed = parseRawJsonLinesObject(rawObject);
    return parsed ? normalizeClaudeToolUseNamesInRawJsonLines(parsed) : null;
}
