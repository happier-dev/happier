import { realpath } from 'node:fs/promises';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmRepositoryCloneOutput,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/experimental/scm';

import type { detectGitRepo } from '../repository.js';
import type { ScmBackendContext, ScmRepoDetection } from '../types.js';
import {
    cloneErrorResponse,
    type FileIdentity,
    isSameCloneDestinationOrMissing,
    pathContainsTraversal,
} from './repositoryCloneDestination.js';

function contextWithDetection(
    context: ScmBackendContext,
    cwd: string,
    detection: ScmRepoDetection,
): ScmBackendContext {
    return {
        ...context,
        cwd,
        projectKey: `${context.projectKey}:clone:${cwd}`,
        detection,
    };
}

async function isResolvedCloneRoot(rootPath: string | null | undefined, destinationPath: string): Promise<boolean> {
    if (typeof rootPath !== 'string') return false;
    if (rootPath.includes('\0') || pathContainsTraversal(rootPath)) return false;
    try {
        const destinationRealPath = await realpath(destinationPath);
        const rootRealPath = await realpath(rootPath);
        return rootRealPath === destinationRealPath;
    } catch {
        return false;
    }
}

function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

async function cloneDestinationRaceOrCommandFailure(input: Readonly<{
    path: string;
    identity: FileIdentity;
    changedMessage: string;
    fallbackMessage: string;
    error: unknown;
}>): Promise<ScmRepositoryCloneOutput> {
    if (!await isSameCloneDestinationOrMissing({
        path: input.path,
        identity: input.identity,
    })) {
        return cloneErrorResponse(
            input.changedMessage,
            SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        );
    }
    return cloneErrorResponse(
        errorMessage(input.error, input.fallbackMessage),
        SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    );
}

export async function readClonedSnapshot(input: Readonly<{
    context: ScmBackendContext;
    destinationPath: string;
    destinationIdentity: FileIdentity;
    detectRepo: typeof detectGitRepo;
    readSnapshot: (snapshotInput: Readonly<{ context: ScmBackendContext }>) => Promise<ScmWorkingSnapshot | null>;
}>): Promise<ScmWorkingSnapshot | ScmRepositoryCloneOutput> {
    if (!await isSameCloneDestinationOrMissing({
        path: input.destinationPath,
        identity: input.destinationIdentity,
    })) {
        return cloneErrorResponse(
            'Repository clone destination changed before repository detection.',
            SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        );
    }

    let detection: ScmRepoDetection;
    try {
        detection = await input.detectRepo({ cwd: input.destinationPath });
    } catch (error) {
        return await cloneDestinationRaceOrCommandFailure({
            path: input.destinationPath,
            identity: input.destinationIdentity,
            changedMessage: 'Repository clone destination changed during repository detection.',
            fallbackMessage: 'Repository clone completed but the cloned directory could not be detected as a Git repository.',
            error,
        });
    }
    if (!await isSameCloneDestinationOrMissing({
        path: input.destinationPath,
        identity: input.destinationIdentity,
    })) {
        return cloneErrorResponse(
            'Repository clone destination changed during repository detection.',
            SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        );
    }
    if (!detection.isRepo || !await isResolvedCloneRoot(detection.rootPath, input.destinationPath)) {
        return cloneErrorResponse(
            'Repository clone completed but the cloned directory could not be detected as a Git repository.',
            SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        );
    }

    let snapshot: ScmWorkingSnapshot | null;
    try {
        snapshot = await input.readSnapshot({
            context: contextWithDetection(input.context, input.destinationPath, detection),
        });
    } catch (error) {
        return await cloneDestinationRaceOrCommandFailure({
            path: input.destinationPath,
            identity: input.destinationIdentity,
            changedMessage: 'Repository clone destination changed while reading the cloned repository snapshot.',
            fallbackMessage: 'Repository clone completed but the cloned repository snapshot could not be read.',
            error,
        });
    }
    if (!await isSameCloneDestinationOrMissing({
        path: input.destinationPath,
        identity: input.destinationIdentity,
    })) {
        return cloneErrorResponse(
            'Repository clone destination changed while reading the cloned repository snapshot.',
            SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        );
    }
    if (!snapshot) {
        return cloneErrorResponse(
            'Repository clone completed but the cloned repository snapshot could not be read.',
            SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        );
    }
    if (!await isResolvedCloneRoot(snapshot.repo.rootPath, input.destinationPath)) {
        return cloneErrorResponse(
            'Repository clone completed but the cloned repository snapshot did not match the clone destination.',
            SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        );
    }
    return snapshot;
}
