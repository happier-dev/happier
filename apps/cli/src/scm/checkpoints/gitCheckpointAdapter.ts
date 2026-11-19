import { isAbsolute, resolve } from 'node:path';

import {
    runWithBackendRuntimeServices as runWithScmBackendRuntimeServices,
    type BackendRuntimeServices as ScmBackendRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/backend';

import {
    aliasGitRepositoryCheckpoint,
    captureGitRepositoryCheckpoint,
    diffGitRepositoryCheckpoints,
} from './gitRepositoryCheckpointOperations';
import type { CheckpointRollbackOrchestrationDependencies } from './rollback/types';
import {
    applyGitCheckpointReversePatch,
    createGitRollbackBackup,
    createGitRollbackStash,
} from './rollback/gitCheckpointRollbackOperations';
import { rejectUnauthorizedScmInstallableCommand } from '../commandAuthorization';
import { runScmCommand as runHostScmCommand, runWithScmCommandRunner, ScmExecUnavailableError, type ScmCommandRunner } from '../runtime';
import type { ScmBackendContext } from '../types';
import type { GitCheckpointBackendContext } from './types';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

export function createGitCheckpointRuntimeServices(): ScmBackendRuntimeServices {
    return {
        async runCommand(input) {
            if (input.command !== 'git') {
                return {
                    success: false,
                    stdout: '',
                    stderr: `Unsupported SCM checkpoint command '${input.command}'`,
                    exitCode: -1,
                };
            }
            const unauthorizedCommand = rejectUnauthorizedScmInstallableCommand(input);
            if (unauthorizedCommand) return unauthorizedCommand;
            return await runHostScmCommand({
                bin: 'git',
                cwd: input.cwd,
                args: [...input.args],
                timeoutMs: input.timeoutMs,
                stdin: input.stdin,
                maxOutputBytes: input.maxOutputBytes,
                env: input.env,
                signal: input.signal,
            });
        },
    };
}

const gitCheckpointRuntimeServices = createGitCheckpointRuntimeServices();

async function runWithGitCheckpointRuntime<T>(context: GitCheckpointBackendContext, callback: () => Promise<T> | T): Promise<T> {
    return await runWithScmCommandRunner(context.scmCommandRunner, () => runWithScmBackendRuntimeServices(
        gitCheckpointRuntimeServices,
        async () => await callback(),
    ));
}

export const gitCheckpointAdapter = {
    capture: async (...args: Parameters<typeof captureGitRepositoryCheckpoint>) =>
        await runWithGitCheckpointRuntime(args[0].context, async () => await captureGitRepositoryCheckpoint(...args)),
    alias: async (...args: Parameters<typeof aliasGitRepositoryCheckpoint>) =>
        await runWithGitCheckpointRuntime(args[0].context, async () => await aliasGitRepositoryCheckpoint(...args)),
    diff: async (...args: Parameters<typeof diffGitRepositoryCheckpoints>) =>
        await runWithGitCheckpointRuntime(args[0].context, async () => await diffGitRepositoryCheckpoints(...args)),
} as const;

export async function resolveGitCheckpointBackendContext(input: Readonly<{
    cwd: string;
    workingDirectory?: string;
    scmCommandRunner?: ScmCommandRunner;
}>): Promise<GitCheckpointBackendContext | null> {
    // One process discovers the root and the Git paths every capture and evidence write needs.
    const detectedRoot = await runWithScmCommandRunner(input.scmCommandRunner, () => runHostScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--show-toplevel', '--git-path', 'index', '--git-path', 'happier/checkpoint-evidence'],
    }));
    const [repoRoot = '', indexPath = '', evidencePath = ''] = detectedRoot.success
        ? detectedRoot.stdout.split(/\r?\n/).map(line => line.trim()) : [];
    if (!detectedRoot.success && detectedRoot.stderr.trim() === 'scm_exec_unavailable') throw new ScmExecUnavailableError();
    if (!repoRoot) return null;
    const paths = currentWorkspaceSource().commandPaths;
    const addressedPath = (path: string) => isAbsolute(path)
        ? paths?.fromCommandPath(path) ?? path
        : resolve(input.cwd, path);

    return {
        cwd: input.cwd,
        ...(input.scmCommandRunner ? { scmCommandRunner: input.scmCommandRunner } : {}),
        projectKey: `${resolve(input.workingDirectory ?? input.cwd)}:${input.cwd}`,
        detection: {
            isRepo: true,
            rootPath: addressedPath(repoRoot),
            mode: '.git',
        },
        // `--git-path` prints paths relative to the command's working directory.
        ...(indexPath && evidencePath ? { checkpointGitPaths: {
            index: addressedPath(indexPath),
            checkpointEvidence: addressedPath(evidencePath),
        } } : {}),
    };
}

export function createGitCheckpointRollbackDependencies(input: Readonly<{
    context: ScmBackendContext;
    rollbackId: string;
}>): CheckpointRollbackOrchestrationDependencies {
    return {
        captureBackup: async (adapterContext) => await runWithGitCheckpointRuntime(input.context, async () =>
            await createGitRollbackBackup({
                context: input.context,
                request: adapterContext.request,
                rollbackId: input.rollbackId,
            })),
        createStash: async (adapterContext) => await runWithGitCheckpointRuntime(input.context, async () =>
            await createGitRollbackStash({
                context: input.context,
                request: adapterContext.request,
                rollbackId: input.rollbackId,
            })),
        applyReversePatch: async (adapterContext) => await runWithGitCheckpointRuntime(input.context, async () =>
            await applyGitCheckpointReversePatch({
                context: input.context,
                request: adapterContext.request,
                backupCaptured: adapterContext.backupCaptured,
            })),
    };
}
