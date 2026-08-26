import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriagePrepareReviewWorkspaceInputV1Schema,
  type TriagePrepareReviewWorkspaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { prepareGitlabReviewWorkspaceAction } from './operations.js';
import {
  createStubGitlabTransport,
  gitlabTestConfiguredInstance,
  GITLAB_TEST_COLLISION_SCOPE,
} from './testkit/gitlabTriage.test-support.js';

const OBSERVED_BASE = '1'.repeat(40);
const OBSERVED_HEAD = '2'.repeat(40);
const ADVANCED_HEAD = '3'.repeat(40);
const NATIVE_REVISION = '4'.repeat(40);

function prepareInput(
  overrides: Partial<TriagePrepareReviewWorkspaceInputV1> = {},
): TriagePrepareReviewWorkspaceInputV1 {
  return TriagePrepareReviewWorkspaceInputV1Schema.parse({
    v: 1,
    instance: gitlabTestConfiguredInstance(),
    entryRef: {
      source: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-forge' },
      kindId: 'merge-request',
      collisionScope: GITLAB_TEST_COLLISION_SCOPE,
      entryId: '7',
    },
    lastKnownLocator: {
      v: 1,
      routingToken: 'maintainer/repository',
    },
    observed: {
      baseSha: OBSERVED_BASE,
      headSha: OBSERVED_HEAD,
      nativeRevision: OBSERVED_HEAD,
      observedAtMs: 1_764_000_000_000,
    },
    workspace: {
      serverId: 'server-1',
      machineId: 'machine-1',
      rootPath: '/workspaces/selected-repository',
    },
    ...overrides,
  });
}

function withMaterializer(
  context: PluginInvocationContext,
  execute: ReturnType<typeof vi.fn>,
): PluginInvocationContext {
  return {
    ...context,
    services: {
      ...context.services,
      actions: { execute },
    },
  } as unknown as PluginInvocationContext;
}

describe('GitLab prepared review workspace', () => {
  it('refuses a moved source head before local materialization', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: ADVANCED_HEAD,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: ADVANCED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/workspaces/selected-repository/.happier/review',
      branchName: 'feature/from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });

    // The provider reread and exact-account authorization occur before the SCM
    // Action. A stale source revision may never reach a local materializer.
    expect(transport.materializeCount()).toBe(1);
    expect(transport.requests.map((request) => request.url))
      .toEqual(['https://gitlab.com/api/v4/projects/3/merge_requests/7']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('materializes only the reread source project at the exact selected root', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: OBSERVED_HEAD,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
            target_project: {
              id: 3,
              path_with_namespace: 'maintainer/repository',
              http_url_to_repo: 'https://gitlab.com/maintainer/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/workspaces/selected-repository/.happier/review',
      branchName: 'feature/from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));
    const context = withMaterializer(transport.context, execute);

    await expect(prepareGitlabReviewWorkspaceAction(prepareInput(), context)).resolves.toEqual({
      kind: 'prepared',
      repositoryPath: '/workspaces/selected-repository/.happier/review',
      branch: 'feature/from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' },
      pullRequest: { number: 7 },
    });

    expect(execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/workspaces/selected-repository',
        displayName: 'feature/from-fork',
        sourceTip: {
          repository: {
            kind: 'gitlab',
            deployment: 'https://gitlab.com',
            repository: 'contributor/repository',
          },
          cloneUrl: 'https://gitlab.com/contributor/repository.git',
          branch: 'feature/from-fork',
          sourceHeadSha: OBSERVED_HEAD,
          fetchRef: 'refs/heads/feature/from-fork',
        },
      },
      { signal: context.signal },
    );
    expect(JSON.stringify(execute.mock.calls)).not.toContain('maintainer/repository');
    expect(JSON.stringify(execute.mock.calls)).not.toContain('merge-requests/7/head');
  });

  it('uses GitLab’s source head, not its separate native revision, for the local fetch', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: NATIVE_REVISION,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/workspaces/selected-repository/.happier/review',
      branchName: 'feature/from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput({
        observed: {
          baseSha: OBSERVED_BASE,
          headSha: OBSERVED_HEAD,
          nativeRevision: NATIVE_REVISION,
          observedAtMs: 1_764_000_000_000,
        },
      }),
      withMaterializer(transport.context, execute),
    )).resolves.toMatchObject({ kind: 'prepared' });

    expect(execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      expect.objectContaining({
        sourceTip: expect.objectContaining({ sourceHeadSha: OBSERVED_HEAD }),
      }),
      { signal: transport.context.signal },
    );
  });

  it('requires an explicit workspace before it authorizes or rereads GitLab', async () => {
    const transport = createStubGitlabTransport({ respond: () => undefined });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput({ workspace: null }),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'workspaceRequired' });

    expect(transport.materializeCount()).toBe(0);
    expect(transport.requests).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a changed base before local materialization', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: OBSERVED_HEAD,
            diff_refs: { base_sha: ADVANCED_HEAD, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an unavailable source project rather than substituting the target project', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: OBSERVED_HEAD,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: null,
            target_project: {
              id: 3,
              path_with_namespace: 'maintainer/repository',
              http_url_to_repo: 'https://gitlab.com/maintainer/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a stale observed locator before local materialization', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: OBSERVED_HEAD,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/workspaces/selected-repository/.happier/review',
      branchName: 'feature/from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput({ lastKnownLocator: { v: 1, routingToken: 'different/repository' } }),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_REPOSITORY', { kind: 'workspaceMismatch' }],
    ['INVALID_PATH', { kind: 'workspaceMismatch' }],
    ['REMOTE_NOT_FOUND', { kind: 'workspaceMismatch' }],
    ['COMMAND_FAILED', { kind: 'unavailable', reason: 'scmResolver' }],
  ] as const)('projects generic SCM failure %s through the source result', async (errorCode, expected) => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: OBSERVED_HEAD,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn(async () => ({
      success: false as const,
      error: 'materialization failed',
      errorCode,
    }));

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual(expected);
  });

  it('preserves generic SCM Action cancellation', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith('/api/v4/projects/3/merge_requests/7')
        ? {
          status: 200,
          body: {
            project_id: 3,
            iid: 7,
            references: { full: 'maintainer/repository!7' },
            sha: OBSERVED_HEAD,
            diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
            source_branch: 'feature/from-fork',
            source_project: {
              id: 17,
              path_with_namespace: 'contributor/repository',
              http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
            },
          },
        }
        : undefined,
    });
    const execute = vi.fn(async () => { throw cancellation; });

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).rejects.toBe(cancellation);
  });
});
