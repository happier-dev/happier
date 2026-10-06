import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceDiagnosticArtifactExportTarget } from './artifactExportTarget';
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return { ...await createReactNativeWebMock(), Platform: platform };
});

const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const sharing = vi.hoisted(() => ({ available: true, failed: false, observed: vi.fn() }));
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => sharing.available,
    shareAsync: async (uri: string, options?: { mimeType?: string }) => {
        await sharing.observed(uri, undefined, options?.mimeType);
        if (sharing.failed) throw new Error('native_share_failed');
    },
}));
// The native bridge is the recipient/OS boundary; the sharing and cache owners stay real.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
        shareFile: async (uri: string, name: string, mimeType?: string) => {
            await sharing.observed(uri, name, mimeType);
            if (sharing.failed) throw new Error('native_share_failed');
        },
    } : null,
}));

afterEach(() => {
    fs.files.clear();
    vi.clearAllMocks();
    sharing.observed.mockReset();
    sharing.available = true;
    sharing.failed = false;
    platform.OS = 'ios';
});

describe('native voice diagnostic export custody', () => {
    it.each(['ios', 'android'])('keeps the %s recipient file readable through its handoff', async (os) => {
        platform.OS = os;
        const bytes = new Uint8Array([1, 2, 255]);
        const result = await createVoiceDiagnosticArtifactExportTarget({ name: 'diagnostic.wav', sizeBytes: bytes.length });
        if (!result.ok) throw new Error(result.error);
        sharing.observed.mockImplementation((uri: string, name?: string) => {
            expect(fs.files.get(uri)).toEqual([...bytes]);
            expect(fs.close).toHaveBeenCalledWith(uri);
        });
        await result.target.destination.writeBytes(bytes);
        await result.target.destination.close();
        await result.target.complete('diagnostic.wav');
        // The caller always cleans its target after completion.
        await result.target.cleanup();
        expect(sharing.observed).toHaveBeenCalledOnce();
        if (os === 'android') expect(sharing.observed.mock.calls[0][1]).toBe('diagnostic.wav');
        expect(fs.files.size).toBe(os === 'android' ? 1 : 0);
        expect(sharing.observed.mock.calls[0][0]).toContain('/happier-downloads/');
    });
    it.each(['ios', 'android'])('removes a failed %s handoff', async (os) => {
        platform.OS = os;
        sharing.failed = true;
        const result = await createVoiceDiagnosticArtifactExportTarget({ name: 'diagnostic.wav', sizeBytes: 1 });
        if (!result.ok) throw new Error(result.error);
        await result.target.destination.writeBytes(new Uint8Array([9]));
        await result.target.destination.close();
        await expect(result.target.complete('diagnostic.wav')).rejects.toThrow('native_share_failed');
        await result.target.cleanup();
        expect(fs.files.size).toBe(0);
    });
    it('preserves the unavailable error and cleans an unshared iOS file', async () => {
        sharing.available = false;
        const result = await createVoiceDiagnosticArtifactExportTarget({ name: 'diagnostic.wav', sizeBytes: 1 });
        if (!result.ok) throw new Error(result.error);
        await result.target.destination.writeBytes(new Uint8Array([9]));
        await result.target.destination.close();
        await expect(result.target.complete('diagnostic.wav')).rejects.toThrow('voice_diagnostics_share_unavailable');
        await result.target.cleanup();
        expect(fs.files.size).toBe(0);
        expect(sharing.observed).not.toHaveBeenCalled();
    });
});
