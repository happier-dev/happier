import { chmod, lstat, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensurePrivateConnectedServiceMaterializedRoot,
} from './privateMaterializedRoot';
import type { ProtectedLocalStateOptions } from '@/utils/fs/protectedLocalState';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('private connected-service materialized root', () => {
  it('creates a Windows root through the protected-local-state ACL owner and fails closed for an inherited ACL', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-materialized-windows-parent-'));
    roots.push(parent);
    const root = join(parent, 'materialized');
    const events: string[] = [];
    const protectedLocalStateOptions: ProtectedLocalStateOptions = {
      platform: 'win32',
      windowsAclBoundary: {
        async applyAndVerify({ kind }) {
          events.push(`apply:${kind}`);
        },
        async verify({ kind }) {
          events.push(`verify:${kind}`);
        },
      },
    };
    await ensurePrivateConnectedServiceMaterializedRoot(root, protectedLocalStateOptions);

    expect(events).toEqual(['apply:directory', 'verify:directory']);

    await expect(ensurePrivateConnectedServiceMaterializedRoot(root, {
      ...protectedLocalStateOptions,
      windowsAclBoundary: {
        async applyAndVerify() {
          throw new Error('must not harden an existing inherited ACL without verification');
        },
        async verify() {
          throw new Error('inherited ACL');
        },
      },
    })).rejects.toThrow('connected_service_materialization_root_unsafe');
  });

  it('hardens an existing owner-controlled root to the exact capability mode', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'happier-materialized-root-'));
    roots.push(root);
    await chmod(root, 0o755);

    await ensurePrivateConnectedServiceMaterializedRoot(root);

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlink root without changing its target mode', async () => {
    if (process.platform === 'win32') return;
    const parent = await mkdtemp(join(tmpdir(), 'happier-materialized-parent-'));
    const outside = await mkdtemp(join(tmpdir(), 'happier-materialized-outside-'));
    roots.push(parent, outside);
    await chmod(outside, 0o755);
    const root = join(parent, 'materialized');
    await symlink(outside, root, 'dir');

    await expect(ensurePrivateConnectedServiceMaterializedRoot(root))
      .rejects.toThrow('connected_service_materialization_root_unsafe');
    expect((await lstat(outside)).mode & 0o777).toBe(0o755);
  });

  it('rejects a root not owned by the daemon uid before changing its mode', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
    const root = await mkdtemp(join(tmpdir(), 'happier-materialized-foreign-'));
    roots.push(root);
    await chmod(root, 0o755);
    const actualUid = process.getuid();
    const originalGetuid = process.getuid;
    Object.defineProperty(process, 'getuid', {
      configurable: true,
      value: () => actualUid + 1,
    });
    try {
      await expect(ensurePrivateConnectedServiceMaterializedRoot(root))
        .rejects.toThrow('connected_service_materialization_root_unsafe');
    } finally {
      Object.defineProperty(process, 'getuid', {
        configurable: true,
        value: originalGetuid,
      });
    }
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
  });
});
