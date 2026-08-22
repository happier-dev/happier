import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { renameSyncMock } = vi.hoisted(() => ({
  renameSyncMock: vi.fn<typeof import('node:fs').renameSync>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: renameSyncMock };
});

import { writeJsonAtomicSync } from './writeJsonAtomicSync';

describe('writeJsonAtomicSync Windows publication retry', () => {
  afterEach(() => renameSyncMock.mockReset());

  it('survives a transient destination lock longer than two rename retries without deleting prior state', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'happier-writeJsonAtomicSync-win-retry-'));
    const path = join(dir, 'daemon.state.json');
    writeFileSync(path, '{"state":"old"}\n', 'utf8');
    let attempts = 0;
    renameSyncMock.mockImplementation((source, destination) => {
      attempts += 1;
      if (attempts <= 4) {
        const error = new Error('EPERM: destination is temporarily locked') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      actual.renameSync(source, destination);
    });

    writeJsonAtomicSync(path, { state: 'new' });

    expect(attempts).toBe(5);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ state: 'new' });
  });
});
