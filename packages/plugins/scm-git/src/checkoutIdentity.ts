import { readCurrentBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { getScmCommandIndeterminateErrorCode, runScmCommand } from './runtime.js';
import { buildScmNonInteractiveEnv } from './providers/shared/nonInteractiveEnv.js';
import { parseGitWorktreeListRecords } from './worktreeListParser.js';

/** Git lists the main checkout (or bare repository) first, independently of path sorting. */
export async function resolveGitMainWorktreePath(input: Readonly<{
    worktreesOutput: string;
    currentWorktreePath: string | null;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const main = parseGitWorktreeListRecords(input.worktreesOutput)[0];
    if (!main) return null;
    const paths = readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths;
    const addressedPath = paths?.fromCommandPath(main.path) ?? main.path;
    if (main.bare || addressedPath === input.currentWorktreePath || main.path === input.currentWorktreePath) return addressedPath;
    const proof = await runScmCommand({ bin: 'git', cwd: addressedPath,
        args: ['rev-parse', '--show-toplevel'], signal: input.signal,
        env: buildScmNonInteractiveEnv({ LC_ALL: 'C' }) });
    if (proof.success) return proof.stdout.replace(/\n$/, '') === main.path ? addressedPath : null;
    // Separate-git-dir administration is not proof of a main checkout.
    if (/not a git repository|must be run in a work tree/i.test(proof.stderr)) return null;
    throw new Error(`Git main checkout inspection unavailable: ${proof.stderr}`);
}

export async function inspectGitMainWorktreePath(input: Readonly<{
    cwd: string;
    currentWorktreePath: string;
    signal?: AbortSignal;
}>): Promise<string | null> {
    const listed = await runScmCommand({ bin: 'git', cwd: input.cwd,
        args: ['worktree', 'list', '--porcelain', '-z'], signal: input.signal,
        env: buildScmNonInteractiveEnv({ LC_ALL: 'C' }) });
    if (!listed.success) {
        if (/not a git repository/i.test(listed.stderr)) return null;
        throw new Error(`Git worktree inspection unavailable: ${listed.stderr}`);
    }
    return resolveGitMainWorktreePath({ ...input, worktreesOutput: listed.stdout });
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

function readGitCommand(cwd: string, args: string[]) {
    return runScmCommand({
        bin: 'git',
        cwd,
        args,
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
}

async function readGitValue(cwd: string, args: string[]): Promise<string | null> {
    const result = await readGitCommand(cwd, args);
    if (!result.success) {
        return null;
    }

    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
}

function toGitCommandPath(path: string): string {
    return readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths?.toCommandPath(path) ?? path;
}

async function readGitAdminFile(path: string): Promise<string> {
    const fileSystem = readCurrentBackendRuntimeServices()?.repositoryFileSystem;
    if (!fileSystem) return readFile(path, 'utf8');
    const addressedPath = fileSystem.commandPaths?.fromCommandPath(path) ?? path;
    return Buffer.from(await fileSystem.readFile(addressedPath)).toString('utf8');
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

    return isAbsolute(fallbackValue) ? fallbackValue : resolve(toGitCommandPath(input.cwd), fallbackValue);
}

export async function readGitCommonDirPath(params: Readonly<{ cwd: string }>): Promise<string | null> {
    return readGitAbsolutePathValue({ cwd: params.cwd, pathArgs: ['--git-common-dir'] });
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
        const rawGitFilePath = (await readGitAdminFile(join(input.gitDirPath, 'gitdir'))).trim();
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

export function resolveGitAdminPath(cwd: string, rawGitFileContents: string): string | null {
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
        const worktreePath = toGitCommandPath(cwd);
        const gitFileContents = await readGitAdminFile(join(worktreePath, '.git'));
        const gitDirPath = resolveGitAdminPath(worktreePath, gitFileContents.trim());
        if (!gitDirPath) {
            return null;
        }

        const commonDirValue = (await readGitAdminFile(join(gitDirPath, 'commondir'))).trim();
        const commonDirPath = commonDirValue
            ? (isAbsolute(commonDirValue) ? commonDirValue : resolve(gitDirPath, commonDirValue))
            : gitDirPath;
        const headValue = (await readGitAdminFile(join(gitDirPath, 'HEAD'))).trim();
        const branchName = headValue.startsWith('ref: refs/heads/')
            ? headValue.slice('ref: refs/heads/'.length)
            : null;
        const headRevision = branchName
            ? (await readGitAdminFile(join(commonDirPath, 'refs', 'heads', branchName))).trim() || null
            : /^[0-9a-f]{40}$/i.test(headValue)
                ? headValue
                : null;
        const registeredWorktreePath = await readRegisteredWorktreePath({
            gitDirPath,
            commonDirPath,
            worktreePath,
        });

        return {
            branchName,
            headRevision,
            gitDirPath,
            commonDirPath,
            worktreePath,
            registeredWorktreePath,
        };
    } catch {
        return null;
    }
}

export async function inspectGitCheckoutIdentity(params: Readonly<{
    cwd: string;
}>): Promise<GitCheckoutIdentity | null> {
    const [head, branch, gitDirPath, commonDirPath, worktreePath] = await Promise.all([
        readGitCommand(params.cwd, ['rev-parse', '--verify', 'HEAD']),
        readGitCommand(params.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        readGitAbsolutePathValue({ cwd: params.cwd, pathArgs: ['--git-dir'] }),
        readGitCommonDirPath(params),
        readGitAbsolutePathValue({ cwd: params.cwd, pathArgs: ['--show-toplevel'] }),
    ]);
    // A command that never completed cannot establish an unborn or detached checkout.
    if (getScmCommandIndeterminateErrorCode(head) || getScmCommandIndeterminateErrorCode(branch)) return null;

    if (!gitDirPath || !commonDirPath || !worktreePath) {
        return await inspectGitCheckoutIdentityFromAdminFiles(params.cwd);
    }

    const registeredWorktreePath = await readRegisteredWorktreePath({
        gitDirPath,
        commonDirPath,
        worktreePath,
    });

    return {
        branchName: branch.success ? branch.stdout.trim() || null : null,
        headRevision: head.success ? head.stdout.trim() || null : null,
        gitDirPath,
        commonDirPath,
        worktreePath,
        registeredWorktreePath,
    };
}
