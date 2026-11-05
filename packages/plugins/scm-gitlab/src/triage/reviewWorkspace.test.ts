import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriagePrepareReviewWorkspaceInputV1Schema,
  TriageVerifyReviewWorkspaceInputV1Schema,
  type TriagePrepareReviewWorkspaceInputV1,
  type TriageVerifyReviewWorkspaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  prepareGitlabReviewWorkspaceAction,
  verifyGitlabReviewWorkspaceAction,
} from './operations.js';
import {
  createStubGitlabTransport,
  gitlabTestConfiguredInstance,
  GITLAB_TEST_COLLISION_SCOPE,
  type RecordedGitlabRequest,
  type StubGitlabResponse,
} from './testkit/gitlabTriage.test-support.js';

const OBSERVED_BASE = '1'.repeat(40);
const OBSERVED_HEAD = '2'.repeat(40);
const ADVANCED_HEAD = '3'.repeat(40);
const NATIVE_REVISION = '4'.repeat(40);
const REVIEW_ITEM_URL_SUFFIX = '/api/v4/projects/maintainer%2Frepository/merge_requests/7';
const REVIEW_ITEM_URL = `https://gitlab.com${REVIEW_ITEM_URL_SUFFIX}`;
/** GitLab names the editable project by id; it never embeds the project object. */
const SOURCE_PROJECT_ID = 17;
const SOURCE_PROJECT_URL_SUFFIX = `/api/v4/projects/${String(SOURCE_PROJECT_ID)}`;
const SOURCE_PROJECT_URL = `https://gitlab.com${SOURCE_PROJECT_URL_SUFFIX}`;

type RawBody = Readonly<Record<string, unknown>>;

/**
 * A documented merge-request response.
 *
 * `GET /projects/{id}/merge_requests/{iid}` publishes `source_project_id`, a
 * source branch and its revisions — never a nested `source_project` object. A
 * fixture that embeds one proves a shape GitLab does not serve.
 */
function mergeRequestBody(overrides: RawBody = {}): RawBody {
  return {
    project_id: 3,
    iid: 7,
    references: { full: 'maintainer/repository!7' },
    sha: OBSERVED_HEAD,
    diff_refs: { base_sha: OBSERVED_BASE, head_sha: OBSERVED_HEAD },
    source_branch: 'feature/from-fork',
    source_project_id: SOURCE_PROJECT_ID,
    target_project_id: 3,
    ...overrides,
  };
}

function sourceProjectBody(overrides: RawBody = {}): RawBody {
  return {
    id: SOURCE_PROJECT_ID,
    path_with_namespace: 'contributor/repository',
    http_url_to_repo: 'https://gitlab.com/contributor/repository.git',
    ...overrides,
  };
}

function respondWith(input: Readonly<{
  itemSuffix?: string;
  mergeRequest: RawBody;
  project?: RawBody | StubGitlabResponse | null;
}>): (request: RecordedGitlabRequest) => StubGitlabResponse | undefined {
  const itemSuffix = input.itemSuffix ?? REVIEW_ITEM_URL_SUFFIX;
  const project = input.project === undefined ? sourceProjectBody() : input.project;
  return (request) => {
    if (request.url.endsWith(itemSuffix)) return { status: 200, body: input.mergeRequest };
    if (project !== null && request.url.endsWith(SOURCE_PROJECT_URL_SUFFIX)) {
      return typeof project.status === 'number'
        ? project as StubGitlabResponse
        : { status: 200, body: project };
    }
    return undefined;
  };
}

function preparedMaterialization(branch = 'feature/from-fork') {
  return vi.fn(async () => ({
    success: true as const,
    targetPath: '/workspaces/selected-repository/.happier/review',
    branchName: branch,
    created: true,
    currentness: { kind: 'currentAtObservedHead' as const },
  }));
}

function collisionScopeFor(origin: string): string {
  return `gitlab:${Buffer.from(origin, 'utf8').toString('base64url')}:3`;
}

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

function verifyInput(
  overrides: Partial<TriageVerifyReviewWorkspaceInputV1> = {},
): TriageVerifyReviewWorkspaceInputV1 {
  const prepared = prepareInput();
  return TriageVerifyReviewWorkspaceInputV1Schema.parse({
    v: 1,
    instance: prepared.instance,
    entryRef: prepared.entryRef,
    lastKnownLocator: prepared.lastKnownLocator,
    observed: prepared.observed,
    workspace: prepared.workspace,
    prepared: {
      repositoryPath: '/workspaces/selected-repository/.happier/review',
      pullRequest: { number: 7 },
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
  it.each([
    ['another deployment path', 'https://git.example.test/B/contributor/repository.git'],
    ['a sibling path prefix', 'https://git.example.test/A2/contributor/repository.git'],
  ])('refuses a source clone URL under %s before SCM materialization', async (_case, cloneUrl) => {
    const origin = 'https://git.example.test/A';
    const transport = createStubGitlabTransport({
      origin,
      respond: respondWith({
        mergeRequest: mergeRequestBody(),
        project: sourceProjectBody({ http_url_to_repo: cloneUrl }),
      }),
    });
    const execute = preparedMaterialization();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput({
        instance: gitlabTestConfiguredInstance({ localInstanceKey: origin }),
        entryRef: {
          source: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-forge' },
          kindId: 'merge-request',
          collisionScope: collisionScopeFor(origin),
          entryId: '7',
        },
      }),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(transport.requests.map((request) => request.url))
      .toEqual([`${origin}${REVIEW_ITEM_URL_SUFFIX}`, `${origin}${SOURCE_PROJECT_URL_SUFFIX}`]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('admits a source clone URL beneath the exact configured deployment path', async () => {
    const origin = 'https://git.example.test/A';
    const cloneUrl = `${origin}/group/repository.git`;
    const transport = createStubGitlabTransport({
      origin,
      respond: respondWith({
        mergeRequest: mergeRequestBody(),
        project: sourceProjectBody({ http_url_to_repo: cloneUrl }),
      }),
    });
    const execute = preparedMaterialization();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput({
        instance: gitlabTestConfiguredInstance({ localInstanceKey: origin }),
        entryRef: {
          source: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-forge' },
          kindId: 'merge-request',
          collisionScope: collisionScopeFor(origin),
          entryId: '7',
        },
      }),
      withMaterializer(transport.context, execute),
    )).resolves.toMatchObject({ kind: 'prepared' });

    expect(execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      expect.objectContaining({
        sourceTip: expect.objectContaining({ cloneUrl }),
      }),
      { signal: transport.context.signal },
    );
  });

  it('refuses a moved source head before it reads the source project', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody({
          sha: ADVANCED_HEAD,
          diff_refs: { base_sha: OBSERVED_BASE, head_sha: ADVANCED_HEAD },
        }),
      }),
    });
    const execute = preparedMaterialization();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });

    // The provider reread and exact-account authorization occur before the SCM
    // Action. A stale source revision may never reach a local materializer, and
    // it does not spend a second provider read either.
    expect(transport.materializeCount()).toBe(1);
    expect(transport.requests.map((request) => request.url))
      .toEqual([REVIEW_ITEM_URL]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('materializes the source project GitLab named by id at the exact selected root', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = preparedMaterialization();
    const context = withMaterializer(transport.context, execute);

    await expect(prepareGitlabReviewWorkspaceAction(prepareInput(), context)).resolves.toEqual({
      kind: 'prepared',
      repositoryPath: '/workspaces/selected-repository/.happier/review',
      branch: 'feature/from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' },
      pullRequest: { number: 7 },
    });

    expect(transport.requests.map((request) => request.url))
      .toEqual([REVIEW_ITEM_URL, SOURCE_PROJECT_URL]);
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

  it('prepares a same-project merge request from the project it names', async () => {
    const transport = createStubGitlabTransport({
      respond: (request) => request.url.endsWith(REVIEW_ITEM_URL_SUFFIX)
        ? {
          status: 200,
          body: mergeRequestBody({ source_project_id: 3, source_branch: 'feature' }),
        }
        : request.url.endsWith('/api/v4/projects/3')
          ? {
            status: 200,
            body: {
              id: 3,
              path_with_namespace: 'maintainer/repository',
              http_url_to_repo: 'https://gitlab.com/maintainer/repository.git',
            },
          }
          : undefined,
    });
    const execute = preparedMaterialization('feature');

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toMatchObject({ kind: 'prepared', branch: 'feature' });

    expect(execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      expect.objectContaining({
        sourceTip: {
          repository: {
            kind: 'gitlab',
            deployment: 'https://gitlab.com',
            repository: 'maintainer/repository',
          },
          cloneUrl: 'https://gitlab.com/maintainer/repository.git',
          branch: 'feature',
          sourceHeadSha: OBSERVED_HEAD,
          fetchRef: 'refs/heads/feature',
        },
      }),
      { signal: transport.context.signal },
    );
  });

  it('uses GitLab’s source head, not its separate native revision, for the local fetch', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody({ sha: NATIVE_REVISION }) }),
    });
    const execute = preparedMaterialization();

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
    const { workspace: _workspace, ...withoutWorkspace } = prepareInput();

    await expect(prepareGitlabReviewWorkspaceAction(
      withoutWorkspace,
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'workspaceRequired' });

    expect(transport.materializeCount()).toBe(0);
    expect(transport.requests).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a changed base before local materialization', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody({
          diff_refs: { base_sha: ADVANCED_HEAD, head_sha: OBSERVED_HEAD },
        }),
      }),
    });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a merge request that names no source project', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody({ source_project_id: undefined }),
        project: null,
      }),
    });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(transport.requests.map((request) => request.url)).toEqual([REVIEW_ITEM_URL]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a deleted source project rather than substituting the target project', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody(),
        project: { status: 404, body: { message: '404 Project Not Found' } },
      }),
    });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(transport.requests.map((request) => request.url))
      .toEqual([REVIEW_ITEM_URL, SOURCE_PROJECT_URL]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports an unreadable source project as configured-account unavailability', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody(),
        project: { status: 403, body: { message: '403 Forbidden' } },
      }),
    });
    const execute = vi.fn();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'unavailable', reason: 'account' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a source project whose identity is not the one the merge request named', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody(),
        project: sourceProjectBody({ id: SOURCE_PROJECT_ID + 1 }),
      }),
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
      respond: respondWith({
        itemSuffix: '/api/v4/projects/different%2Frepository/merge_requests/7',
        mergeRequest: mergeRequestBody(),
      }),
    });
    const execute = preparedMaterialization();

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput({ lastKnownLocator: { v: 1, routingToken: 'different/repository' } }),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(transport.requests[0]?.url).toContain('/projects/different%2Frepository/');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_REPOSITORY', { kind: 'workspaceMismatch' }],
    ['INVALID_PATH', { kind: 'workspaceMismatch' }],
    ['REMOTE_NOT_FOUND', { kind: 'workspaceMismatch' }],
    ['COMMAND_FAILED', { kind: 'unavailable', reason: 'scmResolver' }],
  ] as const)('projects generic SCM failure %s through the source result', async (errorCode, expected) => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
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

  it('rejects a verification-shaped SCM success during initial preparation', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      verification: {
        targetPath: '/workspaces/selected-repository/.happier/review',
        sourceHeadSha: OBSERVED_HEAD,
      },
    }));

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'unavailable', reason: 'scmResolver' });
  });

  it('preserves generic SCM Action cancellation', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = vi.fn(async () => { throw cancellation; });

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).rejects.toBe(cancellation);
  });

  it('projects a rejected generic SCM Action as SCM unavailability', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = vi.fn(async () => { throw new Error('SCM action transport unavailable'); });

    await expect(prepareGitlabReviewWorkspaceAction(
      prepareInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'unavailable', reason: 'scmResolver' });
  });
});

describe('GitLab final review-workspace verification', () => {
  it.each([OBSERVED_HEAD, ADVANCED_HEAD])(
    'verifies an accepted checkout only when its read-only native HEAD agrees (%s)', async (sourceHeadSha) => {
      const transport = createStubGitlabTransport({
        respond: respondWith({ mergeRequest: mergeRequestBody() }),
      });
      const repositoryPath = '/workspaces/selected-repository';
      const execute = vi.fn(async () => ({
        success: true as const,
        verification: { targetPath: repositoryPath, sourceHeadSha },
      }));
      const context = withMaterializer(transport.context, execute);

      await expect(verifyGitlabReviewWorkspaceAction(verifyInput({
        prepared: { kind: 'acceptedCheckout', repositoryPath },
      }), context)).resolves.toEqual(sourceHeadSha === OBSERVED_HEAD
        ? { kind: 'verified', pullRequest: { number: 7 } }
        : { kind: 'refused', reason: 'observedHeadMoved' });

      expect(transport.requests.map(request => request.url)).toEqual([REVIEW_ITEM_URL, SOURCE_PROJECT_URL]);
      expect(transport.requests.every(request => request.method === 'GET')).toBe(true);
      expect(execute.mock.calls).toEqual([[
        'scm.reviewWorkspace.materializePrepared',
        {
          cwd: repositoryPath,
          displayName: 'feature/from-fork',
          sourceTip: {
            repository: { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'contributor/repository' },
            cloneUrl: 'https://gitlab.com/contributor/repository.git',
            branch: 'feature/from-fork',
            sourceHeadSha: OBSERVED_HEAD,
            fetchRef: 'refs/heads/feature/from-fork',
          },
          verification: { targetPath: repositoryPath },
        },
        { signal: context.signal },
      ]]);
    },
  );

  it('verifies only after the provider reread and canonical local HEAD agree', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      verification: {
        targetPath: '/workspaces/selected-repository/.happier/review',
        sourceHeadSha: OBSERVED_HEAD,
      },
    }));
    const context = withMaterializer(transport.context, execute);

    await expect(verifyGitlabReviewWorkspaceAction(verifyInput(), context)).resolves.toEqual({
      kind: 'verified',
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
        verification: {
          targetPath: '/workspaces/selected-repository/.happier/review',
        },
      },
      { signal: context.signal },
    );
  });

  it('refuses when the prepared pull-request reference does not match the reread item', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = vi.fn();

    await expect(verifyGitlabReviewWorkspaceAction(
      verifyInput({
        prepared: {
          repositoryPath: '/workspaces/selected-repository/.happier/review',
          pullRequest: { number: 8 },
        },
      }),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a local checkout whose canonical HEAD no longer matches the reread head', async () => {
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const execute = vi.fn(async () => ({
      success: true as const,
      verification: {
        targetPath: '/workspaces/selected-repository/.happier/review',
        sourceHeadSha: ADVANCED_HEAD,
      },
    }));

    await expect(verifyGitlabReviewWorkspaceAction(
      verifyInput(),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });
  });

  it.each([false, true])('authoritatively refuses a moved source head before local verification (accepted=%s)', async (accepted) => {
    const transport = createStubGitlabTransport({
      respond: respondWith({
        mergeRequest: mergeRequestBody({
          sha: ADVANCED_HEAD,
          diff_refs: { base_sha: OBSERVED_BASE, head_sha: ADVANCED_HEAD },
        }),
      }),
    });
    const execute = vi.fn();

    await expect(verifyGitlabReviewWorkspaceAction(
      verifyInput(accepted ? {
        prepared: { kind: 'acceptedCheckout', repositoryPath: '/workspaces/selected-repository' },
      } : {}),
      withMaterializer(transport.context, execute),
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });

    expect(transport.materializeCount()).toBe(1);
    expect(transport.requests.map((request) => request.url))
      .toEqual([REVIEW_ITEM_URL]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves cancellation from canonical local-HEAD verification', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const transport = createStubGitlabTransport({
      respond: respondWith({ mergeRequest: mergeRequestBody() }),
    });
    const context = withMaterializer(
      transport.context,
      vi.fn(async () => { throw cancellation; }),
    );

    await expect(verifyGitlabReviewWorkspaceAction(verifyInput(), context))
      .rejects.toBe(cancellation);
  });

  it('preserves cancellation during the authoritative provider reread', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const controller = new AbortController();
    controller.abort(cancellation);
    const transport = createStubGitlabTransport({
      respond: () => undefined,
      signal: controller.signal,
    });

    await expect(verifyGitlabReviewWorkspaceAction(
      verifyInput(),
      withMaterializer(transport.context, vi.fn()),
    )).rejects.toBe(cancellation);
  });
});
