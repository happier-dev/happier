import { afterEach, describe, expect, it, vi } from 'vitest';
import * as tmp from 'tmp';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TerminalHostHandle } from '@happier-dev/agents';

const filesystemBoundary = vi.hoisted(() => ({
  beforeUnlink: undefined as undefined | ((path: string) => Promise<void>),
  afterRename: undefined as undefined | ((sourcePath: string, destinationPath: string) => Promise<void>),
  afterLinkAttempt: undefined as undefined | ((sourcePath: string, destinationPath: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: vi.fn(async (path: string) => {
      await filesystemBoundary.beforeUnlink?.(path);
      await actual.unlink(path);
    }),
    rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
      await actual.rename(sourcePath, destinationPath);
      await filesystemBoundary.afterRename?.(sourcePath, destinationPath);
    }),
    link: vi.fn(async (sourcePath: string, destinationPath: string) => {
      try {
        await actual.link(sourcePath, destinationPath);
      } finally {
        await filesystemBoundary.afterLinkAttempt?.(sourcePath, destinationPath);
      }
    }),
  };
});

import {
  readTerminalAttachmentInfo,
  readTerminalHostAttachmentInfo,
  readTerminalHostAttachmentState,
  disposeTerminalAttachmentInfoForSession,
  removeTerminalAttachmentInfo,
  removeTerminalHostAttachmentInfo,
  writeTerminalAttachmentInfo,
  writeTerminalHostAttachmentInfo,
} from './terminalAttachmentInfo';

describe('terminalAttachmentInfo', () => {
  afterEach(() => {
    filesystemBoundary.beforeUnlink = undefined;
    filesystemBoundary.afterRename = undefined;
    filesystemBoundary.afterLinkAttempt = undefined;
    vi.restoreAllMocks();
  });

  it('writes attachment info with private file permissions', async () => {
    if (process.platform === 'win32') return;
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_123',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:win-1', tmpDir: '/tmp/happy-tmux' },
        },
      });

      const sessionsDir = join(dir.name, 'terminal', 'sessions');
      const dirStat = await stat(sessionsDir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      const fileStat = await stat(join(sessionsDir, 'sess_123.json'));
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      dir.removeCallback();
    }
  });

  it('writes and reads per-session terminal attachment info', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_123',
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:win-1', tmpDir: '/tmp/happy-tmux' },
        },
      });

      const raw = await readFile(join(dir.name, 'terminal', 'sessions', 'sess_123.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessionId).toBe('sess_123');
      expect(parsed.terminal?.tmux?.target).toBe('happy:win-1');

      const info = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_123',
      });
      expect(info?.terminal.mode).toBe('tmux');
      expect(info?.terminal.tmux?.tmpDir).toBe('/tmp/happy-tmux');
    } finally {
      dir.removeCallback();
    }
  });

  it('stores the exact terminal-host handle separately from display attachment metadata', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const handle = {
      kind: 'zellij' as const,
      sessionName: 'happier-claude-session-1',
      paneId: 'terminal_7',
      socketDir: '/tmp/happier-zellij',
      expectedCommandFragments: ['claude'],
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        liveProbe: 'required' as const,
      },
    };
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        terminal: { mode: 'zellij', requested: 'zellij' },
      });
      await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        handle,
      });

      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
      })).resolves.toEqual({
        version: 2,
        attachmentId: expect.any(String),
        sessionId: 'session-1',
        handle: {
          ...handle,
          attachmentId: expect.any(String),
        },
        updatedAt: expect.any(Number),
      });
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
      })).resolves.toMatchObject({ terminal: { mode: 'zellij' } });
    } finally {
      dir.removeCallback();
    }
  });

  it('reads and retires a Remote Dev v2 descriptor from the predecessor metadata path', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-remote-v2';
    const sessionsDir = join(dir.name, 'terminal', 'sessions');
    const handle = {
      attachmentId: 'attachment-remote-v2' as NonNullable<TerminalHostHandle['attachmentId']>,
      kind: 'tmux' as const,
      sessionName: 'happy',
      paneId: 'remote-window',
      socketDir: '/tmp/remote-tmux',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'shared' as const,
        locality: 'same_machine' as const,
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required' as const,
      },
    };
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `${sessionId}.json`), JSON.stringify({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId,
        handle,
        terminal: {
          mode: 'tmux',
          tmux: { target: 'happy:remote-window', tmpDir: '/tmp/remote-tmux' },
        },
        updatedAt: 1,
      }), 'utf8');

      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
      })).resolves.toEqual({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId,
        handle,
        updatedAt: 1,
      });
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
      })).resolves.toMatchObject({
        version: 1,
        terminal: { mode: 'tmux' },
      });
      await expect(removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: handle.attachmentId,
        expectedHandle: handle,
      })).resolves.toBe(true);
      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
      })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('distinguishes absent, invalid, and I/O-failed host attachment evidence', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await expect(readTerminalHostAttachmentState({
        happyHomeDir: dir.name,
        sessionId: 'sess_absent',
      })).resolves.toEqual({ status: 'absent' });

      const sessionsDir = join(dir.name, 'terminal', 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, 'sess_invalid.host.json'), 'not-json', 'utf8');
      await expect(readTerminalHostAttachmentState({
        happyHomeDir: dir.name,
        sessionId: 'sess_invalid',
      })).resolves.toEqual({ status: 'unreadable', reason: 'invalid' });

      await mkdir(join(sessionsDir, 'sess_io.host.json'));
      await expect(readTerminalHostAttachmentState({
        happyHomeDir: dir.name,
        sessionId: 'sess_io',
      })).resolves.toEqual({ status: 'unreadable', reason: 'io_error' });
    } finally {
      dir.removeCallback();
    }
  });

  it('removes terminal-host attachment state only when the expected handle still owns it', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const firstHandle = {
      kind: 'tmux' as const,
      sessionName: 'happier-claude-session-1',
      paneId: 'pane-1',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        liveProbe: 'required' as const,
      },
    };
    const replacementHandle = { ...firstHandle, paneId: 'pane-2' };
    try {
      const replacementAttachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        handle: replacementHandle,
      });

      await expect(removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedHandle: firstHandle,
      })).resolves.toBe(false);
      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
      })).resolves.toMatchObject({ handle: replacementHandle });

      await expect(removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: replacementAttachment.attachmentId,
      })).resolves.toBe(true);
      await expect(removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
        expectedAttachmentId: replacementAttachment.attachmentId,
      })).resolves.toBe(false);
      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-1',
      })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('generic session cleanup removes display metadata but preserves the exact host descriptor', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-final-cleanup',
        terminal: { mode: 'tmux', tmux: { target: 'happier:1' } },
      });
      await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-final-cleanup',
        handle: {
          kind: 'tmux',
          sessionName: 'happier-session-final-cleanup',
          paneId: '1',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'exclusive',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
      });

      await disposeTerminalAttachmentInfoForSession({
        happyHomeDir: dir.name,
        sessionId: 'session-final-cleanup',
      });

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-final-cleanup',
      })).resolves.toBeNull();
      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'session-final-cleanup',
      })).resolves.toMatchObject({
        version: 2,
        sessionId: 'session-final-cleanup',
        handle: { sessionName: 'happier-session-final-cleanup' },
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('generic session cleanup preserves a Remote Dev v2 descriptor until host disposition owns retirement', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-remote-v2-cleanup';
    const sessionsDir = join(dir.name, 'terminal', 'sessions');
    const handle = {
      attachmentId: 'attachment-remote-v2-cleanup' as NonNullable<TerminalHostHandle['attachmentId']>,
      kind: 'tmux' as const,
      sessionName: 'happy',
      paneId: 'remote-window',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'shared' as const,
        locality: 'same_machine' as const,
        liveProbe: 'required' as const,
      },
    };
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `${sessionId}.json`), JSON.stringify({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId,
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happy:remote-window' } },
        updatedAt: 1,
      }), 'utf8');

      await disposeTerminalAttachmentInfoForSession({ happyHomeDir: dir.name, sessionId });

      await expect(readTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
      })).resolves.toMatchObject({
        version: 2,
        attachmentId: handle.attachmentId,
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('does not unlink replacement B when it is published after remover A observes its descriptor', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    let releaseUnlink: (() => void) | undefined;
    const sessionId = 'session-replacement-race';
    const descriptorPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.host.json`);
    const baseHandle = {
      kind: 'tmux' as const,
      sessionName: 'happier-session-replacement-race',
      attachMetadata: {
        attachStrategy: 'terminal_host' as const,
        topology: 'exclusive' as const,
        locality: 'same_machine' as const,
        liveProbe: 'required' as const,
      },
    };
    try {
      const attachmentA = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: {
          ...baseHandle,
          attachmentId: 'attachment-a' as NonNullable<TerminalHostHandle['attachmentId']>,
          paneId: 'pane-a',
        },
      });

      const unlinkMayProceed = new Promise<void>((resolve) => { releaseUnlink = resolve; });
      let removerObservedA!: () => void;
      const removerObservedAPromise = new Promise<void>((resolve) => { removerObservedA = resolve; });
      let replacementPublished!: () => void;
      const replacementPublishedPromise = new Promise<void>((resolve) => { replacementPublished = resolve; });
      let replacementWaitedForDescriptorLock!: () => void;
      const replacementWaitedForDescriptorLockPromise = new Promise<void>((resolve) => {
        replacementWaitedForDescriptorLock = resolve;
      });
      let removerReachedUnlink = false;
      filesystemBoundary.beforeUnlink = async (path) => {
        if (path !== descriptorPath) return;
        removerReachedUnlink = true;
        removerObservedA();
        await unlinkMayProceed;
      };
      filesystemBoundary.afterRename = async (sourcePath, destinationPath) => {
        if (destinationPath === descriptorPath && sourcePath.includes('.tmp-')) replacementPublished();
      };
      filesystemBoundary.afterLinkAttempt = async (_sourcePath, destinationPath) => {
        if (removerReachedUnlink && destinationPath === `${descriptorPath}.lock`) {
          replacementWaitedForDescriptorLock();
        }
      };

      const removeA = removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachmentA.attachmentId,
      });
      await removerObservedAPromise;
      const writeB = writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: {
          ...baseHandle,
          attachmentId: 'attachment-b' as NonNullable<TerminalHostHandle['attachmentId']>,
          paneId: 'pane-b',
        },
      });

      await Promise.race([
        replacementPublishedPromise,
        replacementWaitedForDescriptorLockPromise,
      ]);
      releaseUnlink?.();
      await expect(Promise.all([removeA, writeB])).resolves.toEqual([
        true,
        expect.objectContaining({ attachmentId: 'attachment-b' }),
      ]);
      await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId }))
        .resolves.toMatchObject({ attachmentId: 'attachment-b', handle: { paneId: 'pane-b' } });
    } finally {
      releaseUnlink?.();
      dir.removeCallback();
    }
  });

  it('preserves a readable descriptor when a Windows-style unlink refusal prevents exact removal', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    const sessionId = 'session-windows-unlink';
    const descriptorPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.host.json`);
    try {
      const attachment = await writeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        handle: {
          attachmentId: 'attachment-windows' as NonNullable<TerminalHostHandle['attachmentId']>,
          kind: 'windows_console',
          sessionName: 'windows-console-session',
          paneId: 'console-1',
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'exclusive',
            locality: 'same_machine',
            liveProbe: 'required',
          },
        },
      });
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      filesystemBoundary.beforeUnlink = async (path) => {
        if (path !== descriptorPath) return;
        throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
      };

      await expect(removeTerminalHostAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: attachment.attachmentId,
      })).rejects.toMatchObject({ code: 'EPERM' });
      await expect(readTerminalHostAttachmentInfo({ happyHomeDir: dir.name, sessionId }))
        .resolves.toMatchObject({ attachmentId: attachment.attachmentId });
      await expect(readFile(descriptorPath, 'utf8')).resolves.toContain('attachment-windows');
    } finally {
      dir.removeCallback();
    }
  });

  it('reads windows terminal attachment info', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_windows_1',
        terminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            windowId: 'happy-session-1',
            pid: 77,
          },
        },
      });

      const info = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_windows_1',
      });
      expect(info?.terminal.mode).toBe('windows_terminal');
      expect((info?.terminal as any)?.windows?.windowId).toBe('happy-session-1');
    } finally {
      dir.removeCallback();
    }
  });

  it('writes and reads zellij terminal attachment info', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_1',
        terminal: {
          mode: 'zellij',
          requested: 'zellij',
        } as any,
      });

      const info = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_1',
      });
      expect(info?.terminal.mode).toBe('zellij');
      expect(info?.terminal.requested).toBe('zellij');
    } finally {
      dir.removeCallback();
    }
  });

  it('stores sessionId using a filename-safe encoding to prevent path traversal', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = '../evil/session';
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal: {
          mode: 'plain',
        },
      });

      const encodedFileName = `${encodeURIComponent(sessionId)}.json`;
      const raw = await readFile(join(dir.name, 'terminal', 'sessions', encodedFileName), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.sessionId).toBe(sessionId);

      const info = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(info?.sessionId).toBe(sessionId);
    } finally {
      dir.removeCallback();
    }
  });

  it('returns null for malformed or unsupported attachment file content', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'sess_bad';
      await mkdir(join(dir.name, 'terminal', 'sessions'), { recursive: true });

      const encodedPath = join(dir.name, 'terminal', 'sessions', `${encodeURIComponent(sessionId)}.json`);
      await writeFile(encodedPath, 'not-json', 'utf8');
      expect(await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId })).toBeNull();

      await writeFile(
        encodedPath,
        JSON.stringify({
          version: 2,
          sessionId,
          terminal: { mode: 'tmux', tmux: { target: 'happy:win-1' } },
          updatedAt: Date.now(),
        }),
        'utf8',
      );
      expect(await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId })).toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('can still read legacy files created with the raw sessionId filename', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'tmux:legacy';
      await mkdir(join(dir.name, 'terminal', 'sessions'), { recursive: true });
      const legacyPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.json`);
      await writeFile(legacyPath, JSON.stringify({
        version: 1,
        sessionId,
        terminal: { mode: 'tmux', tmux: { target: 'happy:win-1', tmpDir: '/tmp/happy-tmux' } },
        updatedAt: Date.now(),
      }, null, 2), 'utf8');

      const info = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(info?.terminal.mode).toBe('tmux');
      expect(info?.terminal.tmux?.target).toBe('happy:win-1');
    } finally {
      dir.removeCallback();
    }
  });

  it('does not read legacy files when sessionId contains path separators', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = '../../pwned';
      await mkdir(join(dir.name, 'terminal', 'sessions'), { recursive: true });

      // If the legacy path fallback were used for this sessionId, it would resolve outside the sessions dir.
      // Ensure we don't read it even if such a file exists.
      const traversedPath = join(dir.name, 'terminal', 'sessions', `${sessionId}.json`);
      await writeFile(traversedPath, JSON.stringify({
        version: 1,
        sessionId,
        terminal: { mode: 'plain', plain: { command: 'echo hi', cwd: '/tmp' } },
        updatedAt: Date.now(),
      }, null, 2), 'utf8');

      const info = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(info).toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('removes terminal metadata only when the persisted snapshot is unchanged', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'sess-terminal-metadata-cas';
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal: { mode: 'tmux', tmux: { target: 'happy:old-window' } },
      });
      const old = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(old).not.toBeNull();

      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal: { mode: 'tmux', tmux: { target: 'happy:new-window' } },
      });
      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expected: old!,
      })).resolves.toBe(false);

      const current = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(current?.terminal.tmux?.target).toBe('happy:new-window');
      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expected: current!,
      })).resolves.toBe(true);
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });
});
