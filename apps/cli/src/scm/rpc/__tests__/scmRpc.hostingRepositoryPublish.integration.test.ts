import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ScmRemoteInfo, ScmWorkingSnapshot } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

type ScmHostingRepositoryPublishResponse = Readonly<{
    success: boolean;
    repository?: Readonly<{
        nameWithOwner: string;
        url: string;
        cloneUrl?: string;
        sshUrl?: string;
        visibility: string;
    }>;
    remote?: ScmRemoteInfo;
    pushed?: boolean;
    snapshot?: ScmWorkingSnapshot;
    error?: string;
    errorCode?: string;
}>;

type ScmHostingRepositoryDescribePublishTargetsResponse = Readonly<{
    success: boolean;
    targets?: readonly Readonly<{
        providerKind: string;
        owner: string;
        ownerKind: string;
        supportedVisibilities: readonly string[];
    }>[];
    auth?: Readonly<{
        kind: string;
        authenticated: boolean;
    }>;
    error?: string;
    errorCode?: string;
}>;

function scmMethod(key: string): string {
    return (RPC_METHODS as Record<string, string>)[key] ?? '';
}

function createCommittedGitRepository(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-publish-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    git(workspace, ['branch', '-M', 'main']);
    writeFileSync(join(workspace, 'README.md'), '# Project\n');
    git(workspace, ['add', 'README.md']);
    git(workspace, ['commit', '-m', 'initial commit']);
    return workspace;
}

async function installGithubCliShim(input: Readonly<{
    binDir: string;
    repositoryPath: string;
}>): Promise<void> {
    const escapedRepositoryPath = input.repositoryPath.replaceAll('\\', '\\\\');
    await writeExecutableShim({
        dir: input.binDir,
        fileName: process.platform === 'win32' ? 'gh.cmd' : 'gh',
        contents: process.platform === 'win32'
            ? [
                '@echo off',
                'if "%1"=="auth" if "%2"=="status" exit /b 0',
                'if "%1"=="api" if "%2"=="user" (echo {"login":"happier-dev"}& exit /b 0)',
                'if "%1"=="api" if "%2"=="user/orgs" (echo []& exit /b 0)',
                'if "%1"=="repo" if "%2"=="create" (',
                '  echo %* | findstr /C:"--source" /C:"--remote" /C:"--push" >nul && exit /b 9',
                '  exit /b 0',
                ')',
                'if "%1"=="repo" if "%2"=="view" (',
                `  echo {"nameWithOwner":"happier-dev/published-repo","url":"https://github.com/happier-dev/published-repo","sshUrl":"${escapedRepositoryPath}","defaultBranchRef":{"name":"main"},"visibility":"PRIVATE"}`,
                '  exit /b 0',
                ')',
                'exit /b 1',
            ].join('\r\n')
            : [
                '#!/bin/sh',
                'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
                'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo \'{"login":"happier-dev"}\'; exit 0; fi',
                'if [ "$1" = "api" ] && [ "$2" = "user/orgs" ]; then echo \'[]\'; exit 0; fi',
                'if [ "$1" = "repo" ] && [ "$2" = "create" ]; then',
                '  for arg in "$@"; do',
                '    if [ "$arg" = "--source" ] || [ "$arg" = "--remote" ] || [ "$arg" = "--push" ]; then',
                '      echo "forbidden gh repo create arg: $arg" >&2',
                '      exit 9',
                '    fi',
                '  done',
                '  exit 0',
                'fi',
                'if [ "$1" = "repo" ] && [ "$2" = "view" ]; then',
                `  printf '%s\\n' '{"nameWithOwner":"happier-dev/published-repo","url":"https://github.com/happier-dev/published-repo","sshUrl":"${escapedRepositoryPath}","defaultBranchRef":{"name":"main"},"visibility":"PRIVATE"}'`,
                '  exit 0',
                'fi',
                'exit 1',
            ].join('\n'),
    });
}

describe('git hosting repository publish RPC handlers', () => {
    const envKeys = ['PATH', 'HOME', 'USERPROFILE'] as const;
    let envScope = createEnvKeyScope(envKeys);

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
    });

    it('describes GitHub publish targets before the folder is initialized as a repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-publish-preinit-'));
        writeFileSync(join(workspace, 'README.md'), '# Project\n');
        await installGithubCliShim({ binDir: workspace, repositoryPath: workspace });
        envScope.patch({
            PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
            HOME: workspace,
            USERPROFILE: workspace,
        });

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryDescribePublishTargetsResponse, { cwd: string; providerKind: string }>(
            scmMethod('SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS'),
            { cwd: '.', providerKind: 'github' }
        );

        expect(response.success).toBe(true);
        expect(response.auth).toMatchObject({ kind: 'gh-cli', authenticated: true });
        expect(response.targets?.[0]).toMatchObject({
            providerKind: 'github',
            owner: 'happier-dev',
            ownerKind: 'user',
        });
    });

    it('describes GitHub publish targets from authenticated local gh when no connected account is bound', async () => {
        const workspace = createCommittedGitRepository();
        await installGithubCliShim({ binDir: workspace, repositoryPath: workspace });
        envScope.patch({
            PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
            HOME: workspace,
            USERPROFILE: workspace,
        });

        expect(scmMethod('SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS')).toBe(
            'scm.hostingRepository.describePublishTargets'
        );

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryDescribePublishTargetsResponse, { cwd: string; providerKind: string }>(
            scmMethod('SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS'),
            { cwd: '.', providerKind: 'github' }
        );

        expect(response.success).toBe(true);
        expect(response.auth).toMatchObject({ kind: 'gh-cli', authenticated: true });
        expect(response.targets?.[0]).toMatchObject({
            providerKind: 'github',
            owner: 'happier-dev',
            ownerKind: 'user',
        });
    });

    it('creates a GitHub repository through gh, adds origin, and pushes the current branch', async () => {
        const workspace = createCommittedGitRepository();
        const bareRemote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-publish-origin-'));
        git(bareRemote, ['init', '--bare']);
        await installGithubCliShim({ binDir: workspace, repositoryPath: bareRemote });
        envScope.patch({
            PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
            HOME: workspace,
            USERPROFILE: workspace,
        });

        expect(scmMethod('SCM_HOSTING_REPOSITORY_PUBLISH')).toBe('scm.hostingRepository.publish');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryPublishResponse, {
            cwd: string;
            providerKind: string;
            owner: string;
            ownerKind: string;
            repositoryName: string;
            visibility: string;
            remoteName: string;
            remoteUrlKind: string;
            remoteConflictStrategy: string;
            pushCurrentBranch: boolean;
        }>(
            scmMethod('SCM_HOSTING_REPOSITORY_PUBLISH'),
            {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                repositoryName: 'published-repo',
                visibility: 'private',
                remoteName: 'origin',
                remoteUrlKind: 'ssh',
                remoteConflictStrategy: 'fail',
                pushCurrentBranch: true,
            }
        );

        expect(response.success).toBe(true);
        expect(response.repository?.nameWithOwner).toBe('happier-dev/published-repo');
        expect(response.remote).toMatchObject({
            name: 'origin',
            fetchUrl: bareRemote,
        });
        expect(response.pushed).toBe(true);
        expect(git(workspace, ['remote', 'get-url', 'origin'])).toBe(bareRemote);
        expect(git(bareRemote, ['show-ref', '--verify', 'refs/heads/main'])).toContain('refs/heads/main');
    });

    it('does not create a remote repository when push is requested before the first commit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-publish-unborn-'));
        git(workspace, ['init']);
        await installGithubCliShim({ binDir: workspace, repositoryPath: workspace });
        envScope.patch({
            PATH: [workspace, process.env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
            HOME: workspace,
            USERPROFILE: workspace,
        });

        expect(scmMethod('SCM_HOSTING_REPOSITORY_PUBLISH')).toBe('scm.hostingRepository.publish');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryPublishResponse, {
            cwd: string;
            providerKind: string;
            owner: string;
            ownerKind: string;
            repositoryName: string;
            visibility: string;
            pushCurrentBranch: boolean;
        }>(
            scmMethod('SCM_HOSTING_REPOSITORY_PUBLISH'),
            {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                repositoryName: 'published-repo',
                visibility: 'private',
                pushCurrentBranch: true,
            }
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
        });
    });

});
