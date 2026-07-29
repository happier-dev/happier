import {
  mkdtemp,
  readFile,
  readdir,
  rename as renameMock,
  unlink as unlinkMock,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

import { writeJsonAtomic } from './writeJsonAtomic';

describe('writeJsonAtomic (windows overwrite)', () => {
  let setPlatform: (platform: NodeJS.Platform) => void;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(renameMock).mockReset().mockImplementation(actual.rename);
    vi.mocked(unlinkMock).mockReset().mockImplementation(actual.unlink);
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setPlatform = (platform) => platformSpy.mockReturnValue(platform);
  });

  afterEach(() => vi.restoreAllMocks());

  it('overwrites existing file when rename fails with EPERM once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-'));
    const path = join(dir, 'auth.json');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let renameAttempts = 0;

    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error('EPERM') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actual.rename(from, to);
    });

    await writeFile(path, '{"a":1}', 'utf8');
    await writeJsonAtomic(path, { a: 2, b: 'x' });

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ a: 2, b: 'x' });
    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });

  it('overwrites existing file when a Windows sharing violation reports EBUSY once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-busy-'));
    const path = join(dir, 'state.json');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let renameAttempts = 0;

    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      renameAttempts += 1;
      if (renameAttempts === 1) {
        const error = new Error('EBUSY') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      await actual.rename(from, to);
    });

    await writeFile(path, '{"generation":"durable-old"}', 'utf8');
    await writeJsonAtomic(path, { generation: 'new' });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 'new' });
    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });

  it('replaces an existing file when Windows rejects rename only while the destination exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-destination-exists-'));
    const path = join(dir, 'state.json');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let destinationExistsFailures = 0;

    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      if (String(to) === path) {
        const destinationExists = await actual.stat(path).then(
          () => true,
          () => false,
        );
        if (destinationExists) {
          destinationExistsFailures += 1;
          const error = new Error('EEXIST') as NodeJS.ErrnoException;
          error.code = 'EEXIST';
          throw error;
        }
      }
      await actual.rename(from, to);
    });

    await writeFile(path, '{"generation":"durable-old"}', 'utf8');
    await writeJsonAtomic(path, { generation: 'new' });

    expect(destinationExistsFailures).toBe(5);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 'new' });
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });

  it('restores the prior file when publication fails after moving it aside', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-restore-'));
    const path = join(dir, 'state.json');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const publicationFailure = new Error('EIO publishing replacement') as NodeJS.ErrnoException;
    publicationFailure.code = 'EIO';
    let priorFileWasMovedAside = false;

    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      const sourcePath = String(from);
      const destinationPath = String(to);
      if (destinationPath === path && !priorFileWasMovedAside) {
        const error = new Error('EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      if (sourcePath === path) {
        priorFileWasMovedAside = true;
        await actual.rename(from, to);
        return;
      }
      if (destinationPath === path
        && priorFileWasMovedAside
        && sourcePath.includes('.tmp-')
        && !sourcePath.endsWith('.previous')) {
        throw publicationFailure;
      }
      await actual.rename(from, to);
    });

    await writeFile(path, '{"generation":"durable-old"}', 'utf8');

    await expect(writeJsonAtomic(path, { generation: 'new' })).rejects.toBe(publicationFailure);

    expect(priorFileWasMovedAside).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 'durable-old' });
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });

  it('exhausts the bounded retry budget on persistent EBUSY without losing old state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-busy-fail-'));
    const path = join(dir, 'state.json');

    vi.mocked(renameMock).mockImplementation(async () => {
      const error = new Error('EBUSY') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      throw error;
    });

    await writeFile(path, '{"generation":"durable-old"}', 'utf8');

    await expect(writeJsonAtomic(path, { generation: 'new' })).rejects.toMatchObject({ code: 'EBUSY' });

    expect(renameMock).toHaveBeenCalledTimes(5);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 'durable-old' });
    expect(await readdir(dir)).toEqual(['state.json']);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });

  it('retries each repeated replacement without ever unlinking the destination', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-win-repeat-'));
    const path = join(dir, 'state.json');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const failedTempPaths = new Set<string>();

    vi.mocked(renameMock).mockImplementation(async (from, to) => {
      const sourcePath = String(from);
      if (!failedTempPaths.has(sourcePath)) {
        failedTempPaths.add(sourcePath);
        const error = new Error('EPERM') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actual.rename(from, to);
    });

    await writeFile(path, '{"generation":0}', 'utf8');
    await writeJsonAtomic(path, { generation: 1 });
    await writeJsonAtomic(path, { generation: 2 });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 2 });
    expect(renameMock).toHaveBeenCalledTimes(4);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });

  it.each(['EBUSY', 'EPERM'] as const)('does not retry %s replacement failures on other platforms', async (code) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-non-win-'));
    const path = join(dir, 'state.json');
    setPlatform('darwin');

    vi.mocked(renameMock).mockImplementation(async () => {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    });

    await writeFile(path, '{"generation":"durable-old"}', 'utf8');

    await expect(writeJsonAtomic(path, { generation: 'new' })).rejects.toMatchObject({ code });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 'durable-old' });
    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).not.toHaveBeenCalledWith(path);
  });
});
