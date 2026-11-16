export function quoteSqliteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}
