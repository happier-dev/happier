import { describe, expect, it } from 'vitest';
import * as tmp from 'tmp';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  readTerminalAttachmentInfo,
  readTerminalAttachmentState,
  removeTerminalAttachmentInfo,
  writeTerminalAttachmentInfo,
} from './terminalAttachmentInfo';

describe('terminalAttachmentInfo', () => {
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

  it('removes attachment info only when the expected terminal still matches', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const originalTerminal = {
        mode: 'zellij',
        requested: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-old',
          paneId: 'terminal_1',
        },
      } as const;
      const replacementTerminal = {
        mode: 'zellij',
        requested: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-new',
          paneId: 'terminal_2',
        },
      } as const;
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_remove',
        attachmentId: 'attachment-original',
        handle: {
          kind: 'zellij',
          sessionName: 'happier-claude-unified-old',
          paneId: 'terminal_1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        terminal: originalTerminal as Parameters<typeof writeTerminalAttachmentInfo>[0]['terminal'],
      });

      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_remove',
        expectedAttachmentId: 'attachment-replacement',
        expectedTerminal: replacementTerminal as Parameters<typeof removeTerminalAttachmentInfo>[0]['expectedTerminal'],
      })).resolves.toBe(false);
      expect((await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_remove',
      }))?.terminal).toEqual(originalTerminal);

      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_remove',
        expectedAttachmentId: 'attachment-original',
        expectedTerminal: originalTerminal as Parameters<typeof removeTerminalAttachmentInfo>[0]['expectedTerminal'],
      })).resolves.toBe(true);
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_remove',
      })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('persists one opaque attachment id with the full bound host handle', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const handle = {
        kind: 'zellij',
        sessionName: 'happier-claude-unified-zellij',
        paneId: 'terminal_7',
        socketDir: '/tmp/happier-zellij-a',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      } as const;

      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_identity',
        attachmentId: 'attachment-seed-1',
        handle,
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: handle.sessionName,
            paneId: handle.paneId,
            socketDirV1: handle.socketDir,
          },
        },
      });

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_identity',
      })).resolves.toMatchObject({
        version: 2,
        attachmentId: 'attachment-seed-1',
        handle,
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('uses expected attachment id CAS so stale release cannot delete a replacement', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const handle = {
        kind: 'tmux',
        sessionName: 'happy',
        paneId: 'replacement-window',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      } as const;
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_stale_release',
        attachmentId: 'attachment-new',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happy:replacement-window' } },
      });

      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_stale_release',
        expectedAttachmentId: 'attachment-old',
      })).resolves.toBe(false);
      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_stale_release',
      })).resolves.toMatchObject({ attachmentId: 'attachment-new' });

      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_stale_release',
        expectedAttachmentId: 'attachment-new',
      })).resolves.toBe(true);
    } finally {
      dir.removeCallback();
    }
  });

  it('rejects a bound attachment whose persisted terminal root disagrees with its full handle', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await expect(writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_root_mismatch',
        attachmentId: 'attachment-root-1',
        handle: {
          kind: 'zellij',
          sessionName: 'owned-session',
          paneId: 'terminal_3',
          socketDir: '/tmp/owned-root',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' },
        },
        terminal: {
          mode: 'zellij',
          zellij: {
            sessionName: 'replacement-session',
            paneId: 'terminal_3',
            socketDirV1: '/tmp/owned-root',
          },
        },
      })).rejects.toThrow(/root.*handle/i);

      await expect(readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_root_mismatch',
      })).resolves.toBeNull();
    } finally {
      dir.removeCallback();
    }
  });

  it('parks legacy v1 attachment removal even when its terminal metadata matches', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'sess_legacy_no_identity';
      const terminal = { mode: 'tmux', tmux: { target: 'happy:legacy-window' } } as const;
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal,
      });

      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expectedAttachmentId: 'attachment-guessed',
        expectedTerminal: terminal,
      })).resolves.toBe(false);
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toMatchObject({
        version: 1,
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('removes an unchanged legacy v1 attachment only with its exact persisted snapshot', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'sess_legacy_confirmed_dead';
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal: { mode: 'tmux', tmux: { target: 'happy:dead-window', tmpDir: '/tmp/happy-tmux' } },
      });
      const legacy = await readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId });
      expect(legacy).toMatchObject({ version: 1, sessionId });
      if (!legacy || legacy.version !== 1) throw new Error('Expected a legacy attachment fixture');

      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        terminal: { mode: 'tmux', tmux: { target: 'happy:replacement-window', tmpDir: '/tmp/happy-tmux' } },
      });

      await expect(removeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        expectedLegacyAttachment: legacy,
      })).resolves.toBe(false);
      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toMatchObject({
        version: 1,
        terminal: { tmux: { target: 'happy:replacement-window' } },
      });
    } finally {
      dir.removeCallback();
    }
  });

  it('does not let a late metadata-only writer downgrade a bound v2 attachment', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      const sessionId = 'sess_bound_not_downgraded';
      const handle = {
        kind: 'tmux',
        sessionName: 'happy',
        paneId: 'owned-window',
        socketDir: '/tmp/happy-tmux',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      } as const;
      const terminal = {
        mode: 'tmux',
        tmux: { target: 'happy:owned-window', tmpDir: '/tmp/happy-tmux' },
      } as const;
      await writeTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId,
        attachmentId: 'attachment-current',
        handle,
        terminal,
      });

      await writeTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId, terminal });

      await expect(readTerminalAttachmentInfo({ happyHomeDir: dir.name, sessionId })).resolves.toMatchObject({
        version: 2,
        attachmentId: 'attachment-current',
        handle,
      });
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
          zellij: {
            sessionName: 'happier-claude-unified-zellij',
            paneId: 'terminal_7',
          },
        } as unknown as Parameters<typeof writeTerminalAttachmentInfo>[0]['terminal'],
      });

      const info = await readTerminalAttachmentInfo({
        happyHomeDir: dir.name,
        sessionId: 'sess_zellij_1',
      });
      expect(info?.terminal.mode).toBe('zellij');
      expect((info?.terminal as { zellij?: { sessionName?: string; paneId?: string } })?.zellij?.sessionName).toBe(
        'happier-claude-unified-zellij',
      );
      expect((info?.terminal as { zellij?: { paneId?: string } })?.zellij?.paneId).toBe('terminal_7');
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

  it('distinguishes absent, invalid, and I/O-failed attachment evidence', async () => {
    const dir = tmp.dirSync({ unsafeCleanup: true });
    try {
      await expect(readTerminalAttachmentState({
        happyHomeDir: dir.name,
        sessionId: 'sess_absent',
      })).resolves.toEqual({ status: 'absent' });

      const sessionsDir = join(dir.name, 'terminal', 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, 'sess_invalid.json'), 'not-json', 'utf8');
      await expect(readTerminalAttachmentState({
        happyHomeDir: dir.name,
        sessionId: 'sess_invalid',
      })).resolves.toEqual({ status: 'unreadable', reason: 'invalid' });

      await mkdir(join(sessionsDir, 'sess_io.json'));
      await expect(readTerminalAttachmentState({
        happyHomeDir: dir.name,
        sessionId: 'sess_io',
      })).resolves.toEqual({ status: 'unreadable', reason: 'io_error' });
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
});
