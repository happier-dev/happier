import * as React from 'react';
import type { ScmComparison } from '@happier-dev/protocol';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryHost } from '@/sync/ops/scmDiffSummary/results';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { scmComparisonSourceOf, scmReviewComparisonMatchesSource } from '@/sync/domains/scm/diffSummary/selection';
import { captureScmComparisonForSession } from '@/sync/ops/scmDiffSummary/generate';
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
}>) {
    const binding = useServerCredentialAccountScopeBinding(params.serverId).binding;
    const scope = binding?.isCurrent() ? binding.scope : null;
    const { machine, identity } = params;
    const sessionId = params.host.sessionId ?? null;
    const sourceAvailable = Boolean(sessionId) || (params.comparison.kind !== 'session' && params.comparison.kind !== 'turnCheckpoint');
    const selectorKey = scmComparisonKey(params.comparison);
    const key = JSON.stringify([scope?.serverId, scope?.accountId, sessionId, identity.machineId, identity.basePath, selectorKey]);
    const known = params.knownComparison && (!params.comparison.comparisonId || params.knownComparison.id === params.comparison.comparisonId)
        && params.knownComparison.repository.rootPath === identity.basePath
        && scmReviewComparisonMatchesSource(params.comparison, params.knownComparison.source, params.knownComparison) ? params.knownComparison : null;
    const [state, setState] = React.useState<Readonly<{ key: string; comparison: ScmComparison | null; error: string | null; loading: boolean }> | null>(null);
    const [retryToken, retry] = React.useReducer((value: number) => value + 1, 0);
    const selectorRef = React.useRef(params.comparison);
    selectorRef.current = params.comparison;
    React.useEffect(() => {
        if (!binding || !scope || !machine || params.active === false || known || !sourceAvailable) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        const current = () => !abort.signal.aborted && binding.isCurrent();
        const selected = selectorRef.current;
        setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null, error: null, loading: true }));
        const read = async () => {
            try {
                const result = await captureScmComparisonForSession({ ...params.host, serverId: scope.serverId,
                    scope, signal: abort.signal, shouldContinue: current,
                    input: { cwd: machine.basePath, source: scmComparisonSourceOf(selected, sessionId ?? ''),
                        ...(selected.comparisonId ? { comparisonId: selected.comparisonId } : {}) } });
                if (!current()) return;
                if (result.success) {
                    setState({ key, comparison: result.comparison, error: null, loading: false });
                } else {
                    const error = result.success ? t('scmComparison.unsupportedReason') : result.error;
                    setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null, error, loading: false }));
                }
            } catch (error) {
                if (current()) setState((previous) => ({ key, comparison: previous?.key === key ? previous.comparison : null,
                    error: error instanceof Error ? error.message : t('scmComparison.unsupportedReason'), loading: false }));
            }
        };
        void read();
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, scope?.serverId, scope?.accountId, key, machine?.machineId, machine?.basePath, sessionId, sourceAvailable, params.active, known, retryToken]);
    const visible = scope && state?.key === key ? state : null;
    return { comparison: scope && sourceAvailable ? known ?? visible?.comparison ?? null : null,
        error: !sourceAvailable ? t('scmComparison.unsupportedReason') : known ? null : visible?.error ?? null,
        loading: sourceAvailable && !known && (visible?.loading ?? Boolean(scope && machine && params.active !== false)), retry };
}
