import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { scmComparisonSourceOf, scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { captureScmComparisonForSession, readCapturedScmFileForSession } from '@/sync/ops/scmDiffSummary/generate';
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
    const selectorKey = scmComparisonKey(params.comparison);
    const selectedKey = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, identity.machineId, basePath, selectorKey, params.filePath]);
    type Page = Readonly<{ totalFiles: number; nextCursor: number | null }>;
    const [state, setState] = React.useState<Readonly<{ key: string; comparison: ScmComparison | null; error: string | null; loading: boolean; page: Page | null }> | null>(null);
    const requestLifetime = React.useRef<AbortController | null>(null);
    // Navigation pins the identity returned by this capture before changing views.
    // That exact evidence is already loaded for this Account, host and source.
    const unpinnedKey = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, identity.machineId, basePath,
        scmComparisonKey(unpinnedComparison), params.filePath]);
    const retained = comparisonId && state?.key === unpinnedKey
        && state.comparison?.id === comparisonId ? state.comparison : null;
    const key = retained ? unpinnedKey : selectedKey;
    const known = params.knownComparison && (!comparisonId || params.knownComparison.id === comparisonId)
        && params.knownComparison.repository.rootPath === basePath
        && scmReviewComparisonMatchesSource(params.comparison, params.knownComparison.source, params.knownComparison) ? params.knownComparison : null;
    const [retryToken, retry] = React.useReducer((value: number) => value + 1, 0);
    const selectorRef = React.useRef(params.comparison);
    selectorRef.current = params.comparison;
    React.useEffect(() => {
        if (!binding?.isCurrent() || !scope || !machine || params.active === false || known || !sourceAvailable) return;
        const abort = new AbortController();
        requestLifetime.current = abort;
        const retirement = binding.onRetire(() => abort.abort());
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
                                throw new Error(response.error ?? t('scmComparison.unsupportedReason'));
                            }
                            return response.capturedFile;
                        }));
                        comparison = { ...comparison, inventory: { ...comparison.inventory, files } };
                    }
                    if (current()) setState({ key, comparison, page: result.page ?? null, error: null, loading: false });
                } else {
                    const error = result.success ? t('scmComparison.unsupportedReason') : result.error;
                    setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null,
                        page: previous?.key === key ? previous.page : null, error, loading: false }));
                }
            } catch (error) {
                if (current()) setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null,
                    page: previous?.key === key ? previous.page : null,
                    error: error instanceof Error ? error.message : t('scmComparison.unsupportedReason'), loading: false }));
            }
        };
        void read();
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, scope?.serverId, scope?.accountId, key, machine?.machineId, machine?.basePath, sessionId, sourceAvailable, params.active, known, retryToken]);
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
            if (!result.success) throw new Error(result.error);
            setState(state => state?.key === key ? { ...state, loading: false, error: null, page: result.page ?? null,
                comparison: { ...previous, inventory: { ...previous.inventory,
                    files: [...previous.inventory.files, ...result.comparison.inventory.files] } } } : state);
        } catch (error) {
            if (current()) setState(state => state?.key === key ? { ...state, loading: false,
                error: error instanceof Error ? error.message : t('scmComparison.unsupportedReason') } : state);
        }
    }, [scope, binding, visible, key, params.host]);
    return { comparison: scope && sourceAvailable ? known ?? visible?.comparison ?? null : null,
        page: known ? null : visible?.page ?? null, loadMore,
        error: !sourceAvailable ? t('scmComparison.unsupportedReason') : known ? null : visible?.error ?? null,
        loading: sourceAvailable && !known && (visible?.loading ?? Boolean(scope && machine && params.active !== false)), retry };
}
