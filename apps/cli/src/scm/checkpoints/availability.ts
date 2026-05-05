import type { ScmBackendContext } from '../types';
import type { RepositoryCheckpointAvailability } from './types';

export function resolveRepositoryCheckpointAvailability(input: {
    context: ScmBackendContext;
}): RepositoryCheckpointAvailability {
    const { detection } = input.context;
    if (!detection.isRepo) {
        return {
            available: false,
            reason: 'not_repo',
            message: 'Repository checkpoint capture is unavailable outside a source-control repository.',
        };
    }
    if (detection.mode !== '.git') {
        return {
            available: false,
            reason: 'unsupported_scm',
            message: 'Repository checkpoint capture is currently available for Git repositories only.',
        };
    }
    if (!detection.rootPath) {
        return {
            available: false,
            reason: 'missing_repo_root',
            message: 'Repository checkpoint capture requires a resolved Git repository root.',
        };
    }
    return {
        available: true,
        repoRoot: detection.rootPath,
        mode: '.git',
    };
}
