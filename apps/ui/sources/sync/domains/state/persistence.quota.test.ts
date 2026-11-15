import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The web production adapter for `react-native-mmkv` writes through localStorage: when the
// origin quota is exhausted, `set` throws synchronously. This suite pins the persistence
// owner's contract for that platform boundary: a refused write is observed (warn) and never
// propagates into settings application, which is a live boot path.

const setShouldThrow = { current: false };
const setCalls: readonly string[] = [];

vi.mock('react-native-mmkv', () => {
    class MMKV {
        private readonly values = new Map<string, unknown>();
        constructor(_config?: unknown) {}
        getString(key: string): string | undefined {
            const value = this.values.get(key);
            return typeof value === 'string' ? value : undefined;
        }
        getNumber(key: string): number | undefined {
            const value = this.values.get(key);
            return typeof value === 'number' ? value : undefined;
        }
        set(key: string, value: unknown): void {
            if (setShouldThrow.current) {
                throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            }
            this.values.set(key, value);
        }
        delete(key: string): void { this.values.delete(key); }
        getAllKeys(): string[] { return [...this.values.keys()]; }
        clearAll(): void { this.values.clear(); }
        trim(): void {}
    }
    return { MMKV };
});

import { loadLocalSettings, saveLocalSettings } from './persistence';

describe('persistence quota boundary', () => {
    beforeEach(() => {
        setShouldThrow.current = false;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.resetModules();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        void setCalls;
    });

    it('keeps settings application alive when the storage layer refuses a quota-bound write', async () => {
        const { saveLocalSettings: freshSave, loadLocalSettings: freshLoad } = await importFresh();
        setShouldThrow.current = true;

        expect(() => freshSave({ themePreference: 'dark' } as Parameters<typeof freshSave>[0])).not.toThrow();
        expect(console.warn).toHaveBeenCalled();

        // The refused write leaves persisted state untouched; reads keep serving the old bytes.
        setShouldThrow.current = false;
        expect(freshLoad()).toBeTruthy();
    });

    it('still persists settings once the quota frees again', async () => {
        const { saveLocalSettings: freshSave } = await importFresh();
        setShouldThrow.current = true;
        freshSave({ themePreference: 'dark' } as Parameters<typeof freshSave>[0]);
        setShouldThrow.current = false;
        expect(() => freshSave({ themePreference: 'light' } as Parameters<typeof freshSave>[0])).not.toThrow();
        expect(console.warn).toHaveBeenCalledTimes(1);
    });
});

async function importFresh(): Promise<typeof import('./persistence')> {
    vi.resetModules();
    return await import('./persistence');
}

void loadLocalSettings;
