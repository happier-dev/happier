import * as React from 'react';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import type { ScmDiffSummaryEntry, ScmDiffSummaryViewModel } from '@/sync/domains/scm/diffSummary/state';
import { selectSessionScmWalkthroughKey } from '@/sync/domains/scm/diffSummary/selection';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    getScmDiffSummaryOperationState,
    getScmDiffSummaryState,
    subscribeScmDiffSummaryState,
    retireScmDiffSummaryScope,
} from '@/sync/ops/scmDiffSummary/generate';

/**
 * The walkthrough analysis behind a comparison view: the existing diff-summary request state (its
 * captured comparison, per-output progress, analysis coverage and result identity), read through the
 * one store. Null when this Session has not asked for a walkthrough of this comparison.
 */
export function useSessionScmWalkthrough(sessionId: string, comparison: SessionScmReviewComparison | null, output: ScmDiffSummaryOutputKind = 'walkthrough', serverId?: string | null): ScmDiffSummaryViewModel | null {
    const binding = useServerCredentialAccountScopeBinding(serverId).binding;
    const scopeKey = binding?.isCurrent() ? serverAccountScopeKeySuffix(binding.scope) : null;
    React.useEffect(() => {
        if (!binding) return;
        const retirement = binding.onRetire(() => retireScmDiffSummaryScope(binding.scope));
        return () => retirement.dispose();
    }, [binding]);
    const getSnapshot = React.useMemo(() => {
        let previousEntry: ScmDiffSummaryEntry | undefined;
        let projection: ScmDiffSummaryViewModel | null = null;
        return () => {
            if (!scopeKey || !binding?.isCurrent()) return null;
            const state = getScmDiffSummaryState();
            const key = selectSessionScmWalkthroughKey(state, sessionId, comparison, output, scopeKey);
            const entry = key ? state.entriesByKey[key] : undefined;
            if (entry === previousEntry) return projection;
            previousEntry = entry;
            projection = key ? getScmDiffSummaryOperationState(state, key) : null;
            return projection;
        };
    }, [sessionId, comparison, output, scopeKey, binding]);
    return React.useSyncExternalStore(subscribeScmDiffSummaryState, getSnapshot, getSnapshot);
}
