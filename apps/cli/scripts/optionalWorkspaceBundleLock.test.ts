import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

describe('optionalWorkspaceBundleLock', () => {
  it('uses the canonical CLI shared-dependency publication lock path', () => {
    const repoRoot = join(tmpdir(), 'happier-lock-path');

    expect(resolveCliSharedDepsBuildLockPath(repoRoot)).toBe(
      join(repoRoot, '.project', 'tmp', 'cli-shared-deps.lock'),
    );
  });

  it('reenters only when the inherited owner lease exactly matches', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-reentry-'));
    try {
      const lockPath = resolveCliSharedDepsBuildLockPath(repoRoot);

      const result = await withWorkspaceBundleLock(
        async ({ heldLockValue }) =>
          await withOptionalCliSharedDepsBuildLock(
            async () => 'nested',
            {
              repoRoot,
              lockPath,
              env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
              lockTimeoutMs: 60,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            },
          ),
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );

      expect(result).toBe('nested');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('waits when the inherited lock path does not match', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-mismatch-'));
    try {
      const lockPath = resolveCliSharedDepsBuildLockPath(repoRoot);

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            withOptionalCliSharedDepsBuildLock(
              async () => 'nested',
              {
                repoRoot,
                lockPath,
                env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: join(repoRoot, 'different.lock') },
                lockTimeoutMs: 60,
                lockPollIntervalMs: 10,
                lockStaleAfterMs: 1_000,
              },
            ),
          ).rejects.toThrow(/Timed out waiting for workspace bundle lock/);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
