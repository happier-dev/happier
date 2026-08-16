import { describe, expect, it } from 'vitest';

import { buildTerminalMetadataFromRuntimeFlags } from './terminalMetadata';

describe('buildTerminalMetadataFromRuntimeFlags', () => {
  it('publishes the bound attachment identity for a tmux runtime', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'tmux',
      requested: 'tmux',
      tmuxTarget: 'happy:window-1',
      attachmentId: 'attachment-1',
    })).toEqual({
      mode: 'tmux',
      requested: 'tmux',
      tmux: { target: 'happy:window-1' },
      controlServiceabilityV1: {
        v: 1,
        attachmentId: 'attachment-1',
        state: 'servable',
        observedAt: expect.any(Number),
      },
    });
  });

  it('builds windows terminal metadata from runtime flags', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windowId: 'happy-session-1',
      title: 'Happier claude sess_1',
    } as any)).toEqual({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-session-1',
        title: 'Happier claude sess_1',
      },
    });
  });

  it('builds windows console metadata from runtime flags', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'windows_console',
      requested: 'console',
    } as any)).toEqual({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
      },
    });
  });
});
