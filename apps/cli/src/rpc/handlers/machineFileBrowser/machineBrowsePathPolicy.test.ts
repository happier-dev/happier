import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateMachineBrowsePath } from './machineBrowsePathPolicy';

describe('validateMachineBrowsePath', () => {
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
