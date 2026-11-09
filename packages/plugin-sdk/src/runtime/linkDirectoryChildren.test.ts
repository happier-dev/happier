import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { linkDirectoryChildren } from './linkDirectoryChildren.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('linkDirectoryChildren', () => {
  it.each(['win32', 'darwin'] as const)('keeps private entries isolated across native name casing on %s', async platform => {
    const root = await mkdtemp(join(tmpdir(), 'happier-link-private-case-'));
    roots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'private');
    await mkdir(join(source, 'Agent'), { recursive: true });
    await writeFile(join(source, 'Agent', 'auth.json'), 'unmanaged-account-A');
    const platformProperty = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      // The platform is the OS boundary; real filesystem links and private writes remain exercised.
      Object.defineProperty(process, 'platform', { value: platform });
      await linkDirectoryChildren({ source, destination, exclude: ['agent'] });
    } finally {
      Object.defineProperty(process, 'platform', platformProperty);
    }
    expect(await readdir(destination)).toEqual([]);
    await mkdir(join(destination, 'agent'));
    await writeFile(join(destination, 'agent', 'auth.json'), 'selected-account-B');
    expect(await readFile(join(destination, 'agent', 'auth.json'), 'utf8')).toBe('selected-account-B');
    expect(await readFile(join(source, 'Agent', 'auth.json'), 'utf8')).toBe('unmanaged-account-A');
  });

  it('preserves existing destination entries, skips exclusions, and supports repeated linking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-link-children-'));
    roots.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'private');
    await mkdir(source);
    await mkdir(destination);
    for (const name of ['existing-file', 'existing-dir', 'dangling', 'excluded', 'new-file']) await writeFile(join(source, name), `source ${name}`);
    await writeFile(join(destination, 'existing-file'), 'private file');
    await mkdir(join(destination, 'existing-dir'));
    await writeFile(join(destination, 'existing-dir', 'local'), 'private child');
    await symlink(join(root, 'missing'), join(destination, 'dangling'));
    await mkdir(join(source, 'new-dir'));
    await writeFile(join(source, 'new-dir', 'child'), 'source child');

    await linkDirectoryChildren({ source, destination, exclude: ['excluded'] });
    await linkDirectoryChildren({ source, destination, exclude: ['excluded'] });

    expect(await readFile(join(destination, 'existing-file'), 'utf8')).toBe('private file');
    expect(await readFile(join(destination, 'existing-dir', 'local'), 'utf8')).toBe('private child');
    expect((await lstat(join(destination, 'dangling'))).isSymbolicLink()).toBe(true);
    expect(await readdir(destination)).not.toContain('excluded');
    expect((await lstat(join(destination, 'new-file'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(destination, 'new-file'), 'utf8')).toBe('source new-file');
    expect(await readFile(join(destination, 'new-dir', 'child'), 'utf8')).toBe('source child');
    expect(await readFile(join(source, 'existing-file'), 'utf8')).toBe('source existing-file');
  });

  it('creates a real empty destination when the source directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-link-children-'));
    roots.push(root);
    const destination = join(root, 'private');
    await linkDirectoryChildren({ source: join(root, 'absent'), destination });
    expect((await lstat(destination)).isDirectory()).toBe(true);
    expect(await readdir(destination)).toEqual([]);
  });
});
