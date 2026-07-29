import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserSidecarCdpControlAdapter } from './controlAdapter';

function fakeTransport() {
    return {
        openPage: vi.fn(async () => ({ targetId: 'target_1', sessionId: 'cdp_session_1' })),
        dispatchPageCommand: vi.fn(async () => ({})),
        dispatchBrowserCommand: vi.fn(async () => ({})),
    };
}

function openViewCommand(): Extract<BrowserCommandV1, { kind: 'openView' }> {
    return {
        kind: 'openView',
        commandId: 'command_open',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        platform: 'web',
        focus: true,
        target: { kind: 'externalUrl', targetId: 'target_external_1', url: 'https://example.test/start' },
    };
}

describe('sidecar cdp control adapter context page-handle resolver', () => {
    it('returns the bound page handle for an owned view after openView', async () => {
        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1',
            sidecarId: 'sidecar_1',
            transport: fakeTransport(),
        });

        expect(adapter.resolvePageHandle({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toBeNull();
        await adapter.dispatchCommand(openViewCommand());

        expect(adapter.resolvePageHandle({ browserSessionId: 'browser_session_1', viewId: 'view_1' }))
            .toEqual({ targetId: 'target_1', sessionId: 'cdp_session_1' });
    });

    it('returns null for an unowned session or unknown view', async () => {
        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1',
            sidecarId: 'sidecar_1',
            transport: fakeTransport(),
        });
        await adapter.dispatchCommand(openViewCommand());

        expect(adapter.resolvePageHandle({ browserSessionId: 'other_session', viewId: 'view_1' })).toBeNull();
        expect(adapter.resolvePageHandle({ browserSessionId: 'browser_session_1', viewId: 'view_missing' })).toBeNull();
    });
});
