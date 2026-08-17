import { describe, expect, it, vi } from 'vitest';

describe('getClipboardStringTrimmedSafe', () => {
    it('preserves the raw clipboard value when the host must distinguish a failed read', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => ({
            getStringAsync: vi.fn(async () => '  review link  '),
        }));

        const { getClipboardStringSafe } = await import('./clipboard');
        await expect(getClipboardStringSafe()).resolves.toBe('  review link  ');
    });

    it('returns trimmed clipboard contents', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => '  hello  '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('hello');
    });

    it('returns empty string when clipboard read throws', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });

    it('returns empty string when clipboard contents are whitespace only', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => ' \n\t '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });
});

describe('setClipboardStringSafe', () => {
    it('writes to clipboard and returns true', async () => {
        vi.resetModules();
        const setStringAsync = vi.fn(async () => {});
        vi.doMock('expo-clipboard', () => {
            return {
                setStringAsync,
            };
        });

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(true);
        expect(setStringAsync).toHaveBeenCalledWith('hello');
    });

    it('returns false when clipboard write throws', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                setStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(false);
    });
});
