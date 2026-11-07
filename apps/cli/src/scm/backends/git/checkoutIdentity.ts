import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { runScmCommand } from '../../runtime';
import { buildScmNonInteractiveEnv } from '../shared/nonInteractiveEnv';
import { parseGitWorktreeListRecords } from './worktreeListParser';
import { logger } from '@/ui/logger';

function readGitPathOutput(stdout: string): string {
    return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

/** A separate git-dir can occupy the first registration without being a checkout. */
export async function resolveGitMainWorktreePath(input: Readonly<{
    worktreesOutput: string;
    currentWorktreePath: string | null;
}>): Promise<string | null> {
    const main = parseGitWorktreeListRecords(input.worktreesOutput)[0];
    if (!main) return null;
    if (main.bare || main.path === input.currentWorktreePath) return main.path;
    const proof = await runScmCommand({ bin: 'git', cwd: main.path,
        args: ['rev-parse', '--show-toplevel'], env: buildScmNonInteractiveEnv({ LC_ALL: 'C' }) });
    if (proof.success) return readGitPathOutput(proof.stdout) === main.path ? main.path : null;
    if (!/not a git repository|must be run in a work tree/i.test(proof.stderr)) {
        logger.infoFile('[sessionRepository] Main checkout inspection unavailable', { path: main.path, error: proof.stderr });
    }
    return null;
}

export async function inspectGitRepositoryIdentity(params: Readonly<{ cwd: string }>): Promise<Readonly<{
    rootPath: string;
    worktreePath: string;
}> | null> {
    const env = buildScmNonInteractiveEnv({ LC_ALL: 'C' });
    const listed = await runScmCommand({ bin: 'git', cwd: params.cwd,
        args: ['worktree', 'list', '--porcelain', '-z'], env });
    if (!listed.success) {
        if (/not a git repository/i.test(listed.stderr)) return null;
        throw new Error(`Git repository inspection unavailable: ${listed.stderr}`);
    }
    const checkout = await runScmCommand({ bin: 'git', cwd: params.cwd,
        args: ['rev-parse', '--show-toplevel'], env });
    let worktreePath: string;
    if (checkout.success) {
        worktreePath = readGitPathOutput(checkout.stdout);
    } else {
        const bare = await runScmCommand({ bin: 'git', cwd: params.cwd,
            args: ['rev-parse', '--is-bare-repository'], env });
        const main = parseGitWorktreeListRecords(listed.stdout)[0];
        if (!bare.success || bare.stdout.trim() !== 'true' || !main?.bare) {
            throw new Error(`Git checkout inspection unavailable: ${checkout.stderr}`);
        }
        worktreePath = main.path;
    }
    const rootPath = await resolveGitMainWorktreePath({ worktreesOutput: listed.stdout, currentWorktreePath: worktreePath });
    return rootPath ? { rootPath, worktreePath } : null;
}

export type GitCheckoutIdentity = Readonly<{
    branchName: string | null;
    headRevision: string | null;
    gitDirPath: string;
    commonDirPath: string;
    worktreePath: string;
    registeredWorktreePath: string;
}>;

export function isGitLinkedWorktreeIdentity(identity: GitCheckoutIdentity): boolean {
    return identity.gitDirPath !== identity.commonDirPath;
}

async function readGitValue(cwd: string, args: string[]): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd,
        args,
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) {
        return null;
    }

    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
}

async function readGitAbsolutePathValue(input: Readonly<{
    cwd: string;
    pathArgs: string[];
}>): Promise<string | null> {
    const absoluteValue = await readGitValue(input.cwd, ['rev-parse', '--path-format=absolute', ...input.pathArgs]);
    if (absoluteValue) {
        return absoluteValue;
    }

    const fallbackValue = await readGitValue(input.cwd, ['rev-parse', ...input.pathArgs]);
    if (!fallbackValue) {
        return null;
    }

    return isAbsolute(fallbackValue) ? fallbackValue : resolve(input.cwd, fallbackValue);
}

async function readRegisteredWorktreePath(input: Readonly<{
    gitDirPath: string;
    commonDirPath: string;
    worktreePath: string;
}>): Promise<string> {
    if (input.gitDirPath === input.commonDirPath) {
        return input.worktreePath;
    }

    try {
        const rawGitFilePath = (await readFile(join(input.gitDirPath, 'gitdir'), 'utf8')).trim();
        if (!rawGitFilePath) {
            return input.worktreePath;
        }

        const gitFilePath = isAbsolute(rawGitFilePath)
            ? rawGitFilePath
            : resolve(input.gitDirPath, rawGitFilePath);
        return dirname(gitFilePath);
    } catch {
        return input.worktreePath;
    }
}

function resolveGitAdminPath(cwd: string, rawGitFileContents: string): string | null {
    const gitdirPrefix = 'gitdir:';
    if (!rawGitFileContents.startsWith(gitdirPrefix)) {
        return null;
    }

    const gitDirValue = rawGitFileContents.slice(gitdirPrefix.length).trim();
    if (!gitDirValue) {
        return null;
    }

    return isAbsolute(gitDirValue) ? gitDirValue : resolve(cwd, gitDirValue);
}

async function inspectGitCheckoutIdentityFromAdminFiles(cwd: string): Promise<GitCheckoutIdentity | null> {
    try {
        const gitFileContents = await readFile(join(cwd, '.git'), 'utf8');
        const gitDirPath = resolveGitAdminPath(cwd, gitFileContents.trim());
        if (!gitDirPath) {
            return null;
        }

        const commonDirValue = (await readFile(join(gitDirPath, 'commondir'), 'utf8')).trim();
        const commonDirPath = commonDirValue
            ? (isAbsolute(commonDirValue) ? commonDirValue : resolve(gitDirPath, commonDirValue))
            : gitDirPath;
        const headValue = (await readFile(join(gitDirPath, 'HEAD'), 'utf8')).trim();
        const branchName = headValue.startsWith('ref: refs/heads/')
            ? headValue.slice('ref: refs/heads/'.length)
            : null;
        const headRevision = branchName
            ? (await readFile(join(commonDirPath, 'refs', 'heads', branchName), 'utf8')).trim() || null
            : /^[0-9a-f]{40}$/i.test(headValue)
                ? headValue
                : null;
        const registeredWorktreePath = await readRegisteredWorktreePath({
            gitDirPath,
            commonDirPath,
            worktreePath: cwd,
        });

        return {
            branchName,
            headRevision,
            gitDirPath,
            commonDirPath,
            worktreePath: cwd,
            registeredWorktreePath,
        };
    } catch {
        return null;
    }
}

export async function inspectGitCheckoutIdentity(params: Readonly<{
    cwd: string;
}>): Promise<GitCheckoutIdentity | null> {
    const [headRevision, rawBranchName, gitDirPath, commonDirPath, worktreePath] = await Promise.all([
        readGitValue(params.cwd, ['rev-parse', '--verify', 'HEAD']),
        readGitValue(params.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        readGitAbsolutePathValue({ cwd: params.cwd, pathArgs: ['--git-dir'] }),
        readGitAbsolutePathValue({ cwd: params.cwd, pathArgs: ['--git-common-dir'] }),
        readGitAbsolutePathValue({ cwd: params.cwd, pathArgs: ['--show-toplevel'] }),
    ]);

    if (!gitDirPath || !commonDirPath || !worktreePath) {
        return await inspectGitCheckoutIdentityFromAdminFiles(params.cwd);
    }

    const registeredWorktreePath = await readRegisteredWorktreePath({
        gitDirPath,
        commonDirPath,
        worktreePath,
    });

    return {
        branchName: rawBranchName,
        headRevision,
        gitDirPath,
        commonDirPath,
        worktreePath,
        registeredWorktreePath,
    };
}
