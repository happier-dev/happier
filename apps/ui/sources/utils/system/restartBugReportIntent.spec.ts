import { afterEach, describe, expect, it, vi } from 'vitest';

type LegacyFsState = {
    cacheDirectory: string;
    documentDirectory: string;
    EncodingType: { UTF8: string };
    getInfoAsync: ReturnType<typeof vi.fn>;
    readAsStringAsync: ReturnType<typeof vi.fn>;
    writeAsStringAsync: ReturnType<typeof vi.fn>;
    deleteAsync: ReturnType<typeof vi.fn>;
    files: Map<string, string>;
};

function createLegacyFsState(): LegacyFsState {
    const files = new Map<string, string>();
    return {
        cacheDirectory: 'file:///cache/',
        documentDirectory: 'file:///documents/',
        EncodingType: { UTF8: 'utf8' },
        files,
        getInfoAsync: vi.fn(async (path: string) => ({ exists: files.has(path) })),
        readAsStringAsync: vi.fn(async (path: string) => {
            const value = files.get(path);
            if (typeof value !== 'string') {
                throw new Error(`missing file: ${path}`);
            }
            return value;
        }),
        writeAsStringAsync: vi.fn(async (path: string, payload: string) => {
            files.set(path, payload);
        }),
        deleteAsync: vi.fn(async (path: string) => {
            files.delete(path);
        }),
    };
}

async function loadModule(options?: { platformOs?: 'ios' | 'android' | 'web' }) {
    vi.resetModules();

    const legacyFs = createLegacyFsState();
    vi.doMock('expo-file-system', () => ({
        cacheDirectory: legacyFs.cacheDirectory,
        documentDirectory: legacyFs.documentDirectory,
        EncodingType: legacyFs.EncodingType,
        getInfoAsync: vi.fn(async () => {
            throw new Error('top-level expo-file-system legacy API should not be used');
        }),
        readAsStringAsync: vi.fn(async () => {
            throw new Error('top-level expo-file-system legacy API should not be used');
        }),
        writeAsStringAsync: vi.fn(async () => {
            throw new Error('top-level expo-file-system legacy API should not be used');
        }),
        deleteAsync: vi.fn(async () => {
            throw new Error('top-level expo-file-system legacy API should not be used');
        }),
    }));
    vi.doMock('expo-file-system/legacy', () => legacyFs);
    vi.doMock('react-native', () => ({
        Platform: { OS: options?.platformOs ?? 'ios' },
    }));

    const module = await import('./restartBugReportIntent');
    return { module, legacyFs };
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock('expo-file-system');
    vi.unmock('expo-file-system/legacy');
    vi.unmock('react-native');
});

describe('restartBugReportIntent native behavior', () => {
    it('persists and consumes a native restart intent even when top-level expo-file-system legacy methods throw', async () => {
        const { module, legacyFs } = await loadModule({ platformOs: 'android' });
        const createdAtMs = Date.now() - 5_000;

        await module.persistRestartBugReportIntent({
            v: 1,
            createdAtMs,
            reason: 'crash',
        });

        await expect(module.consumeRestartBugReportIntent()).resolves.toBe(true);
        await expect(module.consumeRestartBugReportIntent()).resolves.toBe(false);

        expect(legacyFs.files.size).toBe(0);
    });
});
