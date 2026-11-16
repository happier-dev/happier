export function quotePostgresqlIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}
