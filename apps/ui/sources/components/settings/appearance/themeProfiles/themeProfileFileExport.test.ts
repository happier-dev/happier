import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { exportThemeProfileFile } from './themeProfileFileExport';
const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeNativeMock({ platformOS: 'ios' });
    return { ...native, Platform: Object.assign(platform, native.Platform) };
});

const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const sharing = vi.hoisted(() => ({ available: true, failed: false, observed: vi.fn() }));
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => sharing.available,
    shareAsync: async (uri: string, options?: { mimeType?: string; dialogTitle?: string }) => {
        await sharing.observed(uri, undefined, options?.mimeType, options?.dialogTitle);
        if (sharing.failed) throw new Error('native_share_failed');
    },
}));
// The native bridge is the recipient/OS boundary; the sharing and cache owners stay real.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
        shareFile: async (uri: string, name: string, mimeType?: string, dialogTitle?: string) => {
            await sharing.observed(uri, name, mimeType, dialogTitle);
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

describe('theme profile file export custody', () => {
    it.each(['ios', 'android'])('shares unchanged theme JSON and keeps only %s recipient custody', async (os) => {
        platform.OS = os;
        const json = exportThemeProfileToJson({ schemaVersion: 1, id: 'synthetic', name: 'Synthetic theme', createdAt: '2026-05-12T00:00:00.000Z', updatedAt: '2026-05-12T00:00:00.000Z', base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} } });
        sharing.observed.mockImplementation((uri: string, _name?: string, mimeType?: string, title?: string) => {
            expect(new TextDecoder().decode(new Uint8Array(fs.files.get(uri)!))).toBe(json);
            expect(mimeType).toBe('application/json');
            expect(title).toBeTruthy();
        });
        await exportThemeProfileFile('happier-theme-synthetic.json', json);
        const uri = sharing.observed.mock.calls[0][0];
        expect(uri).toContain('/happier-downloads/');
        expect(fs.files.has(uri)).toBe(os === 'android');
        if (os === 'android') expect(sharing.observed.mock.calls[0][1]).toBe('happier-theme-synthetic.json');
    });
    it('removes a rejected native theme share', async () => {
        sharing.failed = true;
        await expect(exportThemeProfileFile('happier-theme-synthetic.json', '{}')).rejects.toThrow('native_share_failed');
        expect(fs.files.size).toBe(0);
    });
});
