import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import {
  TriagePrepareReviewWorkspaceInputV1Schema,
  TriagePrepareReviewWorkspaceResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import pullRequestSelf from '../fixtures/pullRequestSelf.json' with { type: 'json' };
import { decodeBitbucketPullRequestRow } from '../entries.js';
import { encodeBitbucketConfiguration } from '../instance.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import { toBitbucketPresentObservation } from './observations.js';
import { prepareBitbucketReviewWorkspace } from './prepareReviewWorkspace.js';
import {
  accountRef,
  createConnectedAccountsStub,
  createHttpStub,
  createRuntime,
} from './testSupport.js';

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: 'happier.scm.forge.bitbucket',
  localId: 'bitbucket-forge',
});
const BASE_SHA = 'c07d5b21f4ae';
const HEAD_SHA = '3f6c1a8e9b24';

function configurationToken(): string {
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid: WORKSPACE_UUID });
  if (!encoded.ok) throw new Error('fixture configuration must encode');
  return encoded.token;
}

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: SOURCE_CONTRIBUTION,
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: accountRef('account-1'),
    },
    localInstanceKey: WORKSPACE_UUID,
    configuration: { v: 1, token: configurationToken() },
    locator: { v: 1, displayLabel: 'Example Workspace' },
  };
}

function preparationInput(input: Readonly<{
  workspace?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
  observed?: Partial<Readonly<{ baseSha: string; headSha: string; nativeRevision: string }>>;
  lastKnownLocator?: Readonly<{ v: 1; routingToken?: string }>;
}> = {}) {
  const instance = configuredInstance();
  return TriagePrepareReviewWorkspaceInputV1Schema.parse({
    v: 1,
    instance,
    entryRef: {
      source: instance.instance.source,
      kindId: 'pull-request',
      collisionScope: `bitbucket:${REPOSITORY_UUID}`,
      entryId: '42',
    },
    lastKnownLocator: input.lastKnownLocator ?? {
      v: 1,
      routingToken: 'example-workspace/deploy-tools',
    },
    observed: {
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      nativeRevision: HEAD_SHA,
      observedAtMs: 1_760_000_000_000,
      ...input.observed,
    },
    workspace: input.workspace === undefined
      ? { serverId: 'server-1', machineId: 'machine-1', rootPath: '/selected/repository' }
      : input.workspace,
  });
}

function pullRequestFromFork(): Record<string, unknown> {
  const result = structuredClone(pullRequestSelf) as Record<string, unknown>;
  const source = result.source as Record<string, unknown>;
  const repository = source.repository as Record<string, unknown>;
  source.repository = {
    ...repository,
    uuid: '{8f3f4e1d-b55d-4bd1-af79-8b8a0c8dfd7c}',
    name: 'fork-tools',
    full_name: 'contributor/fork-tools',
    links: {
      clone: [
        { name: 'ssh', href: 'git@bitbucket.org:contributor/fork-tools.git' },
        { name: 'https', href: 'https://bitbucket.org/contributor/fork-tools.git' },
      ],
    },
  };
  return result;
}

function workspaceRuntime(input: Readonly<{
  pullRequest?: unknown;
  providerReply?: Readonly<{ status?: number; body?: unknown }>;
  execute: ReturnType<typeof vi.fn>;
  signal?: AbortSignal;
}>) {
  const { connectedAccounts, materializations } = createConnectedAccountsStub({
    accounts: [{ accountId: 'account-1' }],
  });
  const { http, requests } = createHttpStub((url) => {
    if (url.includes('/pullrequests/42')) {
      return input.providerReply ?? { body: input.pullRequest ?? pullRequestFromFork() };
    }
    throw new Error(`unexpected provider request: ${url}`);
  });
  return {
    runtime: {
      ...createRuntime(connectedAccounts, http),
      actions: { execute: input.execute } as unknown as ActionsService,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    materializations,
    requests,
  };
}

describe('Bitbucket selected-PR review workspace preparation', () => {
  it('reauthorizes, rereads, and delegates only the fork source tip at the selected root', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      targetPath: '/selected/repository/.happier/review/fork-tools',
      branchName: 'fix/poller-deadline',
      created: true,
      currentness: { kind: 'currentAtObservedHead' as const },
    }));
    const signal = new AbortController().signal;
    const seam = workspaceRuntime({ execute, signal });

    const result = await prepareBitbucketReviewWorkspace(preparationInput(), seam.runtime);

    expect(TriagePrepareReviewWorkspaceResultV1Schema.parse(result)).toEqual(result);
    expect(result).toEqual({
      kind: 'prepared',
      repositoryPath: '/selected/repository/.happier/review/fork-tools',
      branch: 'fix/poller-deadline',
      created: true,
      currentness: { kind: 'currentAtObservedHead' },
      // Bitbucket's existing SCM adapter owns this opaque reference shape.
      pullRequest: { number: 42 },
    });
    expect(seam.materializations).toEqual(['account-1']);
    expect(seam.requests.map((request) => request.url)).toEqual([
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(WORKSPACE_UUID)}`
        + `/${encodeURIComponent(REPOSITORY_UUID)}/pullrequests/42`,
    ]);
    // The destination repository addresses the reread only. A fork's source
    // repository, branch and clone link are the sole editable checkout facts.
    expect(execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/selected/repository',
        displayName: 'fix/poller-deadline',
        sourceTip: {
          repository: {
            kind: 'bitbucket',
            deployment: 'https://bitbucket.org',
            repository: 'contributor/fork-tools',
          },
          cloneUrl: 'https://bitbucket.org/contributor/fork-tools.git',
          branch: 'fix/poller-deadline',
          sourceHeadSha: HEAD_SHA,
          fetchRef: 'refs/heads/fix/poller-deadline',
        },
      },
      { signal },
    );
  });

  it.each([
    ['baseSha', 'ffffffffffff'],
    ['headSha', 'eeeeeeeeeeee'],
    ['nativeRevision', 'dddddddddddd'],
  ] as const)('refuses a reread whose observed %s moved before local materialization', async (field, value) => {
    const execute = vi.fn();
    const seam = workspaceRuntime({ execute });

    await expect(prepareBitbucketReviewWorkspace(
      preparationInput({ observed: { [field]: value } }),
      seam.runtime,
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a missing provider source clone link instead of falling back to the destination', async () => {
    const execute = vi.fn();
    const raw = pullRequestFromFork();
    const source = raw.source as Record<string, unknown>;
    const sourceRepository = source.repository as Record<string, unknown>;
    source.repository = { ...sourceRepository, links: { clone: [] } };
    const seam = workspaceRuntime({ execute, pullRequest: raw });

    await expect(prepareBitbucketReviewWorkspace(preparationInput(), seam.runtime))
      .resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a stale opaque route rather than replacing the canonical immutable entry route', async () => {
    const execute = vi.fn();
    const seam = workspaceRuntime({ execute });

    await expect(prepareBitbucketReviewWorkspace(
      preparationInput({ lastKnownLocator: { v: 1, routingToken: 'other/repository' } }),
      seam.runtime,
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a 404 reread instead of treating it as a usable or substituted pull request', async () => {
    const execute = vi.fn();
    const seam = workspaceRuntime({
      execute,
      providerReply: { status: 404, body: { error: { message: 'not found' } } },
    });

    await expect(prepareBitbucketReviewWorkspace(preparationInput(), seam.runtime))
      .resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a selected workspace before provider authorization or local materialization', async () => {
    const execute = vi.fn();
    const seam = workspaceRuntime({ execute });

    await expect(prepareBitbucketReviewWorkspace(
      preparationInput({ workspace: null }),
      seam.runtime,
    )).resolves.toEqual({ kind: 'workspaceRequired' });

    expect(seam.materializations).toEqual([]);
    expect(seam.requests).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_REPOSITORY', { kind: 'workspaceMismatch' }],
    ['INVALID_PATH', { kind: 'workspaceMismatch' }],
    ['REMOTE_NOT_FOUND', { kind: 'workspaceMismatch' }],
    ['COMMAND_FAILED', { kind: 'unavailable', reason: 'scmResolver' }],
  ] as const)('projects generic SCM failure %s through the published source result', async (errorCode, expected) => {
    const execute = vi.fn(async () => ({
      success: false as const,
      error: 'materialization failed',
      errorCode,
    }));
    const seam = workspaceRuntime({ execute });

    await expect(prepareBitbucketReviewWorkspace(preparationInput(), seam.runtime))
      .resolves.toEqual(expected);
  });

  it('preserves generic Action cancellation rather than converting it to a source result', async () => {
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const execute = vi.fn(async () => {
      throw cancellation;
    });
    const seam = workspaceRuntime({ execute, signal: new AbortController().signal });

    await expect(prepareBitbucketReviewWorkspace(preparationInput(), seam.runtime))
      .rejects.toBe(cancellation);
  });

  it('publishes all three source-owned revision facts together when a PR read proves them', () => {
    const decoded = decodeBitbucketPullRequestRow(pullRequestFromFork());
    if (!decoded.ok) throw new Error('fixture pull request must decode');

    const observation = toBitbucketPresentObservation(decoded.entry, {
      viewerAccountUuid: '{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}',
    });

    expect(observation.snapshot.reviewRevision).toEqual({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      nativeRevision: HEAD_SHA,
    });
  });
});
