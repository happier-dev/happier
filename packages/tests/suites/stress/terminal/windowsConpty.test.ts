import { describe, expect, it } from 'vitest';

import { createTerminalPtySessionManager } from '../../../../../apps/cli/src/terminal/pty/sessions';
import type {
  Disposable,
  PtyProcess,
  PtyProvider,
  PtySpawnParams,
} from '../../../../../apps/cli/src/terminal/pty/provider';

function disposable(): Disposable {
  return { dispose: () => {} };
}

function createWindowsPtyProvider(): PtyProvider {
  return {
    spawn(_params: PtySpawnParams): PtyProcess {
      return {
        pid: 4321,
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => disposable(),
        onExit: () => disposable(),
      };
    },
  };
}

describe('stress: terminal Windows/ConPTY fallback diagnostics', () => {
  it('keeps the canonical daemon stream legacy-only when Windows raw byte fidelity is unavailable', () => {
    const manager = createTerminalPtySessionManager({
      ptyProvider: createWindowsPtyProvider(),
      config: {
        maxSessions: 1,
        idleTimeoutMs: 60_000,
        bufferMaxBytes: 64 * 1024,
        bufferMaxEvents: 32,
        bufferRetentionMs: 60_000,
        urlParseBufferLimit: 8 * 1024,
        maxWriteChunkBytes: 64 * 1024,
        defaultCols: 80,
        defaultRows: 24,
      },
      env: { SHELL: 'powershell.exe' },
      platform: 'win32',
    });

    try {
      const ensured = manager.ensure({ terminalKey: 'windows-terminal', cwd: 'C:\\workspace' });
      expect(ensured.ok).toBe(true);
      if (!ensured.ok) throw new Error('expected Windows terminal');

      expect(manager.readByteStream({
        terminalId: ensured.terminalId,
        byteOffset: 0,
        creditBytes: 0,
      })).toEqual({
        ok: true,
        terminalId: ensured.terminalId,
        frames: [{
          t: 'legacyOnly',
          terminalId: ensured.terminalId,
          provider: 'windows-conpty',
          reason: 'Windows ConPTY raw byte fidelity has not been proven',
        }],
        nextByteOffset: 0,
        availableByteOffset: 0,
        droppedBeforeByteOffset: 0,
        done: false,
      });
    } finally {
      manager.dispose();
    }
  });
});
