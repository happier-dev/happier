export function normalizeTrimmedString(value: unknown): string {
    return String(value ?? '').trim();
}
