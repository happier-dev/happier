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
    options?: Readonly<{ refreshOnMount?: boolean; detail?: 'summary' }>): UseWorkspaceScmSnapshotControllerResult {
    const refreshOnMount = options?.refreshOnMount !== false;
    const summaryOnly = options?.detail === 'summary';
    const normalizedScope = React.useMemo(() => normalizeScope(scope), [scope?.machineId, scope?.rootPath, scope?.serverId]);
    const listSnapshot = useWorkspaceScmSnapshot(summaryOnly ? null : normalizedScope);
    const summarySnapshot = useWorkspaceScmSummarySnapshot(summaryOnly ? normalizedScope : null);
    const slotLacksList = useWorkspaceScmSlotLacksList(summaryOnly ? null : normalizedScope);
    const presented = useLayoutPresentationActive();
    const intervalMs = useSetting('scmSessionAutoRefreshIntervalMs');
    const snapshot = summaryOnly ? summarySnapshot : listSnapshot;
    const snapshotError = useWorkspaceScmSnapshotError(normalizedScope);
    const presence = useMachinePresenceSummary(normalizedScope?.serverId, normalizedScope?.machineId);
    const unreachable = presence.reachability === 'unreachable';

    const [loading, setLoading] = React.useState(false);
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
        if (!normalizedScope || unreachable) return;
        setLoading(true);
        try {
            await scmStatusSync.invalidateFromUserAndAwait(normalizedScope);
        } finally {
            setLoading(false);
        }
    }, [normalizedScope, unreachable]);

    React.useEffect(() => {
        if (!normalizedScope || !presented || unreachable) return;
        return scmStatusSync.retainAutoRefresh({ scope: normalizedScope, intervalMs, refreshOnRetain: false });
    }, [normalizedScope, presented, unreachable, intervalMs]);

    // Counts cannot reveal a rename or an edit with unchanged totals. Returning is the natural
    // revalidation boundary even when no push replaced the slot; held rows stay on screen meanwhile.
    // A failed read does not retry here; the slot and presentation edge are unchanged.
    const readsList = !summaryOnly && presented && !unreachable && slotLacksList;
    const wasPresented = React.useRef(presented);
    React.useEffect(() => {
        const returned = presented && !wasPresented.current;
        wasPresented.current = presented;
        if (readsList || (returned && !summaryOnly && !unreachable)) void refresh();
    }, [presented, readsList, refresh, summaryOnly, unreachable]);

    const initKey = normalizedScope
        ? `${normalizedScope.serverId}:${normalizedScope.machineId}:${normalizedScope.rootPath}`
        : '';
    const didInitKeyRef = React.useRef<string>('');
    React.useEffect(() => {
        if (!refreshOnMount || !presented) return;
        if (unreachable) {
            didInitKeyRef.current = '';
            return;
        }
        if (!normalizedScope) return;
        if (didInitKeyRef.current === initKey) return;
        didInitKeyRef.current = initKey;
        void refresh();
    }, [initKey, normalizedScope, presented, refresh, refreshOnMount, unreachable]);

    return {
        snapshot,
        loading: loading && !unreachable,
        error,
        refresh,
    };
}
