import { PassThrough } from 'node:stream';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserSidecarCdpControlAdapterFactory } from './controlAdapterFactory';

describe('browser sidecar extension views', () => {
    it.each([
        { kind: 'actionPopup', browserSessionId: 'browser', viewId: 'extension-view' },
        { kind: 'optionsPage', browserSessionId: 'browser', viewId: 'extension-view' },
        { kind: 'optionsPage', browserSessionId: 'b'.repeat(256), viewId: 'v'.repeat(256) },
    ] as const)('binds the installed $kind page for ordinary capture and close ($browserSessionId)', async ({ kind, browserSessionId, viewId }) => {
        // Chromium CDP is the external boundary; the factory and binding owner stay real.
        const transport = {
            openPage: vi.fn(async () => ({ targetId: 'extension-target', sessionId: 'extension-session' })),
            dispatchPageCommand: vi.fn(async () => ({})),
            dispatchBrowserCommand: vi.fn(async () => ({ success: true })),
        };
        const factory = createBrowserSidecarCdpControlAdapterFactory({ browserSessionId, sidecarId: 'sidecar',
            pipe: { readable: new PassThrough(), writable: new PassThrough() },
            connectTransport: async () => ({ transport }) });
        const result = await factory({ machineId: 'machine' });
        if (!result.ok) throw new Error('Factory did not connect');
        expect(result.extensions).toBeDefined();
        if (!result.extensions) throw new Error('Extension views unavailable');
        const extension = { id: 'a'.repeat(32), name: 'Installed extension', version: '1.0', enabled: true,
            source: { kind: 'unpacked' as const, directory: '/fixture' }, directory: '/owned/fixture', permissions: [], hostPermissions: [],
            actionPopup: 'popup.html', optionsPage: 'options.html' };
        const opened = await result.extensions.openView({ commandId: 'open-extension', browserSessionId, viewId,
            profileId: 'profile', extension, kind });
        expect(BrowserCommandDispatchResultV1Schema.parse(opened)).toMatchObject({ status: 'dispatched',
            events: expect.arrayContaining([expect.objectContaining({ kind: 'viewOpened', viewId,
                target: expect.objectContaining({ kind: 'streamedBrowser' }) })]) });
        // The popup must preserve Chromium's active content tab for native tabs.query.
        expect(transport.openPage).toHaveBeenCalledWith({ url: `chrome-extension://${extension.id}/${extension[kind]}`,
            focus: kind !== 'actionPopup' });
        expect(result.contextCapture?.resolvePageHandle({ browserSessionId, viewId }))
            .toEqual({ targetId: 'extension-target', sessionId: 'extension-session' });
        const views = await result.adapter.listViews?.(browserSessionId);
        expect(views).toMatchObject([{ viewId, target: { kind: 'streamedBrowser',
            daemonView: { browserSessionId, viewId } } }]);
        expect(JSON.stringify(views)).not.toContain('chrome-extension:');
        expect(await result.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId, viewId }))
            .toMatchObject({ status: 'dispatched' });
        expect(result.contextCapture?.resolvePageHandle({ browserSessionId, viewId })).toBeNull();
        await result.dispose?.();
    });
});
