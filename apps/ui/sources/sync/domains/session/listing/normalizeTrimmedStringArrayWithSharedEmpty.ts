import { normalizeTrimmedString } from './normalizeTrimmedString';

const EMPTY_TRIMMED_STRING_ARRAY: ReadonlyArray<string> = [];
const NORMALIZED_TRIMMED_STRING_ARRAY_BY_SOURCE = new WeakMap<ReadonlyArray<string>, ReadonlyArray<string>>();

export function normalizeTrimmedStringArrayWithSharedEmpty(
    values: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
    if (!Array.isArray(values) || values.length === 0) {
        return EMPTY_TRIMMED_STRING_ARRAY;
    }

    const cached = NORMALIZED_TRIMMED_STRING_ARRAY_BY_SOURCE.get(values);
    if (cached) {
        return cached;
    }

    let requiresNormalization = false;
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        const normalizedValue = normalizeTrimmedString(value);
        if (!normalizedValue || normalizedValue !== value || values.indexOf(normalizedValue) !== index) {
            requiresNormalization = true;
            break;
        }
    }

    if (!requiresNormalization) {
        return values;
    }

    const normalizedValues: string[] = [];
    const dedupe = new Set<string>();
    for (const value of values) {
        const normalizedValue = normalizeTrimmedString(value);
        if (normalizedValue && !dedupe.has(normalizedValue)) {
            dedupe.add(normalizedValue);
            normalizedValues.push(normalizedValue);
        }
    }

    const normalized = normalizedValues.length > 0 ? normalizedValues : EMPTY_TRIMMED_STRING_ARRAY;
    NORMALIZED_TRIMMED_STRING_ARRAY_BY_SOURCE.set(values, normalized);
    return normalized;
}
