export function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
