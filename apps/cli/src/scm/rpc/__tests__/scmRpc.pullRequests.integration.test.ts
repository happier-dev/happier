import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  ScmPullRequestCheckoutRequest,
  ScmPullRequestCheckoutResponse,
  ScmPullRequestOpenComposeRequest,
  ScmPullRequestOpenComposeResponse,
  ScmPullRequestListRequest,
  ScmPullRequestListResponse,
  ScmPullRequestGetRequest,
  ScmPullRequestGetResponse,
  ScmPullRequestOpenOrReuseRequest,
  ScmPullRequestOpenOrReuseResponse,
  ScmPullRequestPrepareWorktreeRequest,
  ScmPullRequestPrepareWorktreeResponse,
  ScmPullRequestRunStackedRequest,
  ScmPullRequestRunStackedResponse,
  ScmStatusSnapshotRequest,
  ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { buildConnectedServiceCredentialRecord, SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

function createGithubBackedRemoteFixture(): { workspace: string; featureHead: string } {
  const bare = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-origin-'));
  git(bare, ['init', '--bare']);

  const seed = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-seed-'));
  git(seed, ['init']);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test User']);
  git(seed, ['branch', '-M', 'main']);
  writeFileSync(join(seed, 'base.txt'), 'base\n');
  git(seed, ['add', 'base.txt']);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main']);
  git(seed, ['checkout', '-b', 'feature/pr-branch']);
  writeFileSync(join(seed, 'base.txt'), 'feature branch\n');
  git(seed, ['commit', '-am', 'feature branch']);
  git(seed, ['push', 'origin', 'feature/pr-branch']);
  const featureHead = git(seed, ['rev-parse', 'HEAD']);

  const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-workspace-'));
  git(workspace, ['clone', bare, '.']);
  git(workspace, ['config', 'user.email', 'test@example.com']);
  git(workspace, ['config', 'user.name', 'Test User']);
  git(workspace, ['remote', 'set-url', '--push', 'origin', 'https://github.com/happier-dev/happier.git']);
  git(workspace, ['checkout', 'main']);

  return { workspace, featureHead };
}

function createGithubForkPullRefFixture(): { workspace: string; featureHead: string; pullNumber: number; headBranch: string } {
  const pullNumber = 44;
  const headBranch = 'feature/fork-pr-branch';
  const bare = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-fork-origin-'));
  git(bare, ['init', '--bare']);

  const seed = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-fork-seed-'));
  git(seed, ['init']);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test User']);
  git(seed, ['branch', '-M', 'main']);
  writeFileSync(join(seed, 'base.txt'), 'base\n');
  git(seed, ['add', 'base.txt']);
  git(seed, ['commit', '-m', 'base']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', 'origin', 'main']);
  git(seed, ['checkout', '-b', headBranch]);
  writeFileSync(join(seed, 'base.txt'), 'fork pull ref\n');
  git(seed, ['commit', '-am', 'fork pull ref']);
  git(seed, ['push', 'origin', `HEAD:refs/pull/${pullNumber}/head`]);
  const featureHead = git(seed, ['rev-parse', 'HEAD']);

  const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-fork-workspace-'));
  git(workspace, ['clone', bare, '.']);
  git(workspace, ['config', 'user.email', 'test@example.com']);
  git(workspace, ['config', 'user.name', 'Test User']);
  git(workspace, ['remote', 'set-url', '--push', 'origin', 'https://github.com/happier-dev/happier.git']);
  git(workspace, ['checkout', 'main']);

  return { workspace, featureHead, pullNumber, headBranch };
}

describe('git pull request RPC handlers', () => {
  const envKeys = ['PATH', 'HOME', 'USERPROFILE'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    vi.unstubAllGlobals();
    envScope = createEnvKeyScope(envKeys);
  });

  it('opens a compare URL from the detected hosting provider without auth', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    git(workspace, ['add', 'base.txt']);
    git(workspace, ['commit', '-m', 'base']);
    git(workspace, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestOpenComposeResponse, ScmPullRequestOpenComposeRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
      {
        cwd: '.',
        base: 'main',
        head: 'feature/pr-support',
      },
    );

    expect(response).toEqual({
      success: true,
      url: 'https://github.com/happier-dev/happier/compare/main...feature%2Fpr-support',
    });
  });

  it('creates a pull request through authenticated local gh when no connected account is required', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-gh-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    git(workspace, ['add', 'base.txt']);
    git(workspace, ['commit', '-m', 'base']);
    git(workspace, ['checkout', '-b', 'feature/pr-support']);
    git(workspace, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);

    const ghShim = await writeExecutableShim({
      dir: workspace,
      fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
      contents: process.platform === 'win32'
        ? [
          '@echo off',
          'if "%1"=="auth" if "%2"=="status" exit /b 0',
          'if "%1"=="pr" if "%2"=="list" (echo []& exit /b 0)',
          'if "%1"=="pr" if "%2"=="create" (echo https://github.com/happier-dev/happier/pull/42& exit /b 0)',
          'if "%1"=="pr" if "%2"=="view" (echo {"number":42,"title":"Ship PR support","url":"https://github.com/happier-dev/happier/pull/42","state":"OPEN","baseRefName":"main","headRefName":"feature/pr-support"}& exit /b 0)',
          'exit /b 1',
        ].join('\r\n')
        : [
          '#!/bin/sh',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
          'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo \'[]\'; exit 0; fi',
          'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/happier-dev/happier/pull/42"; exit 0; fi',
          'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo \'{"number":42,"title":"Ship PR support","url":"https://github.com/happier-dev/happier/pull/42","state":"OPEN","baseRefName":"main","headRefName":"feature/pr-support"}\'; exit 0; fi',
          'exit 1',
        ].join('\n'),
    });
    expect(ghShim).toContain(workspace);
    envScope.patch({
      PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HOME: workspace,
      USERPROFILE: workspace,
    });

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestOpenOrReuseResponse, ScmPullRequestOpenOrReuseRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
      {
        cwd: '.',
        base: 'main',
        head: 'feature/pr-support',
        title: 'Ship PR support',
        body: 'Implements PR management.',
      },
    );

    expect(response).toEqual({
      success: true,
      kind: 'opened',
      reused: false,
      pullRequest: {
        provider: {
          kind: 'github',
          name: 'GitHub',
          baseUrl: 'https://github.com',
          nameWithOwner: 'happier-dev/happier',
          remoteName: 'origin',
        },
        number: 42,
        title: 'Ship PR support',
        url: 'https://github.com/happier-dev/happier/pull/42',
        baseBranch: 'main',
        headBranch: 'feature/pr-support',
        state: 'open',
      },
    });

    const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
      RPC_METHODS.SCM_STATUS_SNAPSHOT,
      { cwd: '.' },
    );
    expect(status.success && status.snapshot?.pullRequest).toMatchObject({
      number: 42,
      title: 'Ship PR support',
      headBranch: 'feature/pr-support',
    });
  });

  it('creates a pull request through a connected GitHub account before local gh fallback', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-rest-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    git(workspace, ['add', 'base.txt']);
    git(workspace, ['commit', '-m', 'base']);
    git(workspace, ['checkout', '-b', 'feature/connected-rest']);
    git(workspace, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);

    await writeExecutableShim({
      dir: workspace,
      fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
      contents: process.platform === 'win32'
        ? [
          '@echo off',
          'if "%1"=="auth" if "%2"=="status" exit /b 0',
          'if "%1"=="pr" if "%2"=="create" (echo local gh should not be called 1>&2& exit /b 1)',
          'exit /b 1',
        ].join('\r\n')
        : [
          '#!/bin/sh',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
          'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "local gh should not be called" >&2; exit 1; fi',
          'exit 1',
        ].join('\n'),
    });
    envScope.patch({
      PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HOME: workspace,
      USERPROFILE: workspace,
    });
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => [],
          text: async (): Promise<string> => '',
        };
      }
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        json: async () => ({
          number: 52,
          title: 'Ship connected account PRs',
          html_url: 'https://github.com/happier-dev/happier/pull/52',
          state: 'open',
          base: { ref: 'main' },
          head: { ref: 'feature/connected-rest' },
          merged_at: null,
        }),
        text: async (): Promise<string> => '',
      };
    });
    vi.stubGlobal('fetch', fetcher);
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'github',
      profileId: 'primary',
      kind: 'token',
      token: {
        token: 'ghp_rest',
        providerAccountId: '42',
        providerEmail: 'octo@example.com',
      },
    });

    const { call } = createTestRpcManager({
      workingDirectory: workspace,
      connectedAccounts: {
        resolveCredential: async (serviceId) => serviceId === 'github' ? record : null,
      },
    });
    const response = await call<ScmPullRequestOpenOrReuseResponse, ScmPullRequestOpenOrReuseRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
      {
        cwd: '.',
        base: 'main',
        head: 'feature/connected-rest',
        title: 'Ship connected account PRs',
        body: 'Uses connected GitHub credentials.',
      },
    );

    expect(response).toEqual({
      success: true,
      kind: 'opened',
      reused: false,
      pullRequest: {
        provider: {
          kind: 'github',
          name: 'GitHub',
          baseUrl: 'https://github.com',
          nameWithOwner: 'happier-dev/happier',
          remoteName: 'origin',
        },
        number: 52,
        title: 'Ship connected account PRs',
        url: 'https://github.com/happier-dev/happier/pull/52',
        baseBranch: 'main',
        headBranch: 'feature/connected-rest',
        state: 'open',
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/repos/happier-dev/happier/pulls'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer ghp_rest',
        }),
      }),
    );
  });

  it('lists pull requests through authenticated local gh and caches the current branch status', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-list-gh-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    git(workspace, ['add', 'base.txt']);
    git(workspace, ['commit', '-m', 'base']);
    git(workspace, ['checkout', '-b', 'feature/pr-support']);
    git(workspace, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);

    await writeExecutableShim({
      dir: workspace,
      fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
      contents: process.platform === 'win32'
        ? [
          '@echo off',
          'if "%1"=="auth" if "%2"=="status" exit /b 0',
          'if "%1"=="pr" if "%2"=="list" (echo [{"number":43,"title":"Existing PR","url":"https://github.com/happier-dev/happier/pull/43","state":"OPEN","baseRefName":"main","headRefName":"feature/pr-support"}]& exit /b 0)',
          'exit /b 1',
        ].join('\r\n')
        : [
          '#!/bin/sh',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
          'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo \'[{"number":43,"title":"Existing PR","url":"https://github.com/happier-dev/happier/pull/43","state":"OPEN","baseRefName":"main","headRefName":"feature/pr-support"}]\'; exit 0; fi',
          'exit 1',
        ].join('\n'),
    });
    envScope.patch({
      PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HOME: workspace,
      USERPROFILE: workspace,
    });

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestListResponse, ScmPullRequestListRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_LIST,
      {
        cwd: '.',
        base: 'main',
        head: 'feature/pr-support',
      },
    );

    expect(response).toEqual({
      success: true,
      pullRequests: [{
        provider: {
          kind: 'github',
          name: 'GitHub',
          baseUrl: 'https://github.com',
          nameWithOwner: 'happier-dev/happier',
          remoteName: 'origin',
        },
        number: 43,
        title: 'Existing PR',
        url: 'https://github.com/happier-dev/happier/pull/43',
        baseBranch: 'main',
        headBranch: 'feature/pr-support',
        state: 'open',
      }],
    });

    const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
      RPC_METHODS.SCM_STATUS_SNAPSHOT,
      { cwd: '.' },
    );
    expect(status.success && status.snapshot?.pullRequest).toMatchObject({
      number: 43,
      title: 'Existing PR',
    });
  });

  it('gets a pull request through authenticated local gh', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-pr-get-gh-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    git(workspace, ['add', 'base.txt']);
    git(workspace, ['commit', '-m', 'base']);
    git(workspace, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);

    await writeExecutableShim({
      dir: workspace,
      fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
      contents: process.platform === 'win32'
        ? [
          '@echo off',
          'if "%1"=="auth" if "%2"=="status" exit /b 0',
          'if "%1"=="pr" if "%2"=="view" (echo {"number":44,"title":"Inspect PR","url":"https://github.com/happier-dev/happier/pull/44","state":"OPEN","baseRefName":"main","headRefName":"feature/inspect"}& exit /b 0)',
          'exit /b 1',
        ].join('\r\n')
        : [
          '#!/bin/sh',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
          'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo \'{"number":44,"title":"Inspect PR","url":"https://github.com/happier-dev/happier/pull/44","state":"OPEN","baseRefName":"main","headRefName":"feature/inspect"}\'; exit 0; fi',
          'exit 1',
        ].join('\n'),
    });
    envScope.patch({
      PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HOME: workspace,
      USERPROFILE: workspace,
    });

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestGetResponse, ScmPullRequestGetRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_GET,
      {
        cwd: '.',
        prReference: { number: 44 },
      },
    );

    expect(response).toEqual({
      success: true,
      pullRequest: {
        provider: {
          kind: 'github',
          name: 'GitHub',
          baseUrl: 'https://github.com',
          nameWithOwner: 'happier-dev/happier',
          remoteName: 'origin',
        },
        number: 44,
        title: 'Inspect PR',
        url: 'https://github.com/happier-dev/happier/pull/44',
        baseBranch: 'main',
        headBranch: 'feature/inspect',
        state: 'open',
      },
    });
  });

  it('checks out a pull request head branch from the detected provider remote', async () => {
    const { workspace, featureHead } = createGithubBackedRemoteFixture();

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestCheckoutResponse, ScmPullRequestCheckoutRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
      {
        cwd: '.',
        prReference: { headBranch: 'feature/pr-branch' },
      },
    );

    expect(response).toEqual({
      success: true,
      branch: 'feature/pr-branch',
      headSha: featureHead,
      baseSha: null,
    });
    expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/pr-branch');
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(featureHead);
  });

  it('fails safely when a same-named local branch does not match the fetched pull request tip', async () => {
    const { workspace, featureHead } = createGithubBackedRemoteFixture();
    git(workspace, ['checkout', '-b', 'feature/pr-branch']);
    writeFileSync(join(workspace, 'stale.txt'), 'stale local branch\n');
    git(workspace, ['add', 'stale.txt']);
    git(workspace, ['commit', '-m', 'stale local branch']);
    const staleHead = git(workspace, ['rev-parse', 'HEAD']);
    expect(staleHead).not.toBe(featureHead);
    git(workspace, ['checkout', 'main']);

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestCheckoutResponse, ScmPullRequestCheckoutRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
      {
        cwd: '.',
        prReference: { headBranch: 'feature/pr-branch' },
      },
    );

    expect(response.success).toBe(false);
    if (response.success) return;
    expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(workspace, ['rev-parse', 'feature/pr-branch'])).toBe(staleHead);
  });

  it('blocks pull request checkout when dirty files would be overwritten without creating a stash', async () => {
    const { workspace } = createGithubBackedRemoteFixture();
    writeFileSync(join(workspace, 'base.txt'), 'local dirty edit\n');

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestCheckoutResponse, ScmPullRequestCheckoutRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
      {
        cwd: '.',
        prReference: { headBranch: 'feature/pr-branch' },
      },
    );

    expect(response.success).toBe(false);
    if (response.success) return;
    expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(workspace, ['stash', 'list'])).not.toContain('happier');
  });

  it('checks out GitHub fork pull requests from provider-owned pull refs instead of assuming a remote branch', async () => {
    const { workspace, featureHead, pullNumber, headBranch } = createGithubForkPullRefFixture();

    await writeExecutableShim({
      dir: workspace,
      fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
      contents: process.platform === 'win32'
        ? [
          '@echo off',
          'if "%1"=="auth" if "%2"=="status" exit /b 0',
          `if "%1"=="pr" if "%2"=="view" (echo {"number":${pullNumber},"title":"Fork PR","url":"https://github.com/happier-dev/happier/pull/${pullNumber}","state":"OPEN","baseRefName":"main","headRefName":"${headBranch}"}& exit /b 0)`,
          'exit /b 1',
        ].join('\r\n')
        : [
          '#!/bin/sh',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":${pullNumber},"title":"Fork PR","url":"https://github.com/happier-dev/happier/pull/${pullNumber}","state":"OPEN","baseRefName":"main","headRefName":"${headBranch}"}'; exit 0; fi`,
          'exit 1',
        ].join('\n'),
    });
    envScope.patch({
      PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HOME: workspace,
      USERPROFILE: workspace,
    });

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestCheckoutResponse, ScmPullRequestCheckoutRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_CHECKOUT,
      {
        cwd: '.',
        prReference: { number: pullNumber },
      },
    );

    expect(response).toEqual({
      success: true,
      branch: headBranch,
      headSha: featureHead,
      baseSha: null,
    });
    expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(headBranch);
    expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(featureHead);
  });

  it('prepares a pull request linked worktree without mutating dirty source changes', async () => {
    const { workspace, featureHead } = createGithubBackedRemoteFixture();
    writeFileSync(join(workspace, 'local.txt'), 'dirty source file\n');

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestPrepareWorktreeResponse, ScmPullRequestPrepareWorktreeRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
      {
        cwd: '.',
        sourcePath: workspace,
        mode: 'worktree',
        prReference: { headBranch: 'feature/pr-branch' },
      },
    );

    expect(response).toMatchObject({
      success: true,
      branch: 'feature/pr-branch',
      head: featureHead,
    });
    if (!response.success) return;
    expect(response.targetPath).toContain('/.dev/worktree/feature/pr-branch');
    expect(git(response.targetPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature/pr-branch');
    expect(git(response.targetPath, ['rev-parse', 'HEAD'])).toBe(featureHead);
    expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('prepares a worktree for GitHub fork pull requests from provider-owned pull refs', async () => {
    const { workspace, featureHead, pullNumber, headBranch } = createGithubForkPullRefFixture();

    await writeExecutableShim({
      dir: workspace,
      fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
      contents: process.platform === 'win32'
        ? [
          '@echo off',
          'if "%1"=="auth" if "%2"=="status" exit /b 0',
          `if "%1"=="pr" if "%2"=="view" (echo {"number":${pullNumber},"title":"Fork PR","url":"https://github.com/happier-dev/happier/pull/${pullNumber}","state":"OPEN","baseRefName":"main","headRefName":"${headBranch}"}& exit /b 0)`,
          'exit /b 1',
        ].join('\r\n')
        : [
          '#!/bin/sh',
          'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
          `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo '{"number":${pullNumber},"title":"Fork PR","url":"https://github.com/happier-dev/happier/pull/${pullNumber}","state":"OPEN","baseRefName":"main","headRefName":"${headBranch}"}'; exit 0; fi`,
          'exit 1',
        ].join('\n'),
    });
    envScope.patch({
      PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      HOME: workspace,
      USERPROFILE: workspace,
    });

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestPrepareWorktreeResponse, ScmPullRequestPrepareWorktreeRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_PREPARE_WORKTREE,
      {
        cwd: '.',
        sourcePath: workspace,
        mode: 'worktree',
        prReference: { number: pullNumber },
      },
    );

    expect(response).toMatchObject({
      success: true,
      branch: headBranch,
      head: featureHead,
    });
    if (!response.success) return;
    expect(git(response.targetPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(headBranch);
    expect(git(response.targetPath, ['rev-parse', 'HEAD'])).toBe(featureHead);
  });

  it('runs a stacked commit and push through the SCM RPC handler on an upstream branch', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'happier-git-rpc-stacked-origin-'));
    git(bare, ['init', '--bare']);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-stacked-workspace-'));
    git(workspace, ['clone', bare, '.']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    git(workspace, ['branch', '-M', 'main']);
    writeFileSync(join(workspace, 'base.txt'), 'base\n');
    git(workspace, ['add', 'base.txt']);
    git(workspace, ['commit', '-m', 'base']);
    git(workspace, ['push', '-u', 'origin', 'main']);
    git(workspace, ['checkout', '-b', 'feature/stacked-rpc']);
    git(workspace, ['push', '-u', 'origin', 'feature/stacked-rpc']);
    writeFileSync(join(workspace, 'stacked.txt'), 'stacked\n');

    const { call } = createTestRpcManager({ workingDirectory: workspace });
    const response = await call<ScmPullRequestRunStackedResponse, ScmPullRequestRunStackedRequest>(
      RPC_METHODS.SCM_PULL_REQUEST_RUN_STACKED,
      {
        cwd: '.',
        action: 'commitPush',
        commitMessage: 'Ship stacked RPC workflow',
        filePaths: ['stacked.txt'],
      },
    );

    expect(response).toMatchObject({
      success: true,
      branch: 'feature/stacked-rpc',
    });
    if (!response.success) return;
    expect(response.commitSha).toBeTruthy();
    expect(response.events.map((event) => event.kind)).toEqual([
      'action_started',
      'phase_started',
      'phase_started',
      'action_finished',
    ]);
    expect(response.events.map((event) => event.phase)).toEqual([
      undefined,
      'commit',
      'push',
      undefined,
    ]);
    expect(git(workspace, ['status', '--short'])).toBe('');
    expect(git(bare, ['rev-parse', 'feature/stacked-rpc'])).toBe(git(workspace, ['rev-parse', 'HEAD']));
  });
});
