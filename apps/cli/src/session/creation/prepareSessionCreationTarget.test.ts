import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { readSessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol';

vi.mock('@/scm/rpc/dispatch', () => ({
  notRepositoryResponse: vi.fn(),
  runScmRoute: vi.fn(),
}));
vi.mock('@/scm/workspace', () => ({
  realizeWorkspaceCheckoutWithScmWorkspaceSource: vi.fn(),
}));

import { prepareSessionCreationTarget } from './prepareSessionCreationTarget';
import { createManagedSessionDirectories } from './managedSessionDirectories';

describe('prepareSessionCreationTarget', () => {
  it('predicts the admitted requester workspace allocation that native spawn will materialize', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-requester-preparation-'));
    const workspaceRoot = join(activeServerDir, 'member-workspace');
    try {
      const sessionCreationTag = SessionCreationTagV1Schema.parse(`create:v1:${'b'.repeat(43)}`);
      const request = { directory: { kind: 'managed' as const }, sessionCreationTag };
      const nativeAllocation = createManagedSessionDirectories({ activeServerDir,
        payloadPlacement: { root: workspaceRoot, agentUid: 1001 } }).prepareForCreation({ sessionCreationTag });
      const target = await prepareSessionCreationTarget({ request, activeServerDir, managedWorkspaceRoot: workspaceRoot });
      expect(target).toEqual({ ok: true, directory: join(workspaceRoot, nativeAllocation.allocationId),
        directoryKind: 'managed', directoryCreationRequired: false, checkout: null });
      expect(target).toMatchObject({ directory: nativeAllocation.directory });
      await expect(access(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(activeServerDir, 'session-directories'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });
  it('prepares a managed target deterministically without materializing its private directory', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-preparation-'));
    try {
      const request = { directory: { kind: 'managed' as const }, sessionCreationTag: SessionCreationTagV1Schema.parse(`create:v1:${'a'.repeat(43)}`) };
      const first = await prepareSessionCreationTarget({ request, activeServerDir });
      expect(first).toMatchObject({ ok: true, directoryKind: 'managed', directoryCreationRequired: false, checkout: null });
      expect(await prepareSessionCreationTarget({ request, activeServerDir })).toEqual(first);
      await expect(access(join(activeServerDir, 'session-directories'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await prepareSessionCreationTarget({ request: { directory: { kind: 'managed' } }, activeServerDir })).toEqual({ ok: false, code: 'invalid_directory' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
  it('reports a missing direct target directory without creating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-creation-target-'));
    const directory = join(root, 'new-session-directory');

    try {
      await expect(prepareSessionCreationTarget({
        request: { directory: { kind: 'path', path: directory } },
        platform: 'linux',
      })).resolves.toEqual({
        ok: true,
        directory,
        directoryKind: 'path',
        directoryCreationRequired: true,
        checkout: null,
      });
      await expect(access(directory)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('canonicalizes target-machine home and mixed Windows separators without sibling-prefix confusion', async () => {
    await expect(prepareSessionCreationTarget({
      request: { directory: { kind: 'path', path: '~\\projects/acme/../repo/' } },
      env: { USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
    })).resolves.toEqual({
      ok: true,
      directory: 'C:\\Users\\alice\\projects\\repo',
      directoryKind: 'path',
      directoryCreationRequired: true,
      checkout: null,
    });

    await expect(prepareSessionCreationTarget({
      request: { directory: { kind: 'path', path: 'C:\\Users\\alice2\\repo\\' } },
      env: { USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
    })).resolves.toEqual({
      ok: true,
      directory: 'C:\\Users\\alice2\\repo',
      directoryKind: 'path',
      directoryCreationRequired: true,
      checkout: null,
    });
  });

  it('records SCM-owned checkout output as the immutable final directory', async () => {
    const createCheckout = vi.fn(async () => ({
      success: true as const,
      worktreePath: '/repo/.dev/worktree/feature-session',
      branchName: 'feature-session',
    }));

    await expect(prepareSessionCreationTarget({
      request: {
        directory: { kind: 'path', path: '/repo' },
        checkoutCreationDraft: {
          kind: 'git_worktree',
          displayName: 'feature-session',
          baseRef: 'main',
          branchMode: 'existing',
        },
      },
      platform: 'linux',
      createCheckout,
    })).resolves.toEqual({
      ok: true,
      directory: '/repo/.dev/worktree/feature-session',
      directoryKind: 'path',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: '/repo/.dev/worktree/feature-session',
        branchName: 'feature-session',
        baseRef: 'main',
        branchMode: 'existing',
      },
    });
    expect(createCheckout).toHaveBeenCalledWith({
      sourceDirectory: '/repo',
      displayName: 'feature-session',
      baseRef: 'main',
      branchMode: 'existing',
      signal: undefined,
    });
  });

  it('rebases a nested source directory into the worktree and retains the known-created receipt', async () => {
    const createCheckout = vi.fn(async () => ({
      success: true as const,
      worktreePath: '/repo/.dev/worktree/feature-session',
      branchName: 'feature-session',
      sourceRootPath: '/repo',
      created: true,
    }));

    await expect(prepareSessionCreationTarget({
      request: {
        directory: { kind: 'path', path: '/repo/packages/app' },
        checkoutCreationDraft: {
          kind: 'git_worktree',
          displayName: 'feature-session',
          baseRef: null,
          branchMode: 'new',
        },
      },
      platform: 'linux',
      createCheckout,
    })).resolves.toEqual({
      ok: true,
      directory: '/repo/.dev/worktree/feature-session/packages/app',
      directoryKind: 'path',
      directoryCreationRequired: false,
      checkout: {
        kind: 'git_worktree',
        finalDirectory: '/repo/.dev/worktree/feature-session',
        baseRef: null,
        branchName: 'feature-session',
        branchMode: 'new',
        created: true,
      },
    });
  });

  it('rebases Windows source subpaths case-insensitively and contains sibling-prefix mismatches', async () => {
    const createCheckout = vi.fn(async () => ({
      success: true as const,
      worktreePath: 'C:\\Repo\\.dev\\worktree\\feature-session',
      branchName: 'feature-session',
      sourceRootPath: 'c:\\repo',
      created: false,
    }));
    const checkoutCreationDraft = {
      kind: 'git_worktree' as const,
      displayName: 'feature-session',
      baseRef: null,
      branchMode: 'existing' as const,
    };

    await expect(prepareSessionCreationTarget({
      request: {
        directory: { kind: 'path', path: 'C:\\Repo\\Packages\\App' },
        checkoutCreationDraft,
      },
      platform: 'win32',
      createCheckout,
    })).resolves.toMatchObject({
      ok: true,
      directory: 'C:\\Repo\\.dev\\worktree\\feature-session\\Packages\\App',
      checkout: { created: false },
    });

    createCheckout.mockResolvedValueOnce({
      success: true as const,
      worktreePath: 'C:\\Repo\\.dev\\worktree\\feature-session',
      branchName: 'feature-session',
      sourceRootPath: 'C:\\Repo',
      created: false,
    });
    await expect(prepareSessionCreationTarget({
      request: {
        directory: { kind: 'path', path: 'C:\\Repo-Other\\Packages\\App' },
        checkoutCreationDraft,
      },
      platform: 'win32',
      createCheckout,
    })).resolves.toMatchObject({
      ok: true,
      directory: 'C:\\Repo\\.dev\\worktree\\feature-session',
    });
  });

  it('replays the same SCM request and final path for a same-key preparation retry', async () => {
    const createCheckout = vi.fn(async () => ({
      success: true as const,
      worktreePath: '/repo/.dev/worktree/stable',
      branchName: 'stable',
    }));
    const input = {
      request: {
        directory: { kind: 'path' as const, path: '/repo' },
        checkoutCreationDraft: {
          kind: 'git_worktree' as const,
          displayName: 'stable',
          baseRef: null,
          branchMode: 'new' as const,
        },
      },
      platform: 'linux' as const,
      createCheckout,
    };

    expect(await prepareSessionCreationTarget(input))
      .toEqual(await prepareSessionCreationTarget(input));
    expect(createCheckout).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the target path or SCM checkout cannot be prepared', async () => {
    await expect(prepareSessionCreationTarget({
      request: { directory: { kind: 'path', path: 'relative/repo' } },
      platform: 'linux',
    })).resolves.toEqual({ ok: false, code: 'invalid_directory' });

    await expect(prepareSessionCreationTarget({
      request: {
        directory: { kind: 'path', path: '/repo' },
        checkoutCreationDraft: {
          kind: 'git_worktree',
          displayName: 'feature',
          baseRef: null,
        },
      },
      platform: 'linux',
      createCheckout: async () => ({
        success: false,
        worktreePath: '',
        branchName: '',
        errorCode: 'FEATURE_UNSUPPORTED',
      }),
    })).rejects.toMatchObject({ rpcErrorCode: 'checkout_unavailable',
      failureCause: { errorCode: 'FEATURE_UNSUPPORTED' } });
  });
});


it('carries checkout failures through the existing RPC refusal into the spawn result', async () => {
  const error = await prepareSessionCreationTarget({
    request: { directory: { kind: 'path', path: '/repo' },
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature-session', baseRef: 'main', branchMode: 'new' } },
    platform: 'linux',
    createCheckout: async () => { throw Object.assign(new Error('private checkout output'), { code: 'EACCES' }); },
  }).catch((error: unknown) => error);
  expect(readSessionCreationTargetPreparationResultV1(error)).toMatchObject({ ok: false, result: {
    type: 'error', failureCause: { phase: 'session.target_preparation', errorCode: 'EACCES', errorClass: 'Error' },
  } });
  expect(JSON.stringify(error)).not.toContain('private');
});
