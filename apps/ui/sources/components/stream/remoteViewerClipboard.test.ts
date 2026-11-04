import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('remote viewer clipboard transfer', () => {
    it('preserves text in both directions and leaves the local clipboard intact when the remote read fails', async () => {
        vi.resetModules();
        let local = 'local 日本';
        vi.doMock('react-native', async () => {
            const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeNativeMock({ platformOS: 'ios' });
        });
        vi.doMock('expo-clipboard', () => ({ getStringAsync: async () => local,
            setStringAsync: async (text: string) => { local = text; return true; } }));
        const { transferRemoteViewerClipboard, createRemoteViewerClipboardShortcut } = await import('./remoteViewerClipboard');
        let remote = 'remote 👋';
        const transport = { read: async () => remote, write: async (text: string) => { remote = text; } };
        await transferRemoteViewerClipboard('copy', transport);
        expect(local).toBe('remote 👋');
        local = 'local 日本';
        await transferRemoteViewerClipboard('paste', transport);
        expect(remote).toBe('local 日本');
        await expect(transferRemoteViewerClipboard('copy', { ...transport, read: async () => { throw new Error('clipboard_not_supported'); } }))
            .rejects.toThrow('clipboard_not_supported');
        expect(local).toBe('local 日本');
        const shortcut = createRemoteViewerClipboardShortcut({ ...transport, read: async () => { throw new Error('clipboard_not_supported'); } });
        expect(await shortcut('copy')).toEqual({ ok: false, reason: 'clipboard_not_supported' });
        expect(local).toBe('local 日本');
    });

    it('starts the WebKit write within the gesture before awaiting remote content', async () => {
        vi.resetModules();
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock();
        });
        vi.doMock('expo-clipboard', () => ({}));
        const order: string[] = [];
        let supplied!: Promise<Blob>;
        vi.stubGlobal('ClipboardItem', class { constructor(content: Record<string, Promise<Blob>>) { supplied = content['text/plain']; } });
        vi.stubGlobal('navigator', { clipboard: { write: async () => { order.push('platform-write'); } } });
        const { transferRemoteViewerClipboard } = await import('./remoteViewerClipboard');
        const transfer = transferRemoteViewerClipboard('copy', { read: async () => { order.push('remote-read'); return 'remote'; }, write: async () => {} });
        expect(order).toEqual(['platform-write', 'remote-read']);
        await transfer;
        expect(await (await supplied).text()).toBe('remote');
    });
});
