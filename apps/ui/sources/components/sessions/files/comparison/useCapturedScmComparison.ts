import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { createRpcCallError, RpcError } from '@happier-dev/protocol/rpcErrors';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { scmComparisonSourceOf, scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { captureScmComparisonForSession, readCapturedScmFileForSession, getScmDiffSummaryState,
    subscribeScmDiffSummaryHostState, retainCapturedScmRead } from '@/sync/ops/scmDiffSummary/generate';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { CapturedScmRead } from '@/sync/domains/scm/diffSummary/state';
import { scmComparisonKey } from './filesComparison';
import { t } from '@/text';

/** Active Files reads evidence from the machine owner; a pinned identity is never recaptured. */
export function useCapturedScmComparison(params: Readonly<{
    host: ScmDiffSummaryHost;
    machine: Readonly<{ machineId: string; basePath: string }> | null;
    identity: Readonly<{ machineId: string | null; basePath: string | null }>;
    serverId?: string | null;
    comparison: SessionScmReviewComparison;
    active?: boolean;
    knownComparison?: ScmComparison | null;
    /** Absolute Machine path, so nested Session roots select the same captured file. */
    filePath?: string;
}>) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(params.serverId);
    // Hydrated evidence follows the retained Account identity during Home revalidation;
    // only the current credential binding may issue a refresh.
    const scope = resolution.kind === 'bound' ? resolution.scope : null;
    const { machine, identity } = params;
    const basePath = identity.basePath;
    const sessionId = params.host.sessionId ?? null;
    const sourceAvailable = Boolean(sessionId) || (params.comparison.kind !== 'session' && params.comparison.kind !== 'turnCheckpoint');
    const { comparisonId, ...unpinnedComparison } = params.comparison;
    const known = params.knownComparison && (!comparisonId || params.knownComparison.id === comparisonId)
        && params.knownComparison.repository.rootPath === basePath
        && scmReviewComparisonMatchesSource(params.comparison, params.knownComparison.source, params.knownComparison) ? params.knownComparison : null;
    const selectorKey = scmComparisonKey(params.comparison);
    const selectedKey = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, identity.machineId, basePath, selectorKey, params.filePath]);
    const requestLifetime = React.useRef<AbortController | null>(null);
    // Navigation pins the identity returned by this capture before changing views.
    // That exact evidence is already loaded for this Account, host and source.
    const unpinnedKey = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, identity.machineId, basePath,
        scmComparisonKey(unpinnedComparison), params.filePath]);
    const getSnapshot = React.useCallback(() => {
        const reads = getScmDiffSummaryState().capturedReadsByKey;
        const unpinned = reads?.[unpinnedKey]?.value;
        return comparisonId && unpinned?.comparison?.id === comparisonId ? unpinned : reads?.[selectedKey]?.value ?? null;
    }, [selectedKey, unpinnedKey, comparisonId]);
    const subscribe = React.useCallback((listener: () => void) => scope
        ? subscribeScmDiffSummaryHostState(sessionId ? { sessionId } : { machineId: params.host.machineId!, cwd: basePath ?? '' },
            serverAccountScopeKeySuffix(scope), listener) : () => {},
    [scope?.serverId, scope?.accountId, sessionId, params.host.machineId, basePath]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    // A saved record may rediscover the same identity with only its first index page.
    // It must not replace the pages this owner already read for that capture.
    const knownOnly = known && known.id !== state?.comparison?.id ? known : null;
    const key = state?.key ?? selectedKey;
    const setState = React.useCallback((update: React.SetStateAction<CapturedScmRead | null>) => {
        if (binding) retainCapturedScmRead(binding, { ...params.host, cwd: basePath ?? '' }, key,
            previous => typeof update === 'function' ? update(previous) : update);
    }, [binding, key, sessionId, params.host.machineId, basePath]);
    const [retryToken, retry] = React.useReducer((value: number) => value + 1, 0);
    const selectorRef = React.useRef(params.comparison);
    selectorRef.current = params.comparison;
    React.useEffect(() => {
        if (!binding?.isCurrent() || !scope || !machine || params.active === false || knownOnly || !sourceAvailable) return;
        const abort = new AbortController();
        requestLifetime.current = abort;
        const retirement = binding.onRetire(() => abort.abort());
        const cleanup = () => {
            abort.abort(); retirement.dispose();
            setState(previous => previous?.loading ? { ...previous, loading: false } : previous);
        };
        // Responsive recomposition and Home navigation replace readers, not captured evidence.
        // Only an explicit Retry refreshes a settled read; More keeps its pinned cursor.
        const previous = getSnapshot();
        if (retryToken === 0 && previous && (previous.comparison || previous.error)) {
            if (previous.comparison && previous.comparison.freshness !== 'unknown' && previous.comparison.freshness !== 'stale') setState({ ...previous,
                comparison: { ...previous.comparison, freshness: 'unknown' } });
            return cleanup;
        }
        const current = () => !abort.signal.aborted && binding.isCurrent();
        const selected = selectorRef.current;
        setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null,
            page: previous?.key === key ? previous.page : null, error: null, loading: true }));
        const read = async () => {
            try {
                const result = await captureScmComparisonForSession({ ...params.host, serverId: scope.serverId,
                    scope, signal: abort.signal, shouldContinue: current,
                    input: { cwd: machine.basePath, source: scmComparisonSourceOf(selected, sessionId ?? ''),
                        projection: { kind: 'index', ...(params.filePath ? { path: params.filePath } : {}) },
                        ...(selected.comparisonId ? { comparisonId: selected.comparisonId } : {}) } });
                if (!current()) return;
                if (result.success) {
                    let comparison = result.comparison;
                    if (params.filePath) {
                        const files = await Promise.all(comparison.inventory.files.map(async file => {
                            if (file.evidence.state !== 'deferred') return file;
                            const response = await readCapturedScmFileForSession({ ...params.host, serverId: scope.serverId,
                                scope, signal: abort.signal, shouldContinue: current,
                                input: { cwd: comparison.repository.rootPath, comparisonId: comparison.id,
                                    source: comparison.source, path: file.path } });
                            if (!response.success || !('capturedFile' in response) || !response.capturedFile) {
                                const message = response.error ?? t('scmComparison.unsupportedReason');
                                throw createRpcCallError({ error: message, errorCode: response.errorCode });
                            }
                            return response.capturedFile;
                        }));
                        comparison = { ...comparison, inventory: { ...comparison.inventory, files } };
                    }
                    if (current()) setState({ key, comparison, page: result.page ?? null, error: null, loading: false });
                } else {
                    setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null,
                        page: previous?.key === key ? previous.page : null,
                        error: { message: result.error, ...(result.errorCode ? { code: result.errorCode } : {}) }, loading: false }));
                }
            } catch (error) {
                if (current()) setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null,
                    page: previous?.key === key ? previous.page : null,
                    error: { message: error instanceof Error ? error.message : t('scmComparison.unsupportedReason'),
                        ...(error instanceof RpcError ? { code: error.rpcErrorCode } : {}) }, loading: false }));
            }
        };
        void read();
        return cleanup;
    }, [binding, scope?.serverId, scope?.accountId, key, machine?.machineId, machine?.basePath, sessionId, sourceAvailable, params.active, knownOnly, retryToken]);
    const visible = scope && state?.key === key ? state : null;
    const loadMore = React.useCallback(async () => {
        const abort = requestLifetime.current;
        if (!scope || !binding || !abort || visible?.loading || !visible?.comparison || visible.page?.nextCursor == null) return;
        const current = () => !abort.signal.aborted && binding.isCurrent();
        const previous = visible.comparison;
        const cursor = visible.page.nextCursor;
        setState(state => state?.key === key ? { ...state, loading: true, error: null } : state);
        try {
            const result = await captureScmComparisonForSession({ ...params.host, serverId: scope.serverId, scope,
                signal: abort.signal, shouldContinue: current,
                input: { cwd: previous.repository.rootPath, source: previous.source, comparisonId: previous.id,
                    projection: { kind: 'index', cursor } } });
            if (!current()) return;
            if (!result.success) throw createRpcCallError({ error: result.error, errorCode: result.errorCode });
            setState(state => state?.key === key ? { ...state, loading: false, error: null, page: result.page ?? null,
                comparison: { ...previous, inventory: { ...previous.inventory,
                    files: [...previous.inventory.files, ...result.comparison.inventory.files] } } } : state);
        } catch (error) {
            if (current()) setState(state => state?.key === key ? { ...state, loading: false,
                error: { message: error instanceof Error ? error.message : t('scmComparison.unsupportedReason'),
                    ...(error instanceof RpcError ? { code: error.rpcErrorCode } : {}) } } : state);
        }
    }, [scope, binding, visible, key, params.host]);
    return { comparison: scope && sourceAvailable ? knownOnly ?? visible?.comparison ?? null : null,
        page: knownOnly ? null : visible?.page ?? null, loadMore,
        error: !sourceAvailable ? t('scmComparison.unsupportedReason') : knownOnly ? null : visible?.error?.message ?? null,
        loading: sourceAvailable && !knownOnly && (visible?.loading ?? Boolean(scope && machine && params.active !== false)), retry };
}
