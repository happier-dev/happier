import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScmRepoMode } from '@happier-dev/protocol';

export type ScmExecutableAvailability = Readonly<{
    available: boolean;
    executable: string;
    diagnostic: string | null;
}>;

export type ScmBackendRepositoryFixture = Readonly<{
    rootPath: string;
    nestedPath: string;
    trackedPath: string;
    ignoredPath: string;
    branchName: string;
    headCommit: string;
}>;

const TEST_USER_EMAIL = 'test@example.com';
const TEST_USER_NAME = 'Happier Test';
const DEFAULT_CONTRACT_BRANCH = 'contract/default';

export function checkExecutableAvailability(executable: string): ScmExecutableAvailability {
    const probe = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.error) {
        return {
            available: false,
            executable,
            diagnostic: probe.error.message,
        };
    }
    return {
        available: true,
        executable,
        diagnostic: null,
    };
}

export function createScmContractTempDirectory(prefix: string): string {
    const filesystemSafePrefix = prefix.replace(/[^a-zA-Z0-9._-]/gu, '-');
    return mkdtempSync(join(tmpdir(), filesystemSafePrefix));
}

export function runScmExecutable(cwd: string, executable: string, args: readonly string[]): string {
    return execFileSync(executable, [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

export function createLocalScmRepositoryFixture(input: {
    executable: string;
    repoMode: ScmRepoMode;
    prefix: string;
}): ScmBackendRepositoryFixture {
    if (input.repoMode === '.git') {
        return createGitRepositoryFixture(input.prefix);
    }
    return createSaplingRepositoryFixture(input.prefix);
}

export function createUnsupportedScmBackendMethodFixture(prefix: string): ScmBackendRepositoryFixture {
    const rootPath = createScmContractTempDirectory(prefix);
    mkdirSync(join(rootPath, 'nested'), { recursive: true });
    return {
        rootPath: realpathSync(rootPath),
        nestedPath: join(rootPath, 'nested'),
        trackedPath: 'tracked.txt',
        ignoredPath: 'ignored.ignored',
        branchName: 'contract/default',
        headCommit: '0000000000000000000000000000000000000000',
    };
}

export function createBareGitRemoteFixture(prefix: string): Readonly<{
    remotePath: string;
    defaultBranch: string;
}> {
    const remotePath = createScmContractTempDirectory(prefix);
    runScmExecutable(remotePath, 'git', ['init', '--bare']);
    const defaultBranch = 'release/contract-default';
    runScmExecutable(remotePath, 'git', ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
    return {
        remotePath,
        defaultBranch,
    };
}

function configureGitUser(rootPath: string): void {
    runScmExecutable(rootPath, 'git', ['config', 'user.email', TEST_USER_EMAIL]);
    runScmExecutable(rootPath, 'git', ['config', 'user.name', TEST_USER_NAME]);
}

function createGitRepositoryFixture(prefix: string): ScmBackendRepositoryFixture {
    const rootPath = createScmContractTempDirectory(prefix);
    runScmExecutable(rootPath, 'git', ['init']);
    runScmExecutable(rootPath, 'git', ['symbolic-ref', 'HEAD', `refs/heads/${DEFAULT_CONTRACT_BRANCH}`]);
    configureGitUser(rootPath);
    writeFileSync(join(rootPath, '.gitignore'), '*.ignored\n');
    writeFileSync(join(rootPath, 'tracked.txt'), 'base\n');
    writeFileSync(join(rootPath, 'ignored.ignored'), 'ignored\n');
    mkdirSync(join(rootPath, 'nested'), { recursive: true });
    runScmExecutable(rootPath, 'git', ['add', '.gitignore', 'tracked.txt']);
    runScmExecutable(rootPath, 'git', ['commit', '-m', 'initial']);
    const headCommit = runScmExecutable(rootPath, 'git', ['rev-parse', 'HEAD']);
    return {
        rootPath: realpathSync(rootPath),
        nestedPath: join(rootPath, 'nested'),
        trackedPath: 'tracked.txt',
        ignoredPath: 'ignored.ignored',
        branchName: DEFAULT_CONTRACT_BRANCH,
        headCommit,
    };
}

function createSaplingRepositoryFixture(prefix: string): ScmBackendRepositoryFixture {
    const rootPath = createScmContractTempDirectory(prefix);
    runScmExecutable(rootPath, 'sl', ['init']);
    runScmExecutable(rootPath, 'sl', ['config', '--local', 'ui.username', `${TEST_USER_NAME} <${TEST_USER_EMAIL}>`]);
    writeFileSync(join(rootPath, '.gitignore'), '*.ignored\n');
    writeFileSync(join(rootPath, 'tracked.txt'), 'base\n');
    writeFileSync(join(rootPath, 'ignored.ignored'), 'ignored\n');
    mkdirSync(join(rootPath, 'nested'), { recursive: true });
    runScmExecutable(rootPath, 'sl', ['add', '.gitignore', 'tracked.txt']);
    runScmExecutable(rootPath, 'sl', ['commit', '-m', 'initial']);
    const headCommit = runScmExecutable(rootPath, 'sl', ['whereami']);
    return {
        rootPath: realpathSync(rootPath),
        nestedPath: join(rootPath, 'nested'),
        trackedPath: 'tracked.txt',
        ignoredPath: 'ignored.ignored',
        branchName: DEFAULT_CONTRACT_BRANCH,
        headCommit,
    };
}
