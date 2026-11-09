import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

/** URL.origin is "null" for Node's custom schemes, so compare the parsed origin components. */
export function isRendererOrigin(url: string, rendererUrl: string): boolean {
    try {
        const actual = new URL(url);
        const expected = new URL(rendererUrl);
        return actual.protocol === expected.protocol && actual.host === expected.host
            && actual.username === '' && actual.password === '';
    } catch {
        return false;
    }
}

/** Admission belongs to the owning window, never merely another frame at the same URL. */
export function assertRendererSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, rendererUrl: string): void {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()
        || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !event.senderFrame || !isRendererOrigin(event.senderFrame.url, rendererUrl)) {
        throw new Error('Untrusted renderer');
    }
}

export function isExternalWebUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
            && parsed.hostname !== '' && parsed.username === '' && parsed.password === '';
    } catch {
        return false;
    }
}
