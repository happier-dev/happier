import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateMachineBrowsePath } from './machineBrowsePathPolicy';

afterEach(() => vi.unstubAllEnvs());

describe('validateMachineBrowsePath', () => {
  it.each(['~/projects\\child', '~\\projects/child'])('expands Windows home intent %s before applying discovered roots', (targetPath) => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\member\\');
    vi.stubEnv('HOME', '/home/custodian');
    const request = { targetPath, platform: 'win32' as const };
    expect(validateMachineBrowsePath({ ...request,
      roots: [{ id: 'member', label: 'Member', path: 'C:\\Users\\member' }],
    })).toEqual({ valid: true, resolvedPath: 'C:\\Users\\member\\projects\\child' });
    expect(validateMachineBrowsePath({ ...request,
      roots: [{ id: 'other', label: 'Other', path: 'C:\\Users\\other' }],
    })).toMatchObject({ valid: false });
  });

  it('accepts absolute paths within the discovered roots', () => {
    expect(validateMachineBrowsePath({
      targetPath: '/Users/leeroy',
      roots: [{ id: '/', label: '/', path: '/' }],
      platform: 'darwin',
    })).toEqual({
      valid: true,
      resolvedPath: '/Users/leeroy',
    });
  });

  it('rejects relative paths and paths outside allowed windows roots', () => {
    expect(validateMachineBrowsePath({
      targetPath: 'relative/path',
      roots: [{ id: '/', label: '/', path: '/' }],
      platform: 'darwin',
    })).toMatchObject({ valid: false });

    expect(validateMachineBrowsePath({
      targetPath: 'D:\\work',
      roots: [{ id: 'C:\\', label: 'C:', path: 'C:\\' }],
      platform: 'win32',
    })).toMatchObject({ valid: false });
  });

  it('accepts absolute windows paths within the allowed root on windows platforms', () => {
    expect(validateMachineBrowsePath({
      targetPath: 'C:\\work\\repo',
      roots: [{ id: 'C:\\', label: 'C:', path: 'C:\\' }],
      platform: 'win32',
    })).toEqual({
      valid: true,
      resolvedPath: 'C:\\work\\repo',
    });
  });

  it('rejects symlinked directories that escape an allowed root', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-machine-browse-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'happier-machine-browse-outside-'));

    try {
      const root = join(workspace, 'root');
      const linkPath = join(root, 'escape');
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      expect(validateMachineBrowsePath({
        targetPath: linkPath,
        roots: [{ id: 'root', label: 'Root', path: root }],
      })).toMatchObject({ valid: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
