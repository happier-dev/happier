import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    join: actual.join,
    resolve: actual.resolve,
    relative: () => 'D:\\outside\\escape.json',
    sep: actual.sep,
    posix: actual.posix,
    win32: actual.win32,
  };
});

describe('sessionHandoffSourceExportStore path safety', () => {
  it('fails closed when a persisted path resolves outside the active server dir', async () => {
    const activeServerDir = await mkdtemp(`${os.tmpdir()}/happier-session-handoff-store-path-safety-`);
    try {
      const { createSessionHandoffSourceExportStore } = await import('./sessionHandoffSourceExportStore');
      const store = createSessionHandoffSourceExportStore({ activeServerDir });

      await expect(store.save({
        handoffId: 'handoff-path-safety-1',
        exportedAtMs: 1,
        agentBundle: {
          transferId: 'session-handoff:handoff-path-safety-1:provider-bundle-file',
          filePath: `${activeServerDir}/provider-bundle.json`,
          sizeBytes: 1,
          manifestHash: `sha256:${'a'.repeat(64)}`,
        },
      })).rejects.toThrow(/Invalid handoff file path/);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
