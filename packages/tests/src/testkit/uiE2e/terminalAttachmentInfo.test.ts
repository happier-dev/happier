import { describe, expect, it } from 'vitest';

import { parseTestTerminalAttachmentInfo } from './terminalAttachmentInfo';

describe('parseTestTerminalAttachmentInfo', () => {
    it('accepts the current v2 terminal attachment contract', () => {
        expect(parseTestTerminalAttachmentInfo(JSON.stringify({
            version: 2,
            attachmentId: 'attachment-1',
            sessionId: 'session-1',
            handle: { attachmentId: 'attachment-1', kind: 'tmux' },
            terminal: { mode: 'tmux', tmux: { target: 'suite:pane', tmpDir: '/tmp/tmux' } },
            updatedAt: 123,
        }))).toEqual(expect.objectContaining({
            version: 2,
            attachmentId: 'attachment-1',
            sessionId: 'session-1',
        }));
    });

    it('rejects the obsolete v1 fixture shape', () => {
        expect(parseTestTerminalAttachmentInfo(JSON.stringify({
            version: 1,
            sessionId: 'session-1',
            terminal: { mode: 'tmux' },
            updatedAt: 123,
        }))).toBeNull();
    });
});
