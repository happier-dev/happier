export function isOpenCodeSessionBusy(record: unknown): boolean {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const type = (record as Record<string, unknown>).type;
    return String(type ?? '').toLowerCase() === 'busy';
}
