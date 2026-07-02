export function collectRecordIds<T>(record: Readonly<Record<string, T>> | null | undefined): string[] {
    const ids: string[] = [];
    if (!record || typeof record !== 'object') return ids;
    for (const id in record) {
        if (!Object.prototype.hasOwnProperty.call(record, id)) continue;
        ids.push(id);
    }
    return ids;
}

export function hasRecordValues<T>(record: Readonly<Record<string, T>> | null | undefined): boolean {
    if (!record || typeof record !== 'object') return false;
    for (const id in record) {
        if (Object.prototype.hasOwnProperty.call(record, id)) return true;
    }
    return false;
}

export function forEachRecordValue<T>(
    record: Readonly<Record<string, T>> | null | undefined,
    visit: (value: T, id: string) => void,
): void {
    if (!record || typeof record !== 'object') return;
    for (const id in record) {
        if (!Object.prototype.hasOwnProperty.call(record, id)) continue;
        visit(record[id], id);
    }
}
