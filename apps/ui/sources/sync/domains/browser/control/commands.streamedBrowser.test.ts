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

/**
 * DEC-5: the streamed-browser adapter is contracted.
 *
 * These cases previously asserted the opposite — that supplying a daemon control transport made a
 * streamed view open and navigate. That was a seam asserting its own reachability: nothing in
 * production can produce a `streamedBrowser` target, no renderer for the kind exists, and the
 * server excludes it outright, so "the transport is reachable" was never evidence that a surface
 * could paint. The contract now is that the kind is unselectable, whatever the transport says.
 */
describe('streamed browser surface control seam', () => {
    it('refuses to open a streamed browser view even when a daemon control transport is supplied', () => {
        const sendDaemonCommand = vi.fn();
        const { openCommand, result } = openStreamedView({ sendDaemonCommand });

        expect(result.effects).toEqual([{
            kind: 'commandRejected',
            command: openCommand,
            reasonCode: 'adapter_unavailable',
        }]);
        expect(result.state.viewsById.view_streamed).toBeUndefined();
        expect(sendDaemonCommand).not.toHaveBeenCalled();
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
