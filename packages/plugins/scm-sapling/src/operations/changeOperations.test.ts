import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BackendRuntimeContext as ScmBackendContext } from '@happier-dev/plugin-sdk/scm/backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { saplingChangeDiscard } from './changeOperations';

describe('saplingChangeDiscard', () => {
  it('removes untracked directories recursively', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'happier-sapling-change-discard-'));
    try {
      const dirToRemove = path.join(root, 'untracked-dir');
      mkdirSync(path.join(dirToRemove, 'nested'), { recursive: true });
      writeFileSync(path.join(dirToRemove, 'nested', 'file.txt'), 'hi');

      const context: ScmBackendContext = {
        cwd: root,
        projectKey: 'test',
        detection: { isRepo: true, rootPath: root, mode: '.sl' },
      };

      const result = await saplingChangeDiscard({
        context,
        request: { entries: [{ path: 'untracked-dir', kind: 'untracked' }] },
      });

      expect(result).toEqual({ success: true });
      expect(existsSync(dirToRemove)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects root-equivalent untracked discard entries without deleting the repository root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'happier-sapling-change-discard-root-'));
    try {
      writeFileSync(path.join(root, 'marker.txt'), 'keep');

      const context: ScmBackendContext = {
        cwd: root,
        projectKey: 'test',
        detection: { isRepo: true, rootPath: root, mode: '.sl' },
      };

      const result = await saplingChangeDiscard({
        context,
        request: { entries: [{ path: '.', kind: 'untracked' }] },
      });

      expect(result).toMatchObject({
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
      });
      expect(existsSync(root)).toBe(true);
      expect(existsSync(path.join(root, 'marker.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
