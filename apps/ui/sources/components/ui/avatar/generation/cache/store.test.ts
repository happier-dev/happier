import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class QuotaStorage implements Storage {
    private readonly values = new Map<string, string>();

    constructor(private readonly maxValueChars: number) {}

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(String(key)) ?? null;
    }

    key(index: number): string | null {
        return Array.from(this.values.keys())[index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(String(key));
    }

    setItem(key: string, value: string): void {
        const next = new Map(this.values);
        next.set(String(key), String(value));
        const nextSize = Array.from(next.values()).reduce((sum, item) => sum + item.length, 0);
        if (nextSize > this.maxValueChars) {
            throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
        }
        this.values.clear();
        for (const [nextKey, nextValue] of next.entries()) {
            this.values.set(nextKey, nextValue);
        }
    }
}

vi.mock('react-native-mmkv', () => ({
    MMKV: vi.fn(() => {
        throw new Error('MMKV should not be constructed in web runtime');
    }),
}));

describe('avatar generation store', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('removes legacy avatar cache keys before writing the web cache', async () => {
        const storage = new QuotaStorage(300);
        storage.setItem('avatar-generation-cache-v1', 'x'.repeat(150));
        storage.setItem('avatar-generation-cache-v2', 'x'.repeat(120));
        storage.setItem('avatar-generation-cache-v3', 'x'.repeat(20));
        vi.stubGlobal('localStorage', storage);

        const { writeAvatarXmlToStore, readAvatarXmlFromStore } = await import('./store');

        writeAvatarXmlToStore('profile-a', '<svg />');

        expect(storage.getItem('avatar-generation-cache-v1')).toBeNull();
        expect(storage.getItem('avatar-generation-cache-v2')).toBeNull();
        expect(storage.getItem('avatar-generation-cache-v3')).toBeNull();
        expect(storage.getItem('avatar-generation-cache-v4')).not.toBeNull();
        expect(readAvatarXmlFromStore('profile-a')).toBe('<svg />');
    });

    it('keeps raster avatar data out of web localStorage to protect the origin quota', async () => {
        const storage = new QuotaStorage(1_000_000);
        vi.stubGlobal('localStorage', storage);

        const { writeAvatarRasterToStore, readAvatarRasterFromStore } = await import('./store');

        writeAvatarRasterToStore('profile-raster', `data:image/png;base64,${'x'.repeat(40_000)}`);

        expect(storage.getItem('avatar-generation-cache-v4')).toBeNull();
        expect(readAvatarRasterFromStore('profile-raster')).toBeNull();
    });

    it('bounds the persistent web SVG cache by serialized size, not only entry count', async () => {
        const storage = new QuotaStorage(1_000_000);
        vi.stubGlobal('localStorage', storage);

        const { writeAvatarXmlToStore, readAvatarXmlFromStore } = await import('./store');

        for (let index = 0; index < 10; index += 1) {
            writeAvatarXmlToStore(`profile-${index}`, `<svg>${String(index).repeat(50_000)}</svg>`);
        }

        const stored = storage.getItem('avatar-generation-cache-v4');
        expect(stored?.length ?? 0).toBeLessThanOrEqual(260_000);
        expect(readAvatarXmlFromStore('profile-9')).not.toBeNull();
        expect(readAvatarXmlFromStore('profile-0')).toBeNull();
    });
});
