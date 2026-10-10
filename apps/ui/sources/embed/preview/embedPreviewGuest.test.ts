import { describe, expect, it, vi } from 'vitest';

import { startEmbedPreviewGuest, type EmbedPreviewWindow } from './embedPreviewGuest';

const OWN_ORIGIN = 'https://app.happier.dev';
const identity = { instanceId: 'preview-1', mountNonce: 'nonce-1' };

function createPreviewWindow(ancestorOrigins: readonly string[] | null, options: Readonly<{ nativeWebView?: boolean }> = {}) {
    const listeners = new Set<(event: MessageEvent) => void>();
    const parent = {};
    const previewWindow: EmbedPreviewWindow = {
        parent,
        ...(options.nativeWebView ? { ReactNativeWebView: { postMessage: () => undefined } } : {}),
        location: { origin: OWN_ORIGIN, ...(ancestorOrigins ? { ancestorOrigins } : {}) },
        addEventListener: (_type, listener) => { listeners.add(listener); },
        removeEventListener: (_type, listener) => { listeners.delete(listener); },
    };
    const deliver = (event: Partial<MessageEvent>) => {
        for (const listener of [...listeners]) listener(event as MessageEvent);
    };
    return { previewWindow, parent, deliver };
}

const configure = (sequence: number, radius: 'sharp' | 'round') => ({
    version: 1, identity, sequence, direction: 'hostToFrame',
    payload: { kind: 'configure', style: { v: 1, radius } },
});

describe('embed preview guest', () => {
    it('keeps rendering unadmitted without ancestorOrigins until its parent supplies a valid same-origin configure', () => {
        const frame = createPreviewWindow(null);
        const onConfigure = vi.fn();
        const guest = startEmbedPreviewGuest({ window: frame.previewWindow, identity, onConfigure });
        expect(guest.admitted).toBe(false);
        frame.deliver({ source: frame.parent as Window, origin: 'https://evil.example', data: configure(0, 'sharp') });
        frame.deliver({ source: {} as Window, origin: OWN_ORIGIN, data: configure(1, 'sharp') });
        frame.deliver({ source: frame.parent as Window, origin: OWN_ORIGIN, data: { ...configure(2, 'sharp'), identity: { instanceId: 'x', mountNonce: 'y' } } });
        expect(guest.admitted).toBe(false);
        expect(onConfigure).not.toHaveBeenCalled();
        frame.deliver({ source: frame.parent as Window, origin: OWN_ORIGIN, data: configure(3, 'round') });
        expect(guest.admitted).toBe(true);
        expect(onConfigure).toHaveBeenCalledTimes(1);
        guest.dispose();
        frame.deliver({ source: frame.parent as Window, origin: OWN_ORIGIN, data: configure(4, 'sharp') });
        expect(onConfigure).toHaveBeenCalledTimes(1);
    });
    it('applies configure messages from its same-origin parent only', () => {
        const frame = createPreviewWindow([OWN_ORIGIN]);
        const onConfigure = vi.fn();
        const guest = startEmbedPreviewGuest({ window: frame.previewWindow, identity, onConfigure });

        frame.deliver({ source: frame.parent as Window, origin: 'https://evil.example', data: configure(0, 'sharp') });
        frame.deliver({ source: {} as Window, origin: OWN_ORIGIN, data: configure(1, 'sharp') });
        frame.deliver({ source: frame.parent as Window, origin: OWN_ORIGIN, data: { ...configure(2, 'sharp'), identity: { instanceId: 'x', mountNonce: 'y' } } });
        frame.deliver({ source: frame.parent as Window, origin: OWN_ORIGIN, data: configure(3, 'round') });

        expect(guest.refused).toBe(false);
        expect(onConfigure).toHaveBeenCalledTimes(1);
        expect(onConfigure.mock.calls[0]?.[0]).toMatchObject({ kind: 'configure', style: { radius: 'round' } });
    });

    it('refuses to run inside a page from another origin', () => {
        const frame = createPreviewWindow(['https://crm.acme.dev']);
        const onConfigure = vi.fn();
        const guest = startEmbedPreviewGuest({ window: frame.previewWindow, identity, onConfigure });

        frame.deliver({ source: frame.parent as Window, origin: 'https://crm.acme.dev', data: configure(0, 'round') });

        expect(guest.refused).toBe(true);
        expect(onConfigure).not.toHaveBeenCalled();
    });

    it('takes the same configure messages from the app when it runs in the app\'s native WebView', () => {
        // Native Settings loads this route in the app's WebView engine; the engine delivers host
        // messages as an injected MessageEvent whose data is the serialized envelope (no source window).
        const webView = createPreviewWindow([], { nativeWebView: true });
        const onConfigure = vi.fn();
        startEmbedPreviewGuest({ window: webView.previewWindow, identity, onConfigure });

        webView.deliver({ source: null, origin: '', data: JSON.stringify(configure(0, 'round')) });
        webView.deliver({ source: null, origin: '', data: JSON.stringify({ ...configure(1, 'sharp'), identity: { instanceId: 'x', mountNonce: 'y' } }) });
        webView.deliver({ source: null, origin: '', data: 'not json' });

        expect(onConfigure).toHaveBeenCalledTimes(1);
        expect(onConfigure.mock.calls[0]?.[0]).toMatchObject({ kind: 'configure', style: { radius: 'round' } });
    });

    it('ignores injected messages in an ordinary browser page', () => {
        const page = createPreviewWindow([]);
        const onConfigure = vi.fn();
        startEmbedPreviewGuest({ window: page.previewWindow, identity, onConfigure });

        page.deliver({ source: null, origin: '', data: JSON.stringify(configure(0, 'round')) });

        expect(onConfigure).not.toHaveBeenCalled();
    });
});
