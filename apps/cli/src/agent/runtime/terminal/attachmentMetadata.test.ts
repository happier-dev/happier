import { describe, expect, it } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';

import {
  buildTerminalAttachmentMetadataFromHostHandle,
  buildTerminalHostHandleFromAttachmentMetadata,
} from './attachmentMetadata';

describe('buildTerminalAttachmentMetadataFromHostHandle', () => {
  it('builds tmux terminal metadata from a host handle', () => {
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };

    expect(buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual({
      mode: 'tmux',
      tmux: { target: 'happy:unified-window' },
    });
  });

  it('builds zellij terminal metadata from a host handle', () => {
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happy-zellij',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij-a',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };

    expect(buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual({
      mode: 'zellij',
      zellij: {
        sessionName: 'happy-zellij',
        paneId: 'terminal_7',
        socketDirV1: '/tmp/happier-zellij-a',
      },
    });
  });

  it('reconstructs the versioned zellij socket root while accepting legacy markers', () => {
    expect(buildTerminalHostHandleFromAttachmentMetadata({
      mode: 'zellij',
      zellij: {
        sessionName: 'happy-zellij',
        paneId: 'terminal_7',
        socketDirV1: '/tmp/happier-zellij-a',
      },
    })).toMatchObject({
      kind: 'zellij',
      sessionName: 'happy-zellij',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij-a',
    });

    const legacyHandle = buildTerminalHostHandleFromAttachmentMetadata({
      mode: 'zellij',
      zellij: {
        sessionName: 'legacy-zellij',
        paneId: 'terminal_8',
      },
    });
    expect(legacyHandle).toMatchObject({
      kind: 'zellij',
      sessionName: 'legacy-zellij',
      paneId: 'terminal_8',
    });
    expect(legacyHandle?.socketDir).toBeUndefined();
  });

  it('reconstructs a tmux handle with socketDir from persisted tmpDir', () => {
    const handle = buildTerminalHostHandleFromAttachmentMetadata({
      mode: 'tmux',
      tmux: {
        target: 'happy:unified-window',
        tmpDir: '/tmp/happier-tmux-root',
      },
    });
    expect(handle).toMatchObject({
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'unified-window',
      socketDir: '/tmp/happier-tmux-root',
    });
  });

  it('does not reconstruct a windows_console handle: persisted metadata carries no host identity', () => {
    // The canonical PTY handle is keyed by the spawn-time session name (also its paneId),
    // which windows_console terminal metadata does not persist. A fabricated identity would
    // probe a nonexistent host, so reconstruction must refuse and leave the mode on the
    // fail-closed legacy path.
    expect(buildTerminalHostHandleFromAttachmentMetadata({
      mode: 'windows_console',
      requested: 'console',
      windows: { host: 'console' },
    })).toBeNull();
  });

  it('builds non-focusable Windows console metadata from a PTY host handle', () => {
    const handle: TerminalHostHandle = {
      kind: 'windows_console',
      sessionName: 'happy-windows-pty',
      paneId: 'happy-windows-pty',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
        requiresLocalAttachmentInfo: false,
      },
    };

    expect(buildTerminalAttachmentMetadataFromHostHandle(handle)).toEqual({
      mode: 'windows_console',
      requested: 'console',
      windows: {
        host: 'console',
      },
    });
  });
});
