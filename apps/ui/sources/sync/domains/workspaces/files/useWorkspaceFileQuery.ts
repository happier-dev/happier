import * as React from 'react';

import type { FileSearchItem } from '@/sync/domains/fileSystem/fileSearchItem';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    searchWorkspaceFiles,
    WorkspaceFileSearchUnavailableError,
    type WorkspaceFileSearchInput,
    type WorkspaceFileSearchPage,
} from './workspaceFileSearch';

const EMPTY_ITEMS: FileSearchItem[] = [];

/** One cancellable filename-query lifecycle for workspace trees and arbitrary path browsers. */
export function useWorkspaceFileQuery(input: Omit<WorkspaceFileSearchInput, 'scope' | 'signal' | 'includeCoverage'> & Readonly<{
    scope: WorkspaceFileSearchInput['scope'] | null;
    enabled?: boolean;
    reloadToken?: number;
    contextKey?: string;
}>) {
    const query = input.query.trim();
    const enabled = input.enabled !== false && query.length > 0;
    const credentialScope = useServerCredentialAccountScopeBinding(
        enabled && !input.accountLifetime ? input.scope?.serverId : null,
    );
    const accountLifetime = input.accountLifetime ?? credentialScope.binding ?? undefined;
    const credentialsResolving = !input.accountLifetime && credentialScope.resolution.kind === 'resolving';
    const scope = React.useMemo(() => input.scope ? {
        serverId: input.scope.serverId,
        machineId: input.scope.machineId,
        rootPath: input.scope.rootPath,
    } : null, [input.scope?.serverId, input.scope?.machineId, input.scope?.rootPath, input.contextKey,
        input.mode, input.includeHidden, input.resultType]);
    const [retryToken, setRetryToken] = React.useState(0);
    const retry = React.useCallback(() => setRetryToken((value) => value + 1), []);
    const [state, setState] = React.useState<Readonly<{
        scope: typeof scope;
        lifetime: typeof accountLifetime;
        query: string;
        page: WorkspaceFileSearchPage | null;
        isSearching: boolean;
        error: WorkspaceFileSearchUnavailableError | null;
    }> | null>(null);

    React.useEffect(() => {
        if (!enabled) { setState(null); return; }
        if (!accountLifetime || !accountLifetime.isCurrent()) {
            setState({ scope, lifetime: accountLifetime, query, page: null, isSearching: credentialsResolving,
                error: credentialsResolving ? null : new WorkspaceFileSearchUnavailableError() });
            return;
        }
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => {
            controller.abort();
            setState({ scope, lifetime: accountLifetime, query, page: null, isSearching: false, error: new WorkspaceFileSearchUnavailableError() });
        });
        setState((previous) => ({
            scope, lifetime: accountLifetime, query: previous?.scope === scope ? previous.query : query,
            page: previous?.scope === scope && previous.lifetime === accountLifetime ? previous.page : null,
            isSearching: true, error: null,
        }));
        // Preserve the existing interaction debounce: trees 120ms, path-browser glob 200ms.
        const handle = setTimeout(() => {
            void (async () => {
                try {
                    if (!scope) throw new WorkspaceFileSearchUnavailableError();
                    const page = await searchWorkspaceFiles({
                        scope, query, limit: input.limit, threshold: input.threshold, resultType: input.resultType,
                        mode: input.mode, includeHidden: input.includeHidden, accountLifetime,
                        signal: controller.signal, includeCoverage: true,
                    });
                    if (!controller.signal.aborted) setState({ scope, lifetime: accountLifetime, query, page, isSearching: false, error: null });
                } catch (error) {
                    if (!controller.signal.aborted) setState((previous) => ({
                        scope, lifetime: accountLifetime, query: previous?.query ?? query,
                        page: previous?.scope === scope && previous.lifetime === accountLifetime ? previous.page : null,
                        isSearching: false, error: error instanceof WorkspaceFileSearchUnavailableError
                            ? error : new WorkspaceFileSearchUnavailableError(),
                    }));
                }
            })();
        }, input.mode === 'glob' ? 200 : 120);
        return () => { controller.abort(); clearTimeout(handle); retirement?.dispose(); };
    }, [scope, query, enabled, accountLifetime, credentialsResolving, input.limit, input.threshold, input.resultType, input.mode,
        input.includeHidden, input.reloadToken, retryToken]);

    const current = enabled && state?.scope === scope && state.lifetime === accountLifetime ? state : null;
    const items = React.useMemo(() => current?.page ? [...current.page.items] : EMPTY_ITEMS, [current?.page]);
    return {
        items,
        resultQuery: current?.query,
        isSearching: enabled && (current?.isSearching ?? true),
        error: current?.error ?? null,
        coverage: current?.error ? 'unavailable' as const : current?.page?.corpusTruncated ? 'partial' as const
            : current?.page ? 'complete' as const : 'unavailable' as const,
        hasMore: current?.page?.hasMore ?? false,
        retry,
    };
}
