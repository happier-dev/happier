import { describe, expect, it, vi } from 'vitest';

import { createCodexTerminationHandler } from './terminationHandler.js';

describe('createCodexTerminationHandler', () => {
  it('archives terminal-started sessions before cleanup when the termination outcome requests it', async () => {
    const sequence: string[] = [];
    const archiveSession = vi.fn(async (reason: string | null) => {
      sequence.push(`archive:${reason ?? 'none'}`);
    });

    const handleTerminate = createCodexTerminationHandler({
      startedBy: 'terminal',
      setShouldExit: (value) => {
        sequence.push(`exit:${value}`);
      },
      handleAbort: async () => {
        sequence.push('abort');
      },
      archiveSession,
      cleanupRunResources: async () => {
        sequence.push('cleanup');
      },
      stopCaffeinate: () => {
        sequence.push('stop');
      },
      logDebug: vi.fn(),
    });

    await handleTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      { exitCode: 0, archive: true, archiveReason: 'Signal SIGTERM' },
    );

    expect(sequence).toEqual(['exit:true', 'abort', 'archive:Signal SIGTERM', 'cleanup', 'stop']);
    expect(archiveSession).toHaveBeenCalledWith('Signal SIGTERM');
  });

  it('skips archive for daemon-started sessions', async () => {
    const archiveSession = vi.fn(async () => {});

    const handleTerminate = createCodexTerminationHandler({
      startedBy: 'daemon',
      setShouldExit: vi.fn(),
      handleAbort: vi.fn(async () => {}),
      archiveSession,
      cleanupRunResources: vi.fn(async () => {}),
      stopCaffeinate: vi.fn(),
      logDebug: vi.fn(),
    });

    await handleTerminate(
      { kind: 'signal', signal: 'SIGTERM' },
      { exitCode: 0, archive: true, archiveReason: 'Signal SIGTERM' },
    );

    expect(archiveSession).not.toHaveBeenCalled();
  });
});

