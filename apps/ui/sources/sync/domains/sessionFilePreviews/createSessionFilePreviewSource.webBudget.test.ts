import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileDownloadHarness } from '@/dev/testkit/harness/workspaceFileDownloadHarness';
import { createSessionFilePreviewSource } from './createSessionFilePreviewSource';

// Keep real carrier modules loaded across cases; only their OS/network inputs vary.
describe('shared web file preview buffering budget', () => {
    const previousPlatform = Platform.OS;
    beforeEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    });
    afterEach(() => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform });
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    async function createRealWebPreviewHarness() {
        // A desktop WebView uses the same web Blob preview, with genuine OS IPC
        // and HTTP boundaries; admission, grants, encryption and byte sinks stay real.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            if (command === 'iroh_get_availability') return { available: true };
            if (command === 'iroh_get_application_endpoint') return { endpointId: 'b'.repeat(64) };
            if (command === 'iroh_start_machine_tunnel') return { leaseId: 'preview-desktop-lease', localPort: 48126 };
            if (command === 'iroh_stop_machine_tunnel') return undefined;
            throw new Error(`Unexpected desktop IPC command: ${command}`);
        } });
        return await createWorkspaceFileDownloadHarness({ name: 'clip.mp4', bytes: new Uint8Array([1, 2, 3]) });
    }

    it.each(['video/mp4', 'image/png'])('rejects %s at the shared web buffering budget before encrypted chunk reads', async mimeType => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '2');
        const harness = await createRealWebPreviewHarness();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized-preview');
        try {
            const result = await createSessionFilePreviewSource({ scope: harness.scope, filePath: 'clip.mp4', mimeType, maxBytes: mimeType === 'video/mp4' ? null : 100 });
            expect(result).toEqual({ ok: false, error: 'File exceeds the preview size limit' });
            expect(harness.requests.some(request => request.url.endsWith('/chunks/0'))).toBe(false);
            expect(createObjectURL).not.toHaveBeenCalled();
        } finally {
            createObjectURL.mockRestore();
            await harness.reset();
        }
    });

    it('materializes a web video exactly at the shared buffering budget through encrypted chunks', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', '3');
        const harness = await createRealWebPreviewHarness();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bounded-preview');
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        try {
            const result = await createSessionFilePreviewSource({ scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null });
            expect(result).toMatchObject({ ok: true, source: { kind: 'object-url', byteLength: 3 } });
            expect(harness.requests.some(request => request.url.endsWith('/chunks/0'))).toBe(true);
            if (result.ok && result.source.kind === 'object-url') result.source.revoke();
            expect(revokeObjectURL).toHaveBeenCalledWith('blob:bounded-preview');
        } finally {
            createObjectURL.mockRestore(); revokeObjectURL.mockRestore();
            await harness.reset();
        }
    });

    it('retains the existing web memory ceiling even when file-backed download admission is configured higher', async () => {
        const { WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES } = await import('@/hooks/workspaces/transfers/webDownloadFileSink');
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES', String(WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES * 2));
        const harness = await createRealWebPreviewHarness();
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:oversized-preview');
        try {
            const result = await createSessionFilePreviewSource({ scope: harness.scope, filePath: 'clip.mp4', mimeType: 'video/mp4', maxBytes: null, expectedSizeBytes: WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES + 1 });
            expect(result).toEqual({ ok: false, error: 'File exceeds the preview size limit' });
            expect(harness.rpcRequests).toHaveLength(0);
            expect(createObjectURL).not.toHaveBeenCalled();
        } finally {
            createObjectURL.mockRestore();
            await harness.reset();
        }
    });

});
