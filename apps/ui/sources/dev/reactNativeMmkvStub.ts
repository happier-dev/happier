export class MMKV {
    private readonly values = new Map<string, string>();

    getString(key: string): string | undefined {
        return this.values.get(key);
    }

    set(key: string, value: string): void {
        this.values.set(key, value);
    }

    delete(key: string): void {
        this.values.delete(key);
    }

    clearAll(): void {
        this.values.clear();
    }
}
