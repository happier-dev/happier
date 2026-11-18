import { describe, expect, it } from 'vitest';

import type { TerminalHostHandle } from '@happier-dev/agents';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { readTerminalHostAttachmentInfo, writeTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import {
  buildActiveTerminalHostHandleFromMetadata,
  buildTerminalHostProbeHandleFromMetadata,
  buildTerminalMetadataFromHostHandle,
  buildTerminalMetadataFromRuntimeFlags,
  resolveExistingTerminalHostLifecycle,
} from './terminalMetadata';

describe('buildTerminalMetadataFromRuntimeFlags', () => {
  it('publishes the stable terminal identity inherited by a wrapper launched inside Herdr', () => {
    expect(buildTerminalMetadataFromRuntimeFlags({
      mode: 'herdr',
      requested: 'herdr',
      herdrSessionName: 'work',
      herdrSocketPath: '/tmp/work.sock',
      herdrTerminalId: 'term_42',
      herdrPaneId: 'w1:p2',
    })).toEqual({
      mode: 'herdr',
      requested: 'herdr',
      herdr: {
        sessionName: 'work',
        socketPath: '/tmp/work.sock',
        terminalId: 'term_42',
        paneId: 'w1:p2',
      },
    });
  });

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

describe('buildActiveTerminalHostHandleFromMetadata', () => {
  it('reconstructs exact Herdr and Zellij identities for current-pane reuse', () => {
    expect(buildActiveTerminalHostHandleFromMetadata({
      mode: 'herdr',
      herdr: {
        sessionName: 'work',
        socketPath: '/tmp/work.sock',
        terminalId: 'term_7',
        paneId: 'w1:p3',
      },
    })).toEqual(expect.objectContaining({
      kind: 'herdr', sessionName: 'work', socketPath: '/tmp/work.sock',
      terminalId: 'term_7', paneId: 'w1:p3',
    }));
    expect(buildActiveTerminalHostHandleFromMetadata({
      mode: 'zellij',
      zellij: { sessionName: 'work', paneId: '11', socketDirV1: '/tmp/zellij' },
    })).toEqual(expect.objectContaining({
      kind: 'zellij', sessionName: 'work', paneId: '11', socketDir: '/tmp/zellij',
    }));
  });

  it('rejects terminal metadata without an exact controllable identity', () => {
    expect(buildActiveTerminalHostHandleFromMetadata({ mode: 'herdr' })).toBeNull();
    expect(buildActiveTerminalHostHandleFromMetadata({ mode: 'zellij' })).toBeNull();
    expect(buildActiveTerminalHostHandleFromMetadata({ mode: 'plain' })).toBeNull();
  });

  it('does not reuse a retired borrowed identity retained in session metadata', () => {
    expect(buildActiveTerminalHostHandleFromMetadata({
      mode: 'herdr',
      herdr: { sessionName: 'work', socketPath: '/tmp/work.sock', terminalId: 'term_retired' },
      controlServiceabilityV1: { v: 1, attachmentId: 'retired-attachment', state: 'unknown', observedAt: 2, retired: true },
    })).toBeNull();
  });
});

describe('resolveExistingTerminalHostLifecycle', () => {
  const herdr = {
    mode: 'herdr' as const,
    herdr: { sessionName: 'work', socketPath: '/tmp/work.sock', terminalId: 'term_7' },
  };

  it('distinguishes daemon-owned hosts from terminal-borrowed hosts through the canonical metadata rule', () => {
    expect(resolveExistingTerminalHostLifecycle({ terminal: herdr, startedBy: 'daemon' })).toBe('owned');
    expect(resolveExistingTerminalHostLifecycle({ terminal: herdr })).toBe('borrowed');
    expect(resolveExistingTerminalHostLifecycle({ terminal: { mode: 'plain' } })).toBeNull();
  });

  it('keeps a CLI-created tmux attachment owned when its published metadata is reused', async () => {
    const happyHomeDir = await createTempDir('terminal-host-lifecycle-');
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir, sessionId: 'cli-tmux', lifecycle: 'owned',
        handle: {
          kind: 'tmux', sessionName: 'cli-owned', paneId: 'pane-1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
      });
      const terminal = buildTerminalMetadataFromHostHandle(attachment.handle);
      expect(resolveExistingTerminalHostLifecycle({ terminal, startedBy: 'terminal' })).toBe('owned');
      expect(await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId: 'cli-tmux' })).toMatchObject({ version: 2 });
    } finally {
      await removeTempDir(happyHomeDir);
    }
  });

  it.each(['owned', 'borrowed'] as const)('uses persisted exact %s lifecycle rather than the later launch source', async (lifecycle) => {
    const happyHomeDir = await createTempDir('terminal-host-exact-lifecycle-');
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir, sessionId: 'herdr-exact', lifecycle,
        handle: {
          kind: 'herdr', ...herdr.herdr,
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' },
        },
      });
      const terminal = buildTerminalMetadataFromHostHandle(attachment.handle);
      const current = await readTerminalHostAttachmentInfo({ happyHomeDir, sessionId: 'herdr-exact' });
      expect(resolveExistingTerminalHostLifecycle({
        terminal, startedBy: lifecycle === 'owned' ? 'terminal' : 'daemon',
      }, current)).toBe(lifecycle);
    } finally {
      await removeTempDir(happyHomeDir);
    }
  });
});

describe('buildTerminalMetadataFromHostHandle', () => {
  it('projects the stable Herdr terminal identity without treating it as Zellij', () => {
    expect(buildTerminalMetadataFromHostHandle({
      kind: 'herdr',
      sessionName: 'default',
      paneId: 'w1:p7',
      socketPath: '/tmp/herdr.sock',
      terminalId: 'term_1',
      attachMetadata: {
        attachStrategy: 'terminal_host', topology: 'shared',
        locality: 'same_machine', liveProbe: 'required',
      },
    })).toEqual({
      mode: 'herdr',
      herdr: {
        sessionName: 'default',
        paneId: 'w1:p7',
        socketPath: '/tmp/herdr.sock',
        terminalId: 'term_1',
      },
    });
  });

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
      controlServiceabilityV1: { v: 1, attachmentId: 'attachment-native-terminal', state: 'servable', observedAt: expect.any(Number) },
    });
  });

  it('retains the Zellij session and pane identity while not manufacturing Windows identity', () => {
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
      paneId: '9',
      attachMetadata,
    })).toEqual({ mode: 'zellij', zellij: { sessionName: 'native-zellij', paneId: '9' } });
    // The PTY terminal host (its selector kind stays `windows_console`) on every OS: the Agent
    // runs in its Session holder's terminal, attached by Session id.
    expect(buildTerminalMetadataFromHostHandle({
      kind: 'pty',
      sessionName: 'native-console',
      paneId: 'window-7',
      attachMetadata,
    })).toEqual({ mode: 'pty', pty: { host: 'holder' } });
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
    expect(buildTerminalHostProbeHandleFromMetadata({ mode: 'pty', pty: { host: 'holder' } })).toBeNull();
  });
});
