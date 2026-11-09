import type { BrowserCommandV1} from '@happier-dev/protocol/browser/control/v1';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
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
    it('admits the streamed projection and routes navigation to its daemon owner without applying local navigation', () => {
        const sendDaemonCommand = vi.fn();
        const { result } = openStreamedView({ sendDaemonCommand });
        expect(result.state.viewsById.view_streamed).toMatchObject({ engineKind: 'streamedSurface', target: streamedTarget });
        const navigate = { kind: 'navigate', commandId: 'navigate', browserSessionId: 'browser_session_streamed',
            viewId: 'view_streamed', url: 'https://next.test' } satisfies BrowserCommandV1;
        const navigated = dispatchBrowserControlCommand(result.state, navigate, { sendDaemonCommand });

        expect(navigated.effects).toEqual([{ kind: 'daemonCommand', command: navigate }]);
        expect(navigated.state).toBe(result.state);
        expect(sendDaemonCommand).toHaveBeenCalledWith(navigate);
    });
});
