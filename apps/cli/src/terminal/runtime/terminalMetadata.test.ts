import { describe, expect, it } from 'vitest';

import type { TerminalHostHandle } from '@happier-dev/agents';

import {
  buildTerminalHostProbeHandleFromMetadata,
  buildTerminalMetadataFromHostHandle,
  buildTerminalMetadataFromRuntimeFlags,
} from './terminalMetadata';

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
      title: 'Happier codex spawn-1',
    })).toEqual({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-session-1',
        title: 'Happier codex spawn-1',
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

  it('builds zellij metadata from runtime flags', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'zellij',
      requested: 'zellij',
    } as any)).toEqual({
      mode: 'zellij',
      requested: 'zellij',
    });
  });
});

describe('buildTerminalMetadataFromHostHandle', () => {
  it('uses the exact tmux pane target from the bound terminal-host handle', () => {
    const handle: TerminalHostHandle = {
      attachmentId: 'attachment-native-terminal' as NonNullable<TerminalHostHandle['attachmentId']>,
      kind: 'tmux',
      sessionName: 'native-terminal',
      paneId: '2',
      socketDir: '/tmp/happier-tmux',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'exclusive',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    };

    expect(buildTerminalMetadataFromHostHandle(handle)).toEqual({
      mode: 'tmux',
      tmux: {
        target: 'native-terminal:2',
        tmpDir: '/tmp/happier-tmux',
      },
    });
  });

  it('maps non-tmux host kinds without manufacturing unavailable identity', () => {
    const attachMetadata: TerminalHostHandle['attachMetadata'] = {
      attachStrategy: 'terminal_host',
      topology: 'exclusive',
      locality: 'same_machine',
      maxClients: null,
      requiresLocalAttachmentInfo: true,
      liveProbe: 'required',
    };

    expect(buildTerminalMetadataFromHostHandle({
      kind: 'zellij',
      sessionName: 'native-zellij',
      attachMetadata,
    })).toEqual({ mode: 'zellij' });
    expect(buildTerminalMetadataFromHostHandle({
      kind: 'windows_console',
      sessionName: 'native-console',
      paneId: 'window-7',
      attachMetadata,
    })).toEqual({
      mode: 'windows_console',
      windows: {
        host: 'console',
        windowId: 'window-7',
      },
    });
  });
});

describe('buildTerminalHostProbeHandleFromMetadata', () => {
  it('reconstructs only an exact tmux target that the current metadata persists', () => {
    expect(buildTerminalHostProbeHandleFromMetadata({
      mode: 'tmux',
      tmux: { target: 'native-terminal:2', tmpDir: '/tmp/happier-tmux' },
    })).toEqual(expect.objectContaining({
      kind: 'tmux',
      sessionName: 'native-terminal',
      paneId: '2',
      socketDir: '/tmp/happier-tmux',
    }));
    expect(buildTerminalHostProbeHandleFromMetadata({ mode: 'zellij' })).toBeNull();
    expect(buildTerminalHostProbeHandleFromMetadata({ mode: 'windows_console' })).toBeNull();
  });
});
