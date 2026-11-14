import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import {
  parseFastlistOutput,
  resolveWindowsFastlistPath,
  withWindowsFastlistFallback,
} from '../../../../scripts/process_tree.cjs';

// Inside the Bun-compiled Windows CLI, ps-list resolves fastlist.exe under Bun's virtual
// filesystem (B:/~BUN/root/vendor/...), which cannot be executed, so ps-list always rejects.
const BUN_VIRTUAL_FS_ENOENT = Object.assign(new Error('spawn B:\\~BUN\\root\\vendor\\fastlist-0.3.0-x64.exe ENOENT'), {
  code: 'ENOENT',
});

describe('process_tree Windows fastlist fallback', () => {
  it('parses fastlist output the same way ps-list does', () => {
    expect(parseFastlistOutput('0\t0\t[System Process]\r\n4\t0\tSystem\r\n5740\t20932\thappier.exe\r\n')).toEqual([
      { pid: 0, ppid: 0, name: '[System Process]' },
      { pid: 4, ppid: 0, name: 'System' },
      { pid: 5740, ppid: 20932, name: 'happier.exe' },
    ]);
  });

  it('prefers the on-disk fastlist shipped next to the executable', () => {
    const execPath = join('C:', 'Users', 'me', '.happier', 'cli', 'versions', '0.2.17', 'happier.exe');
    const expected = join('C:', 'Users', 'me', '.happier', 'cli', 'versions', '0.2.17', 'node_modules', 'ps-list', 'vendor', 'fastlist-0.3.0-x64.exe');
    expect(resolveWindowsFastlistPath({
      execPath,
      arch: 'x64',
      existsSync: (candidate) => candidate === expected,
      resolvePsListEntry: () => 'B:/~BUN/root/node_modules/ps-list/index.js',
    })).toBe(expected);
  });

  it('falls back to the resolvable ps-list package when it is on disk', () => {
    const psListEntry = join('/repo', 'node_modules', 'ps-list', 'index.js');
    const expected = join('/repo', 'node_modules', 'ps-list', 'vendor', 'fastlist-0.3.0-x86.exe');
    expect(resolveWindowsFastlistPath({
      execPath: join('/runtime', 'node.exe'),
      arch: 'ia32',
      existsSync: (candidate) => candidate === expected,
      resolvePsListEntry: () => psListEntry,
    })).toBe(expected);
  });

  it('returns null for unsupported architectures or when no copy exists on disk', () => {
    expect(resolveWindowsFastlistPath({ arch: 'arm64', existsSync: () => true })).toBeNull();
    expect(resolveWindowsFastlistPath({ arch: 'x64', existsSync: () => false, resolvePsListEntry: () => '/x/index.js' })).toBeNull();
  });

  it('uses ps-list when it works, without touching fastlist', async () => {
    const listWithFastlist = vi.fn();
    const enumerate = withWindowsFastlistFallback(async () => [{ pid: 2, ppid: 1 }], {
      platform: 'win32',
      resolveFastlistPath: () => 'C:\\payload\\node_modules\\ps-list\\vendor\\fastlist-0.3.0-x64.exe',
      listWithFastlist,
    });
    await expect(enumerate()).resolves.toEqual([{ pid: 2, ppid: 1 }]);
    expect(listWithFastlist).not.toHaveBeenCalled();
  });

  it('recovers process discovery on Windows when ps-list cannot run its vendored fastlist', async () => {
    const fastlistPath = 'C:\\payload\\node_modules\\ps-list\\vendor\\fastlist-0.3.0-x64.exe';
    const listWithFastlist = vi.fn(async () => [{ pid: 9, ppid: 5740, name: 'claude.exe' }]);
    const enumerate = withWindowsFastlistFallback(async () => { throw BUN_VIRTUAL_FS_ENOENT; }, {
      platform: 'win32',
      resolveFastlistPath: () => fastlistPath,
      listWithFastlist,
    });
    await expect(enumerate()).resolves.toEqual([{ pid: 9, ppid: 5740, name: 'claude.exe' }]);
    expect(listWithFastlist).toHaveBeenCalledWith(fastlistPath);
  });

  it('keeps the original failure off Windows or when no on-disk fastlist exists', async () => {
    const failing = async () => { throw BUN_VIRTUAL_FS_ENOENT; };
    await expect(withWindowsFastlistFallback(failing, { platform: 'linux', resolveFastlistPath: () => 'x' })()).rejects.toBe(BUN_VIRTUAL_FS_ENOENT);
    await expect(withWindowsFastlistFallback(failing, { platform: 'win32', resolveFastlistPath: () => null })()).rejects.toBe(BUN_VIRTUAL_FS_ENOENT);
  });
});
