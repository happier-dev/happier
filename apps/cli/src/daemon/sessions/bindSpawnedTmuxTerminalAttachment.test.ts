import { describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';

import { readTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { bindSpawnedTmuxTerminalAttachment } from './bindSpawnedTmuxTerminalAttachment';

describe('bindSpawnedTmuxTerminalAttachment', () => {
  it('persists immutable shared-window ownership after the Happier session id is known', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await bindSpawnedTmuxTerminalAttachment({
        happyHomeDir: dir.name,
        sessionId: 'sess-daemon-tmux',
        tmuxSessionName: 'happy',
        tmuxWindowName: 'happy-window',
        tmuxTmpDir: '/tmp/happier-tmux',
        disposeUnboundHost: vi.fn(async () => undefined),
      });

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess-daemon-tmux',
      })).resolves.toMatchObject({
        version: 2,
        attachmentId: expect.any(String),
        handle: {
          attachmentId: expect.any(String),
          kind: 'tmux',
          sessionName: 'happy',
          paneId: 'happy-window',
          socketDir: '/tmp/happier-tmux',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            requiresLocalAttachmentInfo: true,
            liveProbe: 'required',
          },
        },
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:happy-window', tmpDir: '/tmp/happier-tmux' },
        },
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('disposes the exact unbound host when committed attachment persistence fails', async () => {
    const invalidHome = tmp.fileSync();
    const disposeUnboundHost = vi.fn(async () => undefined);
    try {
      await expect(bindSpawnedTmuxTerminalAttachment({
        happyHomeDir: invalidHome.name,
        sessionId: 'sess-bind-failure',
        tmuxSessionName: 'happy',
        tmuxWindowName: 'failed-window',
        disposeUnboundHost,
      })).rejects.toThrow();
      expect(disposeUnboundHost).toHaveBeenCalledOnce();
    } finally {
      invalidHome.removeCallback();
    }
  });
});
