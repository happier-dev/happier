import type { WorkspaceFileSearchFileV1 } from '@happier-dev/protocol';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { machineWorkspaceFileSearch } from '@/sync/ops/machineWorkspaceFileSearch';

export type WorkspaceFileContentSearchPage = Readonly<{
    items: readonly WorkspaceFileSearchFileV1[];
    hasMore: boolean;
    coverage: 'complete' | 'partial' | 'unavailable';
    error?: 'update_required' | 'invalid_pattern' | 'transport_failed' | 'account_unavailable' | 'root_not_allowed' | 'ripgrep_unavailable' | 'ripgrep_failed';
}>;

export async function searchWorkspaceFileContents(input: Readonly<{
    scope: WorkspaceScopeBase;
    accountLifetime: ServerAccountScopeLifetime;
    query: string;
    matchCase?: boolean;
    regex?: boolean;
    signal?: AbortSignal;
}>): Promise<WorkspaceFileContentSearchPage> {
    const { accountLifetime } = input;
    if (!accountLifetime.isCurrent() || accountLifetime.scope.serverId !== input.scope.serverId) return { items: [], hasMore: false, coverage: 'unavailable', error: 'account_unavailable' };
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    const retirement = accountLifetime.onRetire(abort);
    const checkCurrent = () => {
        if (controller.signal.aborted || !accountLifetime.isCurrent()) throw Object.assign(new Error('Search cancelled'), { name: 'AbortError' });
    };
    try {
        checkCurrent();
        const response = await machineWorkspaceFileSearch(input.scope.machineId, {
            rootPath: input.scope.rootPath, query: input.query, contextLines: 2,
            ...(input.matchCase !== undefined ? { matchCase: input.matchCase } : {}),
            ...(input.regex !== undefined ? { regex: input.regex } : {}),
        }, { serverId: input.scope.serverId, accountId: accountLifetime.scope.accountId, signal: controller.signal });
        checkCurrent();
        if (!response.ok) return { items: [], hasMore: false, coverage: 'unavailable', error: 'errorCode' in response ? response.errorCode === 'method_unavailable' ? 'update_required' : 'transport_failed' : response.code };
        return { items: response.files, hasMore: response.hasMore, coverage: response.coverage };
    } catch (error) {
        checkCurrent();
        throw error;
    } finally {
        retirement.dispose();
        input.signal?.removeEventListener('abort', abort);
    }
}
