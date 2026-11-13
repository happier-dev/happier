import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const { spawnMock, execFileMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execFileMock: vi.fn() }));
// Archive preparation stays real; observe only the native process boundary.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: spawnMock, execFile: execFileMock,
}));

import { createScpReadyPayloadArchive } from './createScpReadyPayloadArchive';

describe('remote payload archive preparation', () => {
  it('creates and cleans the archive without spawning a background process', async () => {
    const payload = await mkdtemp(join(tmpdir(), 'happier-archive-console-'));
    await writeFile(join(payload, 'happier.exe'), 'fixture');
    try {
      const result = await createScpReadyPayloadArchive(payload);
      const archive = join(result.archiveStageRoot, result.archiveFileName);
      try {
        expect(spawnMock).not.toHaveBeenCalled();
        expect(execFileMock).not.toHaveBeenCalled();
        expect((await stat(archive)).size).toBeGreaterThan(0);
      } finally {
        await result.cleanup();
      }
      await expect(stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(payload, { recursive: true, force: true });
    }
  });
});
