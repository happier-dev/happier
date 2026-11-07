import * as React from 'react';
import type { ScmFileViewedRequest } from '@happier-dev/plugin-sdk/scm';
import { IDLE_SCM_FILE_VIEWED, UNKNOWN_SCM_FILE_VIEWED, isScmFileViewedCurrentHead, type ScmFileViewedSource } from '@/sync/domains/scm/fileViewed';
import { acquireScmFileViewedSource } from '@/sync/ops/scmDiffSummary/fileViewedSources';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useScmFileViewedStatus } from './useScmFileViewedState';

export { useScmFileViewedFile, useScmFileViewedStatus } from './useScmFileViewedState';

const pendingViewedPaths: ReadonlySet<string> = new Set();
const pendingSource: ScmFileViewedSource = {
    getFile: () => UNKNOWN_SCM_FILE_VIEWED, getSnapshot: () => IDLE_SCM_FILE_VIEWED,
    subscribeFile: () => () => {}, subscribeStatus: () => () => {}, subscribeChanges: () => () => {},
    getViewedPaths: () => pendingViewedPaths, setViewed: async () => false,
    refresh: async () => {},
};

/** Presented core and native plugin reviews join one source, never one request per row or mount. */
export function useScmFileViewed(params: ScmFileViewedRequest): ScmFileViewedSource | null {
    const execution = useMountedActionExecution(params.serverId, { retainInvocation: true });
    const comparison = params.comparison;
    const actions = params.enabled !== false && comparison?.source.kind === 'pullRequest' && comparison.freshness !== 'stale'
        ? comparison.source.locator.fileViewedActions : undefined;
    const actionKey = actions ? JSON.stringify(actions) : null;
    const actionsRef = React.useRef(actions);
    actionsRef.current = actions;
    const binding = execution.binding;
    const scopeKey = binding ? JSON.stringify([binding.scope, binding.credentialKey ?? binding.revision]) : null;
    const latest = React.useRef({ execution, host: params.host, scopeKey, comparison });
    latest.current = { execution, host: params.host, scopeKey, comparison };
    const selection = React.useMemo(() => ({ actions: actionsRef.current, scopeKey }), [actionKey, scopeKey]);
    const [mounted, setMounted] = React.useState<Readonly<{
        selection: typeof selection;
        lease: ReturnType<typeof acquireScmFileViewedSource>;
    }> | null>(null);
    React.useEffect(() => {
        if (!selection.actions || !selection.scopeKey) return;
        const capture = latest.current.comparison;
        const lease = acquireScmFileViewedSource({ actions: selection.actions, scopeKey: selection.scopeKey,
            ...(capture ? { comparison: { freshness: capture.freshness, endpoints: capture.endpoints } } : {}),
            isCurrent: () => latest.current.scopeKey === selection.scopeKey && latest.current.execution.binding?.isCurrent() === true,
            execute: (invocation, signal) => {
                const { sessionId, machineId } = latest.current.host ?? {};
                return latest.current.execution.executeValue('action.invoke', invocation, {
                    signal,
                    ...(sessionId ? { defaultSessionId: sessionId, externalActionTarget: { kind: 'session' as const, sessionId } }
                        : machineId ? { externalActionTarget: { kind: 'machine' as const, machineId } } : {}),
                });
            },
        });
        setMounted({ selection, lease });
        return () => lease.release();
    }, [selection]);
    // An unresolved Account binding is unavailable source state, never local Keep-all.
    const lease = mounted?.selection === selection ? mounted.lease : null;
    const source = actions ? lease?.source ?? pendingSource : null;
    React.useEffect(() => {
        lease?.setActive(params.active !== false);
        return () => lease?.setActive(false);
    }, [lease, params.active]);
    const headOid = comparison?.endpoints.after;
    const previousRefresh = React.useRef({ token: params.refreshToken, headOid });
    React.useEffect(() => {
        if (previousRefresh.current.token === params.refreshToken && previousRefresh.current.headOid === headOid) return;
        previousRefresh.current = { token: params.refreshToken, headOid };
        if (params.active !== false) void lease?.source.refresh();
    }, [lease, params.active, params.refreshToken, headOid]);
    const status = useScmFileViewedStatus(source, params.active !== false);
    // GitHub's Viewed records describe its current PR head, not a historical capture.
    return comparison && isScmFileViewedCurrentHead(comparison, status) ? source : null;
}
