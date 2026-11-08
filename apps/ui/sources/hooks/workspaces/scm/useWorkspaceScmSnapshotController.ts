import * as React from 'react';

import { scmStatusSync } from '@/scm/scmStatusSync';
import { useSetting, useWorkspaceScmSnapshot, useWorkspaceScmSnapshotError, useWorkspaceScmSummarySnapshot } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkspaceScmSlotLacksList } from '@/sync/store/scmHooks';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';
import {
    normalizeWorkspaceScopeBase,
    type WorkspaceScopeBase,
} from '@/sync/domains/workspaces/workspaceScope';

export type WorkspaceScmSnapshotControllerError = Readonly<{
    message: string;
    errorCode: string | null;
}>;

export type UseWorkspaceScmSnapshotControllerResult = Readonly<{
    snapshot: ReturnType<typeof useWorkspaceScmSnapshot>;
    loading: boolean;
    error: WorkspaceScmSnapshotControllerError | null;
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
    loadFile: (path: string) => Promise<void>;
    loadingMore: boolean;
}>;

function normalizeScope(input: WorkspaceScopeBase | null): WorkspaceScopeBase | null {
    if (!input) return null;
    return normalizeWorkspaceScopeBase({
        serverId: input.serverId,
        machineId: input.machineId,
        rootPath: input.rootPath,
    });
}

/**
 * `detail: 'summary'`: the caller reads counts, branch and worktrees only (headers, Checkouts); it
 * is answered with the shared counts unless a list consumer of the same workspace is presented.
 * Without it the caller is a list consumer: the workspace refreshes with its changed-file list.
 */
export function useWorkspaceScmSnapshotController(scope: WorkspaceScopeBase | null,
    options?: Readonly<{ refreshOnMount?: boolean; detail?: 'summary'; entriesPageSize?: number | null }>): UseWorkspaceScmSnapshotControllerResult {
    const refreshOnMount = options?.refreshOnMount !== false;
    const summaryOnly = options?.detail === 'summary';
    const entriesPageSize = options?.entriesPageSize;
    const waitingForLayout = !summaryOnly && entriesPageSize === null;
    const normalizedScope = React.useMemo(() => normalizeScope(scope), [scope?.machineId, scope?.rootPath, scope?.serverId]);
    const listSnapshot = useWorkspaceScmSnapshot(summaryOnly || waitingForLayout ? null : normalizedScope, entriesPageSize ?? undefined);
    const summarySnapshot = useWorkspaceScmSummarySnapshot(summaryOnly ? normalizedScope : null);
    const slotLacksList = useWorkspaceScmSlotLacksList(summaryOnly || waitingForLayout ? null : normalizedScope, entriesPageSize ?? undefined);
    const presented = useLayoutPresentationActive();
    const intervalMs = useSetting('scmSessionAutoRefreshIntervalMs');
    const snapshot = summaryOnly ? summarySnapshot : listSnapshot;
    const snapshotError = useWorkspaceScmSnapshotError(normalizedScope);
    const presence = useMachinePresenceSummary(normalizedScope?.serverId, normalizedScope?.machineId);
    const unreachable = presence.reachability === 'unreachable';

    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const error = React.useMemo<WorkspaceScmSnapshotControllerError | null>(() => {
        if (unreachable) return { message: t('errors.daemonUnavailableBody'), errorCode: 'machine_offline' };
        if (!snapshotError) return null;
        const code =
            typeof snapshotError === 'object'
            && snapshotError !== null
            && 'errorCode' in snapshotError
            && typeof (snapshotError as { errorCode?: unknown }).errorCode === 'string'
                ? ((snapshotError as { errorCode: string }).errorCode)
                : null;
        return {
            message: snapshotError.message,
            errorCode: code,
        };
    }, [unreachable, snapshotError?.message, (snapshotError as { errorCode?: unknown } | null | undefined)?.errorCode]);

    const refresh = React.useCallback(async () => {
        if (!normalizedScope || unreachable || waitingForLayout) return;
        setLoading(true);
        try {
            await scmStatusSync.invalidateFromUserAndAwait(normalizedScope);
        } finally {
            setLoading(false);
        }
    }, [normalizedScope, unreachable, waitingForLayout]);

    const loadEntries = React.useCallback(async (path?: string) => {
        if (!normalizedScope || unreachable || !presented || typeof entriesPageSize !== 'number') return;
        setLoadingMore(true);
        try {
            await scmStatusSync.loadWorkspaceEntries(normalizedScope, entriesPageSize, path);
        } finally {
            setLoadingMore(false);
        }
    }, [normalizedScope, unreachable, presented, entriesPageSize]);
    const loadMore = React.useCallback(() => loadEntries(), [loadEntries]);
    const loadFile = React.useCallback((path: string) => loadEntries(path), [loadEntries]);

    React.useEffect(() => {
        if (!normalizedScope || !presented || unreachable || waitingForLayout) return;
        return scmStatusSync.retainAutoRefresh({ scope: normalizedScope, intervalMs, refreshOnRetain: false });
    }, [normalizedScope, presented, unreachable, intervalMs, waitingForLayout]);

    // Counts cannot reveal a rename or an edit with unchanged totals. Returning is the natural
    // revalidation boundary even when no push replaced the slot; held rows stay on screen meanwhile.
    // A failed read does not retry here; the slot and presentation edge are unchanged.
    const readsList = !summaryOnly && !waitingForLayout && presented && !unreachable && slotLacksList;
    const wasPresented = React.useRef(presented);
    const initKey = normalizedScope
        ? `${normalizedScope.serverId}:${normalizedScope.machineId}:${normalizedScope.rootPath}`
        : '';
    const didInitKeyRef = React.useRef<string>('');
    React.useEffect(() => {
        const returned = presented && !wasPresented.current;
        wasPresented.current = presented;
        if (!presented || waitingForLayout) return;
        if (unreachable) {
            didInitKeyRef.current = '';
            return;
        }
        if (!normalizedScope) return;
        const initialRead = refreshOnMount && didInitKeyRef.current !== initKey;
        if (!initialRead && !readsList && !(returned && !summaryOnly)) return;
        didInitKeyRef.current = initKey;
        void refresh();
    }, [initKey, normalizedScope, presented, refresh, refreshOnMount, unreachable, waitingForLayout, readsList, summaryOnly]);

    return {
        snapshot,
        loading: loading && !unreachable,
        error,
        refresh,
        loadMore,
        loadFile,
        loadingMore,
    };
}
