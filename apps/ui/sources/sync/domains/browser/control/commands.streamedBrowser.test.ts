import type { BrowserCommandV1, BrowserViewTargetV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { dispatchBrowserControlCommand } from './commands';
import { createBrowserControlState } from './reducer';

const streamedTarget = {
    kind: 'streamedBrowser',
    targetId: 'stream_1',
    streamId: 'stream_1',
} satisfies BrowserViewTargetV1;

function openStreamedView(options: Parameters<typeof dispatchBrowserControlCommand>[2]) {
    const openCommand = {
        kind: 'openView',
        commandId: 'command_open',
        browserSessionId: 'browser_session_streamed',
        viewId: 'view_streamed',
        target: streamedTarget,
        platform: 'web',
        currentUrl: 'https://app.happier.test/',
        focus: true,
    } satisfies BrowserCommandV1;
    return { openCommand, result: dispatchBrowserControlCommand(createBrowserControlState(), openCommand, options) };
}

describe('streamed browser surface control seam', () => {
    it('opens a daemon-authoritative streamed browser view when the daemon control transport is supplied', () => {
        const sendDaemonCommand = vi.fn();
        const { result } = openStreamedView({ sendDaemonCommand });

        // The view is no longer rejected as adapter_unavailable: a reachable control transport
        // makes the streamed surface available and daemon-authoritative.
        expect(result.effects.some((effect) => effect.kind === 'commandRejected')).toBe(false);
        expect(result.state.viewsById.view_streamed).toMatchObject({
            adapterKind: 'streamedBrowserSurface',
            engineKind: 'streamedSurface',
        });
        expect(result.state.viewsById.view_streamed?.adapterCapabilities.navigation.canNavigate).toBe(true);
    });

    it('routes navigation on a streamed browser view through the daemon control transport (the seam)', () => {
        const sendDaemonCommand = vi.fn();
        const { result: opened } = openStreamedView({ sendDaemonCommand });

        const navigateCommand = {
            kind: 'navigate',
            commandId: 'command_navigate',
            browserSessionId: 'browser_session_streamed',
            viewId: 'view_streamed',
            url: 'https://app.happier.test/dashboard',
        } satisfies BrowserCommandV1;

        const result = dispatchBrowserControlCommand(opened.state, navigateCommand, { sendDaemonCommand });

        // Navigation is NOT rejected and NOT applied locally; it rides the SEAM-FINISH-2 transport.
        expect(result.effects).toEqual([{ kind: 'daemonCommand', command: navigateCommand }]);
        expect(sendDaemonCommand).toHaveBeenCalledWith(navigateCommand);
    });

    it('fails closed (adapter_unavailable) when no daemon control transport is reachable', () => {
        const { openCommand, result } = openStreamedView({});

        expect(result.effects).toEqual([{
            kind: 'commandRejected',
            command: openCommand,
            reasonCode: 'adapter_unavailable',
        }]);
        expect(result.state.viewsById.view_streamed).toBeUndefined();
    });
});
