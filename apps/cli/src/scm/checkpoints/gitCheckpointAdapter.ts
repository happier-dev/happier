import { resolve } from 'node:path';

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

async function runWithGitCheckpointRuntime<T>(context: ScmBackendContext, callback: () => Promise<T> | T): Promise<T> {
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
}>): Promise<ScmBackendContext | null> {
    const detectedRoot = await runWithScmCommandRunner(input.scmCommandRunner, () => runHostScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--show-toplevel'],
    }));
    const repoRoot = detectedRoot.success ? detectedRoot.stdout.trim() : '';
    if (!detectedRoot.success && detectedRoot.stderr.trim() === 'scm_exec_unavailable') throw new ScmExecUnavailableError();
    if (!repoRoot) return null;

    return {
        cwd: input.cwd,
        ...(input.scmCommandRunner ? { scmCommandRunner: input.scmCommandRunner } : {}),
        projectKey: `${resolve(input.workingDirectory ?? input.cwd)}:${input.cwd}`,
        detection: {
            isRepo: true,
            rootPath: repoRoot,
            mode: '.git',
        },
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
