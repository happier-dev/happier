import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveWorkflowDocument } from '@/sync/domains/workflows/workflowDocumentFile';
import { exportBugReportDiagnosticsBundle } from '@/components/settings/bugReports/bugReportExport';
import { exportUsageTextDocument } from '@/components/settings/usage/usageExportFile';
import { captureUsageViewPng, deliverUsageImageFile } from '@/components/settings/usage/usageAnalyticsExport';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return { ...await createReactNativeWebMock(), Platform: platform };
});
const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const sdk = vi.hoisted(() => ({ available: true, availability: vi.fn(), share: vi.fn(), capture: vi.fn(), releaseCapture: vi.fn(), copy: vi.fn() }));
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: async (uri: string, text: string) => { fs.files.set(uri, [...new TextEncoder().encode(text)]); },
    copyAsync: async (options: { from: string; to: string }) => {
        sdk.copy(options);
        const bytes = fs.files.get(options.from);
        if (!bytes) throw new Error('Capture unavailable');
        expect(fs.close).toHaveBeenCalledWith(options.to);
        fs.files.set(options.to, [...bytes]);
    },
}));
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => { sdk.availability(); return sdk.available; },
    shareAsync: async (uri: string, options?: { mimeType?: string; UTI?: string; dialogTitle?: string }) => {
        await sdk.share({ uri, ...options, bytes: fs.files.get(uri) });
    },
}));
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
        shareFile: async (uri: string, name: string, mimeType?: string, dialogTitle?: string) => {
            await sdk.share({ uri, name, mimeType, dialogTitle, bytes: fs.files.get(uri) });
        },
    } : null,
}));
vi.mock('react-native-view-shot', () => ({
    captureRef: async () => {
        sdk.capture();
        // The installed SDK returns a raw iOS temporary path and an Android file URI.
        return platform.OS === 'ios' ? '/tmp/ReactNative/capture.png' : 'file:///tmp/capture.png';
    },
    releaseCapture: (uri: string) => { sdk.releaseCapture(uri); fs.files.delete(uri.startsWith('file://') ? uri : `file://${uri}`); },
}));
afterEach(() => {
    fs.files.clear();
    sdk.available = true;
    vi.clearAllMocks();
    sdk.share.mockReset();
    sdk.availability.mockReset();
    platform.OS = 'ios';
});


const documents = [
    {
        kind: 'workflow', name: 'review.workflow.json', mimeType: 'application/json',
        export: async () => { await saveWorkflowDocument({ fileName: 'review.workflow.json', json: '{"kind":"happier.workflow"}' }); },
        read: (text: string) => expect(JSON.parse(text)).toEqual({ kind: 'happier.workflow' }),
    },
    {
        kind: 'usage', name: 'usage.csv', mimeType: 'text/csv',
        export: async () => { expect(await exportUsageTextDocument({ content: 'name,tokens\nAlice,12\n', fileName: 'usage.csv', mimeType: 'text/csv' })).toBe(true); },
        read: (text: string) => expect(text).toBe('name,tokens\nAlice,12\n'),
    },
    {
        kind: 'diagnostics', name: undefined, mimeType: 'application/json',
        export: async () => { await exportBugReportDiagnosticsBundle({ environment: { appVersion: '0.3.0', platform: platform.OS, deploymentType: 'cloud' }, artifacts: [{ filename: 'logs.txt', sourceKind: 'ui-mobile', contentType: 'text/plain', content: 'synthetic log' }] }); },
        read: (text: string) => expect(JSON.parse(text).schemaVersion).toBe(1),
    },
];
describe('native export consumers through the cache sharing owner', () => {
    it.each(documents)('shares $kind document bytes with platform custody', async (document) => {
        for (const os of ['android', 'ios']) {
            platform.OS = os;
            sdk.share.mockImplementation((handoff: { uri: string; name?: string; mimeType?: string; UTI?: string; dialogTitle?: string; bytes: number[] }) => {
                document.read(new TextDecoder().decode(new Uint8Array(handoff.bytes)));
                if (document.kind === 'diagnostics') {
                    expect(handoff.dialogTitle).toBeTruthy();
                    if (os === 'ios') expect(handoff.UTI).toBe('public.json');
                }
            });
            await document.export();
            const handoff = sdk.share.mock.calls.at(-1)![0];
            expect(handoff.uri).toContain('/happier-downloads/');
            expect(handoff.mimeType).toBe(document.mimeType);
            if (os === 'android' && document.name) expect(handoff.name).toBe(document.name);
            expect(fs.files.has(handoff.uri)).toBe(os === 'android');
            fs.files.clear();
            sdk.share.mockReset();
        }
    });
    it('removes a rejected diagnostic handoff and preserves its error', async () => {
        platform.OS = 'android';
        sdk.share.mockRejectedValue(new Error('Recipient unavailable'));
        await expect(documents[2].export()).rejects.toThrow('Recipient unavailable');
        expect(fs.files.size).toBe(0);
    });
    it.each(['ios', 'android'])('copies a captured PNG into recipient custody on %s and releases the original', async (os) => {
        platform.OS = os;
        const bytes = [137, 80, 78, 71, 255];
        const captureUri = os === 'ios' ? '/tmp/ReactNative/capture.png' : 'file:///tmp/capture.png';
        fs.files.set(captureUri.startsWith('file://') ? captureUri : `file://${captureUri}`, bytes);
        sdk.share.mockImplementation((handoff: { bytes: number[] }) => { expect(handoff.bytes).toEqual(bytes); });
        const base64 = await captureUsageViewPng({});
        expect(await deliverUsageImageFile({ mediaType: 'image/png', base64, fileName: 'recap.png' }, 'save')).toBe(true);
        const handoff = sdk.share.mock.calls.at(-1)![0];
        expect(handoff.uri).toContain('/happier-downloads/');
        expect(handoff.mimeType).toBe('image/png');
        expect(fs.files.has(handoff.uri)).toBe(os === 'android');
        expect(fs.files.has(captureUri.startsWith('file://') ? captureUri : `file://${captureUri}`)).toBe(false);
        expect(sdk.releaseCapture).toHaveBeenCalledWith(captureUri);
    });
    it('releases a failed native capture without releasing a different text payload', async () => {
        const captureUri = '/tmp/ReactNative/capture.png';
        await expect(captureUsageViewPng({})).rejects.toThrow('File does not exist');
        expect(fs.files.size).toBe(0);
        expect(sdk.releaseCapture).toHaveBeenCalledWith(captureUri);
        expect(sdk.share.mock.calls).toEqual([]);
    });
    it('cleans prepared native image bytes instead of sharing after authority loss during share availability', async () => {
        let current = true;
        sdk.availability.mockImplementation(() => { current = false; });
        expect(await deliverUsageImageFile({ mediaType: 'image/png', fileName: 'recap.png', base64: 'iVBORw==' },
            'share', { isCurrent: () => current })).toBe(false);
        expect(fs.files.size).toBe(0);
        expect(sdk.share.mock.calls).toEqual([]);
    });

});
