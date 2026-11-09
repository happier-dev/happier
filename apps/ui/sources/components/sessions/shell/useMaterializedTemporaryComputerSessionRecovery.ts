import * as React from 'react';

import {
    recoverMaterializedTemporaryComputerSessionForSession,
    type MaterializedTemporaryComputerRecoveryCandidate,
} from '@/components/sessions/new/navigation/settleMaterializedTemporaryComputerSession';
import { resolveRunnerDraftActivation } from '@/components/sessions/drafts/newSessionDraftDeletion';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { createRunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    listNewSessionDraftProjections,
    subscribeSessionDraftList,
    type NewSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createServerRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

const EMPTY_DRAFTS: readonly NewSessionDraftProjection[] = Object.freeze([]);

export function projectMaterializedTemporaryComputerRecoveryCandidates(
    drafts: readonly NewSessionDraftProjection[],
): readonly MaterializedTemporaryComputerRecoveryCandidate[] {
    return drafts.flatMap((draft) => {
        const publicRef = resolveRunnerDraftActivation(draft).publicRef;
        if (!publicRef) return [];
        return [{
            draftId: draft.draftId,
            activationId: publicRef.activationId,
            launchUserAttemptId: draft.localSupplement.launchUserAttemptId ?? null,
        } satisfies MaterializedTemporaryComputerRecoveryCandidate];
    });
}

/**
 * The Account's recovery candidates, retained while they are unchanged. The new Session draft list
 * republishes for every edit of any new Session draft on any device, and almost none of those edits
 * touch an activation reference, so the Session host does not render (or re-run recovery) for them.
 */
export function useMaterializedTemporaryComputerRecoveryCandidates(
    scope: ServerAccountScope | null,
): readonly MaterializedTemporaryComputerRecoveryCandidate[] {
    const retained = React.useRef<Readonly<{
        drafts: readonly NewSessionDraftProjection[];
        candidates: readonly MaterializedTemporaryComputerRecoveryCandidate[];
    }> | null>(null);
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraftList(scope, listener) : () => undefined
    ), [scope]);
    const getSnapshot = React.useCallback(() => {
        const drafts = scope ? listNewSessionDraftProjections(scope) : EMPTY_DRAFTS;
        const previous = retained.current;
        if (previous?.drafts === drafts) return previous.candidates;
        const candidates = retainIfEqual(previous?.candidates, projectMaterializedTemporaryComputerRecoveryCandidates(drafts));
        retained.current = { drafts, candidates };
        return candidates;
    }, [scope]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Continues creator-owned post-materialization work from the ordinary Session
 * entry point. The synchronized draft supplies only discovery; exact activation
 * state and local creator custody remain the existing authorities.
 */
export function useMaterializedTemporaryComputerSessionRecovery(input: Readonly<{
    sessionId: string;
    serverId: string | null | undefined;
    sessionPresent: boolean;
    retrySignal: string | number | null;
}>): Readonly<{ status: 'idle' | 'recovering' | 'failed'; retry: () => void }> {
    const [manualRetry, retry] = React.useReducer((value: number) => value + 1, 0);
    const [status, setStatus] = React.useState<'idle' | 'recovering' | 'failed'>('idle');
    const scopeResolution = useServerCredentialAccountScopeResolution(input.serverId);
    const scope = scopeResolution.kind === 'bound' ? scopeResolution.scope : null;
    const candidates = useMaterializedTemporaryComputerRecoveryCandidates(scope);
    useServerProfilesGeneration();
    const profile = input.serverId ? getServerProfileById(input.serverId) : null;
    const client = React.useMemo(() => {
        if (!scope || !profile) return null;
        const activeRequest = createServerFetchAtEndpoint({
            endpointUrl: profile.serverUrl,
            serverId: scope.serverId,
        });
        return createRunnerActivationClient(createServerRequestForServerAccountScope({
            scope,
            activeRequest,
        }));
    }, [profile, scope]);

    React.useEffect(() => {
        if (!input.sessionPresent || !scope || !client || candidates.length === 0) {
            setStatus('idle');
            return;
        }
        const controller = new AbortController();
        setStatus('recovering');
        fireAndForget((async () => {
            try {
                const outcome = await recoverMaterializedTemporaryComputerSessionForSession({
                    scope,
                    sessionId: input.sessionId,
                    candidates,
                    readActivation: (activationId) => client.read(activationId, controller.signal),
                });
                if (!controller.signal.aborted) {
                    setStatus(outcome === 'retryable_unavailable' ? 'failed' : 'idle');
                }
            } catch (error) {
                if (!controller.signal.aborted) setStatus('failed');
            }
        })(), { tag: 'SessionView.recoverMaterializedTemporaryComputerSession' });
        return () => controller.abort();
    }, [candidates, client, input.retrySignal, input.sessionId, input.sessionPresent, manualRetry, scope]);
    return { status, retry };
}
