import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const expoFs = vi.hoisted(() => ({ files: null as Map<string, number[]> | null }));

vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    const mock = createExpoFileSystemFileMock('file:///cache');
    expoFs.files = mock.files;
    return { ...mock.module, Paths: { ...mock.module.Paths, document: 'file:///documents' } };
});
vi.mock('expo-file-system/legacy', () => {
    throw new Error('expo-file-system/legacy should not be imported');
});
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
}));

import { clearPreRestartBugReportSnapshot, peekPreRestartBugReportSnapshot, persistPreRestartBugReportSnapshot } from './preRestartBugReportSnapshot';

const DOCUMENT_PATH = 'file:///documents/pre-restart-bug-report-snapshot.v1.json';
const SNAPSHOT_PATH = 'file:///cache/pre-restart-bug-report-snapshot.v1.json';

function nativeFiles(): Map<string, number[]> {
    if (!expoFs.files) throw new Error('expo-file-system mock was not loaded');
    return expoFs.files;
}

afterEach(() => vi.unstubAllGlobals());

describe('preRestartBugReportSnapshot native behavior', () => {
    beforeEach(() => {
        nativeFiles().clear();
    });

    it('persists and reads a native pre-restart snapshot through Expo File', async () => {
        const createdAtMs = Date.now() - 5_000;

        await persistPreRestartBugReportSnapshot({
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

        expect([...nativeFiles().keys()]).toEqual([DOCUMENT_PATH]);
        await expect(peekPreRestartBugReportSnapshot()).resolves.toMatchObject({
            v: 1,
            createdAtMs,
            reason: 'crash',
            platform: 'android',
            errorDetails: 'boom',
            appLogs: 'logs',
        });
    });

    it('retains historical cache snapshots beyond a day and clears both locations explicitly', async () => {
        const payload = JSON.stringify({ v: 1, createdAtMs: Date.now() - 2 * 24 * 60 * 60 * 1000,
            reason: 'crash', platform: 'android', origin: null, isSecureContext: null,
            errorDetails: 'legacy original', appLogs: '', userActions: [] });
        nativeFiles().set(SNAPSHOT_PATH, [...new TextEncoder().encode(payload)]);
        await expect(peekPreRestartBugReportSnapshot()).resolves.toMatchObject({ errorDetails: 'legacy original' });
        await persistPreRestartBugReportSnapshot({ ...JSON.parse(payload), errorDetails: 'durable original' });
        await expect(peekPreRestartBugReportSnapshot()).resolves.toMatchObject({ errorDetails: 'durable original' });
        await expect(clearPreRestartBugReportSnapshot()).resolves.toBe(true);
        expect(nativeFiles().size).toBe(0);
    });

    it('reports browser save and dismiss errors instead of pretending success', async () => {
        const { Platform } = await import('react-native');
        const platform = Platform as { OS: string };
        const previous = platform.OS;
        platform.OS = 'web';
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            vi.stubGlobal('localStorage', {
                setItem: () => { throw new Error('quota exceeded'); },
                removeItem: () => { throw new Error('cannot remove'); },
            });
            await expect(persistPreRestartBugReportSnapshot({ v: 1, createdAtMs: Date.now(), reason: 'crash',
                platform: 'web', origin: null, isSecureContext: null, errorDetails: 'original', appLogs: '', userActions: [] }))
                .rejects.toThrow('quota exceeded');
            await expect(clearPreRestartBugReportSnapshot()).resolves.toBe(false);
            expect(warning).toHaveBeenCalled();
        } finally { platform.OS = previous; warning.mockRestore(); }
    });

    it('clears an invalid native snapshot payload' , async () => {
        nativeFiles().set(SNAPSHOT_PATH, [...new TextEncoder().encode('{not-json')]);

        await expect(peekPreRestartBugReportSnapshot()).resolves.toBeNull();

        expect(nativeFiles().has(SNAPSHOT_PATH)).toBe(false);
    });
});
