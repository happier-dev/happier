import { maybeParseJson } from '../normalization/parse/parseJson';

export function coerceToolResultRecord(value: unknown): Record<string, unknown> | null {
    const parsed = maybeParseJson(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}
