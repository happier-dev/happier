import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureUsageViewPng, deliverUsageImageFile } from './usageAnalyticsExport';

const boundary = vi.hoisted(() => ({ OS: 'web', dataUri: 'data:image/png;base64,iVBORw==', capture: vi.fn(), download: vi.fn() }));
vi.mock('react-native', async () => ({ ...(await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock()), Platform: boundary }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native-view-shot/src/RNViewShot.web', () => ({ default: { captureRef: async () => { await boundary.capture(); return boundary.dataUri; } } }));
const fs = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock());
vi.mock('expo-file-system', () => fs.module);
vi.mock('react-native-view-shot', () => ({ captureRef: async () => { await boundary.capture(); return 'file:///tmp/capture.png'; }, releaseCapture: (uri: string) => { fs.files.delete(uri); } }));
afterEach(() => { boundary.OS = 'web'; boundary.dataUri = 'data:image/png;base64,iVBORw=='; boundary.capture.mockReset(); fs.files.clear(); vi.unstubAllGlobals(); });

describe('usage PNG production and local delivery boundaries', () => {
    it('rejects a non-PNG data URI rather than labeling its bytes PNG', async () => {
        boundary.dataUri = 'data:image/jpeg;base64,iVBORw==';
        await expect(captureUsageViewPng({})).rejects.toThrow();
    });
    it('discards capture bytes if authority retires during capture', async () => {
        let current = true;
        boundary.capture.mockImplementation(() => { current = false; });
        await expect(captureUsageViewPng({}, { isCurrent: () => current })).rejects.toThrow();
    });
    it('discards capture bytes on cancellation after the capture await', async () => {
        const controller = new AbortController();
        boundary.capture.mockImplementation(() => controller.abort());
        await expect(captureUsageViewPng({}, { signal: controller.signal })).rejects.toThrow();
    });
    it('reads native temporary PNG bytes and releases capture custody', async () => {
        boundary.OS = 'ios';
        fs.files.set('file:///tmp/capture.png', [137, 80, 78, 71]);
        expect(await captureUsageViewPng({})).toBe('iVBORw==');
        expect(fs.files.has('file:///tmp/capture.png')).toBe(false);
    });
    it('releases native capture custody when cancelled after native capture completes', async () => {
        boundary.OS = 'android';
        fs.files.set('file:///tmp/capture.png', [137, 80, 78, 71]);
        const controller = new AbortController();
        boundary.capture.mockImplementation(() => controller.abort());
        await expect(captureUsageViewPng({}, { signal: controller.signal })).rejects.toThrow();
        expect(fs.files.has('file:///tmp/capture.png')).toBe(false);
    });
    it('does not download a file after authority retirement', async () => {
        const anchor = { click: boundary.download, remove() {}, style: {} };
        vi.stubGlobal('document', { createElement: () => anchor });
        expect(await deliverUsageImageFile({ mediaType: 'image/png', fileName: 'safe.png', base64: 'iVBORw==' }, 'save', { isCurrent: () => false })).toBe(false);
        expect(boundary.download.mock.calls).toEqual([]);
    });
});
