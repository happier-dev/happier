import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { downloadDaemonWorkspaceFileToDestination } from '../families/workspaceFileTransfers';

describe('prepared file download destination failures', () => {
    const previousPlatform = Platform.OS;
    let harness: Awaited<ReturnType<typeof createWorkspaceFileDownloadHarness>>;
    beforeEach(async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        harness = await createWorkspaceFileDownloadHarness();
    });
    afterEach(async () => {
        await harness?.reset();
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
    });

    it('removes a destination whose close rejects and preserves the original error', async () => {
        const original = new Error('Disk close failed');
        const bytes: number[] = [];
        let allocated = true;
        const result = downloadDaemonWorkspaceFileToDestination({
            ...harness.scope, request: { path: 'clip.mp4', asZip: false },
            destination: {
                writeBytes: async chunk => { bytes.push(...chunk); },
                close: async () => { throw original; },
                cleanup: async () => { allocated = false; bytes.length = 0; },
            },
        });
        await expect(result).rejects.toBe(original);
        expect(allocated).toBe(false);
        expect(bytes).toEqual([]);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });

    it('retains the download error when destination cleanup also rejects', async () => {
        const original = new Error('Disk close failed');
        const cleanup = new Error('File deletion failed');
        const result = downloadDaemonWorkspaceFileToDestination({
            ...harness.scope, request: { path: 'clip.mp4', asZip: false },
            destination: {
                writeBytes: async () => {},
                close: async () => { throw original; },
                cleanup: async () => { throw cleanup; },
            },
        });
        await expect(result).rejects.toMatchObject({ errors: [original, cleanup] });
        await expect(result).rejects.toThrow(/Disk close failed.*File deletion failed/);
        expect(harness.nativeTunnelStops).toHaveLength(1);
    });
    it('retains initialization failure when removing its destination also rejects', async () => {
        const cleanup = new Error('File deletion failed');
        const result = downloadDaemonWorkspaceFileToDestination({
            ...harness.scope, request: { path: 'clip.mp4', asZip: false },
            onInit: async () => ({ success: false, error: 'Destination initialization failed' }),
            destination: { writeBytes: async () => {}, close: async () => {}, cleanup: async () => { throw cleanup; } },
        });
        await expect(result).rejects.toThrow(/Destination initialization failed.*File deletion failed/);
    });

});
