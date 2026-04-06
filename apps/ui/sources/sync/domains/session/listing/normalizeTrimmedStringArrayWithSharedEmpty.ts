const EMPTY_TRIMMED_STRING_ARRAY: ReadonlyArray<string> = [];

export function normalizeTrimmedStringArrayWithSharedEmpty(
    values: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
    if (!Array.isArray(values) || values.length === 0) {
        return EMPTY_TRIMMED_STRING_ARRAY;
    }

    let requiresNormalization = false;
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        const normalizedValue = String(value ?? '').trim();
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
        const normalizedValue = String(value ?? '').trim();
        if (normalizedValue && !dedupe.has(normalizedValue)) {
            dedupe.add(normalizedValue);
            normalizedValues.push(normalizedValue);
        }
    }

    return normalizedValues.length > 0 ? normalizedValues : EMPTY_TRIMMED_STRING_ARRAY;
}
