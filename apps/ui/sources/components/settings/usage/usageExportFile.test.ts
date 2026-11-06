import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';

describe('exportUsageTextDocument', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('withholds a calendar share after captured authority retires while the OS resolves availability', async () => {
        const fs = createExpoFileSystemFileMock();
        let current = true;
        const shareAsync = vi.fn(async () => {});
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeNativeMock({ platformOS: 'ios' });
        });
        vi.doMock('expo-file-system', () => fs.module);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => { current = false; return true; }, shareAsync }));
        const { exportUsageTextDocument } = await import('./usageExportFile');
        expect(await exportUsageTextDocument({ content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'usage-calendar.ics',
            mimeType: 'text/calendar', isCurrent: () => current })).toBe(false);
        expect(shareAsync).not.toHaveBeenCalled();
        expect(fs.files.size).toBe(0);
    });
    it('reports a native document write fault while preserving the false export result and cleanup', async () => {
        const fs = createExpoFileSystemFileMock();
        fs.writeBytes.mockImplementationOnce(() => { throw new Error('synthetic_usage_write_fault'); });
        const shareAsync = vi.fn();
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeNativeMock({ platformOS: 'ios' });
        });
        vi.doMock('expo-file-system', () => fs.module);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync }));
        const { exportUsageTextDocument } = await import('./usageExportFile');
        // afterEach resets modules; observe the same real logger instance as this owner.
        const { log } = await import('@/log');
        const priorLogs = log.getLogs().length;
        expect(await exportUsageTextDocument({ content: 'synthetic usage', fileName: 'usage.txt', mimeType: 'text/plain' })).toBe(false);
        expect(shareAsync).not.toHaveBeenCalled();
        expect(fs.files.size).toBe(0);
        expect(log.getLogs().slice(priorLogs).join(' ')).toContain('synthetic_usage_write_fault');
    });

});
