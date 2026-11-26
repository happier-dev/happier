import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';

describe('deliverUsageTextDocument', () => {
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
        const { deliverUsageTextDocument } = await import('./usageExportFile');
        expect(await deliverUsageTextDocument({ content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'usage-calendar.ics',
            mimeType: 'text/calendar', isCurrent: () => current })).toEqual({ kind: 'cancelled' });
        expect(shareAsync).not.toHaveBeenCalled();
        expect(fs.files.size).toBe(0);
    });
    it('reports a typed native document write fault and cleans up', async () => {
        const fs = createExpoFileSystemFileMock();
        fs.writeBytes.mockImplementationOnce(() => { throw new Error('synthetic_usage_write_fault'); });
        const shareAsync = vi.fn();
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeNativeMock({ platformOS: 'ios' });
        });
        vi.doMock('expo-file-system', () => fs.module);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync }));
        const { deliverUsageTextDocument } = await import('./usageExportFile');
        // afterEach resets modules; observe the same real logger instance as this owner.
        const { log } = await import('@/log');
        const priorLogs = log.getLogs().length;
        expect(await deliverUsageTextDocument({ content: 'synthetic usage', fileName: 'usage.txt', mimeType: 'text/plain' }))
            .toEqual({ kind: 'failed', reason: 'delivery_failed' });
        expect(shareAsync).not.toHaveBeenCalled();
        expect(fs.files.size).toBe(0);
        expect(log.getLogs().slice(priorLogs).join(' ')).toContain('synthetic_usage_write_fault');
    });

    it('preserves platform cancellation after the file has been handed to the native sheet', async () => {
        const fs = createExpoFileSystemFileMock();
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return { ...await createReactNativeNativeMock({ platformOS: 'ios' }), Share: {
                sharedAction: 'sharedAction', dismissedAction: 'dismissedAction', share: async () => ({ action: 'dismissedAction' }),
            } };
        });
        vi.doMock('expo-file-system', () => fs.module);
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true }));
        const { deliverUsageTextDocument } = await import('./usageExportFile');
        expect(await deliverUsageTextDocument({ content: 'day,tokens', fileName: 'usage.csv', mimeType: 'text/csv' }))
            .toEqual({ kind: 'cancelled' });
        expect(fs.files.size).toBe(0);
    });
});
