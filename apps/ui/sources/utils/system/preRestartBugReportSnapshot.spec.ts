import { afterEach, describe, expect, it, vi } from 'vitest';

type ExpoFsState = {
    Paths: { cache: string; document: string };
    files: Map<string, string>;
};

const SNAPSHOT_PATH = 'file:///cache/pre-restart-bug-report-snapshot.v1.json';

function createExpoFsState(): ExpoFsState {
    const files = new Map<string, string>();
    return {
        Paths: { cache: 'file:///cache/', document: 'file:///documents/' },
        files,
    };
}

function createExpoFileSystemMock(expoFs: ExpoFsState) {
    const joinFileUri = (...segments: string[]): string => {
        const [first = '', ...rest] = segments;
        return rest.reduce((current, segment) => `${current.replace(/\/+$/, '')}/${segment.replace(/^\/+/, '')}`, first);
    };
    class ExpoFileMock {
        readonly uri: string;
        constructor(...segments: string[]) {
            this.uri = joinFileUri(...segments);
        }
        get exists() {
            return expoFs.files.has(this.uri);
        }
        async text() {
            const value = expoFs.files.get(this.uri);
            if (typeof value !== 'string') throw new Error(`missing file: ${this.uri}`);
            return value;
        }
        write(payload: string) {
            expoFs.files.set(this.uri, payload);
        }
        delete() {
            expoFs.files.delete(this.uri);
        }
    }
    return {
        File: ExpoFileMock,
        Paths: expoFs.Paths,
        getInfoAsync: vi.fn(() => { throw new Error('legacy getInfoAsync should not be used'); }),
        readAsStringAsync: vi.fn(() => { throw new Error('legacy readAsStringAsync should not be used'); }),
        writeAsStringAsync: vi.fn(() => { throw new Error('legacy writeAsStringAsync should not be used'); }),
        deleteAsync: vi.fn(() => { throw new Error('legacy deleteAsync should not be used'); }),
    };
}

async function loadModule(options?: { platformOs?: 'ios' | 'android' | 'web' }) {
    vi.resetModules();

    const expoFs = createExpoFsState();
    vi.doMock('expo-file-system', () => createExpoFileSystemMock(expoFs));
    vi.doMock('expo-file-system/legacy', () => {
        throw new Error('expo-file-system/legacy should not be imported');
    });
    vi.doMock('react-native', () => ({
        Platform: { OS: options?.platformOs ?? 'ios' },
    }));

    const module = await import('./preRestartBugReportSnapshot');
    return { module, expoFs };
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock('expo-file-system');
    vi.unmock('expo-file-system/legacy');
    vi.unmock('react-native');
});

describe('preRestartBugReportSnapshot native behavior', () => {
    it('persists and reads a native pre-restart snapshot through Expo File', async () => {
        const { module } = await loadModule({ platformOs: 'android' });
        const createdAtMs = Date.now() - 5_000;

        await module.persistPreRestartBugReportSnapshot({
            v: 1,
            createdAtMs,
            reason: 'crash',
            platform: 'android',
            origin: null,
            isSecureContext: null,
            errorDetails: 'boom',
            appLogs: 'logs',
            userActions: [],
        });

        await expect(module.peekPreRestartBugReportSnapshot()).resolves.toMatchObject({
            v: 1,
            createdAtMs,
            reason: 'crash',
            platform: 'android',
            errorDetails: 'boom',
            appLogs: 'logs',
        });
    });

    it('clears an invalid native snapshot payload', async () => {
        const { module, expoFs } = await loadModule({ platformOs: 'android' });
        expoFs.files.set(SNAPSHOT_PATH, '{not-json');

        await expect(module.peekPreRestartBugReportSnapshot()).resolves.toBeNull();

        expect(expoFs.files.has(SNAPSHOT_PATH)).toBe(false);
    });
});
