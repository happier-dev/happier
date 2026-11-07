import type { ScmBackendRegistry } from '@/scm/registry';
import type { BackendRuntimeHandlers } from '@happier-dev/plugin-sdk/scm/backend';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { logger } from '@/ui/logger';

type Response = Awaited<ReturnType<NonNullable<NonNullable<BackendRuntimeHandlers['read']>['ignoredPaths']>>>;

// Roots whose failed ignore read was already reported, so repeated discovery logs each root once.
const reportedUnavailableRoots = new Set<string>();

function reportIgnoreRulesUnavailable(root: string, errorCode: string): void {
    // Callers pass the absolute root they walk; that string is the per-root key.
    if (reportedUnavailableRoots.has(root)) return;
    reportedUnavailableRoots.add(root);
    // Callers keep their complete fallback (the full walk); this makes that fallback visible.
    logger.warnLocalFile('[SCM] Repository ignore rules unavailable; callers fall back to reading every folder', { repositoryRoot: root, errorCode });
}

/**
 * Paths the repository ignores, relative to `repositoryRoot` and as its SCM backend applies
 * every ignore source (Git: `.gitignore`, `.git/info/exclude`, `core.excludesFile`). Wholly
 * ignored directories carry a trailing separator. `null` means no repository or no answer;
 * a repository that could not answer (for example Git's `safe.directory` refusal) is logged
 * once per root at warn.
 */
export async function readRepositoryIgnoredPaths(input: Readonly<{ repositoryRoot: string; happyHomeDir?: string; registry?: ScmBackendRegistry }>): Promise<readonly string[] | null> {
    let result: Response;
    try {
        result = await runWithScmBackendRegistryLease(input.registry, registry => runScmRoute<{ cwd: string }, Response>({
            request: { cwd: input.repositoryRoot }, workingDirectory: input.repositoryRoot, registry,
            onNonRepository: () => ({ success: false }),
            runWithBackend: async ({ context, selection }) => selection.backend.ignoredPaths
                ? selection.backend.ignoredPaths({ context, request: { cwd: input.repositoryRoot }, signal: context.signal ?? new AbortController().signal })
                : { success: false, errorCode: 'FEATURE_UNSUPPORTED' },
        }), { happyHomeDir: input.happyHomeDir });
    } catch (error) {
        reportIgnoreRulesUnavailable(input.repositoryRoot, error instanceof Error ? error.name : 'UNKNOWN');
        throw error;
    }
    if (result.success && result.paths) return result.paths;
    // A folder outside any repository, or a backend without ignore support, has no rules to miss.
    if (result.errorCode && result.errorCode !== 'FEATURE_UNSUPPORTED') reportIgnoreRulesUnavailable(input.repositoryRoot, result.errorCode);
    return null;
}
