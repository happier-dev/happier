import { describe, expect, it } from 'vitest';
import * as tmp from 'tmp';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readTerminalAttachmentInfo, writeTerminalAttachmentInfo } from './terminalAttachmentInfo';

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
});
