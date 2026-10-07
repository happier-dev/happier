import { TemporaryComputerActivationRefV1Schema } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import * as React from 'react';

import {
    recoverMaterializedTemporaryComputerSessionForSession,
    type MaterializedTemporaryComputerRecoveryCandidate,
} from '@/components/sessions/new/navigation/settleMaterializedTemporaryComputerSession';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { createRunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    listNewSessionDraftProjections,
    subscribeSessionDraftList,
    type NewSessionDraftProjection,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createServerRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

const EMPTY_DRAFTS = Object.freeze([]);

export function projectMaterializedTemporaryComputerRecoveryCandidates(
    drafts: readonly NewSessionDraftProjection[],
    readActivationRef: (draftId: string) => unknown,
): readonly MaterializedTemporaryComputerRecoveryCandidate[] {
    return drafts.flatMap((draft) => {
        const parsed = TemporaryComputerActivationRefV1Schema.safeParse(readActivationRef(draft.draftId));
        if (!parsed.success) return [];
        return [{
            draftId: draft.draftId,
            activationId: parsed.data.activationId,
            launchUserAttemptId: draft.localSupplement.launchUserAttemptId ?? null,
        } satisfies MaterializedTemporaryComputerRecoveryCandidate];
    });
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
    const subscribe = React.useCallback((listener: () => void) => (
        scope ? subscribeSessionDraftList(scope, listener) : () => undefined
    ), [scope]);
    const getSnapshot = React.useCallback(() => (
        scope ? listNewSessionDraftProjections(scope) : EMPTY_DRAFTS
    ), [scope]);
    const drafts = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const candidates = React.useMemo(
        () => projectMaterializedTemporaryComputerRecoveryCandidates(
            drafts,
            (draftId) => scope
                ? readNewSessionDraftFromRepository({ scope, draftId })?.temporaryComputerActivationRef
                : null,
        ),
        [drafts, scope],
    );
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
