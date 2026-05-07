import { access, readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ScmOperationState } from '@happier-dev/protocol';

import { runScmCommand } from '../../../runtime';
import type { ScmBackendContext } from '../../../types';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';

async function resolveGitStatePath(context: ScmBackendContext, statePath: string): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', '--git-path', statePath],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) return null;
    const rawPath = result.stdout.trim();
    if (!rawPath) return null;
    return isAbsolute(rawPath) ? rawPath : resolve(context.cwd, rawPath);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function directoryExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function readTrimmedFile(path: string): Promise<string | null> {
    try {
        const value = (await readFile(path, 'utf8')).trim();
        return value || null;
    } catch {
        return null;
    }
}

function parseMergeSourceRef(message: string | null): string | null {
    if (!message) return null;
    const firstLine = message.split(/\r?\n/g).find((line) => line.trim())?.trim() ?? '';
    const quoted = firstLine.match(/'([^']+)'/);
    if (quoted?.[1]) return quoted[1];
    return firstLine || null;
}

async function readMergeOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    const mergeHeadPath = await resolveGitStatePath(context, 'MERGE_HEAD');
    if (!mergeHeadPath || !(await pathExists(mergeHeadPath))) {
        return null;
    }

    const mergeMessagePath = await resolveGitStatePath(context, 'MERGE_MSG');
    const sourceRef = mergeMessagePath ? parseMergeSourceRef(await readTrimmedFile(mergeMessagePath)) : null;
    return {
        kind: 'merge',
        sourceRef,
        canContinue: true,
        canAbort: true,
    };
}

async function readRebaseSourceRef(context: ScmBackendContext, rebaseDirName: 'rebase-merge' | 'rebase-apply'): Promise<string | null> {
    const ontoNamePath = await resolveGitStatePath(context, `${rebaseDirName}/onto_name`);
    const ontoName = ontoNamePath ? await readTrimmedFile(ontoNamePath) : null;
    if (ontoName && ontoName !== 'onto') return ontoName.replace(/^refs\/heads\//, '');

    const headNamePath = await resolveGitStatePath(context, `${rebaseDirName}/head-name`);
    const headName = headNamePath ? await readTrimmedFile(headNamePath) : null;
    return headName ? headName.replace(/^refs\/heads\//, '') : null;
}

async function readRebaseOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    for (const rebaseDirName of ['rebase-merge', 'rebase-apply'] as const) {
        const rebasePath = await resolveGitStatePath(context, rebaseDirName);
        if (!rebasePath || !(await directoryExists(rebasePath))) {
            continue;
        }
        return {
            kind: 'rebase',
            sourceRef: await readRebaseSourceRef(context, rebaseDirName),
            canContinue: true,
            canAbort: true,
        };
    }

    return null;
}

export async function readGitBranchOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    return (await readMergeOperationState(context)) ?? (await readRebaseOperationState(context));
}
