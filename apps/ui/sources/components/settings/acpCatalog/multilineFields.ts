export function parseMultilineField(raw: string): string[] {
    return String(raw ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

export function stringifyMultilineField(values: readonly string[] | null | undefined): string {
    return Array.isArray(values) ? values.join('\n') : '';
}
