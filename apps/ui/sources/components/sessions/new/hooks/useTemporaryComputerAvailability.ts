import * as React from 'react';
import type { FeatureDecision } from '@happier-dev/protocol';
import type { VerifiedRunnerArtifactV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import type { RunnerArtifactPublicationFailureV1 } from '@happier-dev/protocol/ephemeralRunner/errors';

import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import {
    createRunnerActivationClient,
    type RunnerActivationClient,
    type RunnerActivationClientErrorCode,
    type RunnerActivationClientError,
} from '@/sync/api/ephemeralRunner/runnerActivationClient';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createServerRequestForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

/**
 * Why this Home cannot currently offer Temporary computer as a *destination*.
 *
 * Deliberately excludes Agent/model/broker compatibility: whether the authored
 * request can be launched onto a temporary computer is launch readiness, owned
 * by `temporaryComputerLaunchReadiness`. Folding it in here used to delete the
 * destination row entirely for an incompatible Agent, which left the user with
 * no row, no reason and no recovery.
 */
export type TemporaryComputerUnavailableReason =
    | 'feature_disabled'
    | 'automation_unsupported'
    | 'home_unavailable'
    | 'home_identity_unavailable'
    | 'account_scope_unavailable'
    | 'artifact_unavailable'
    | RunnerActivationClientErrorCode;

export type TemporaryComputerAvailability =
    | Readonly<{ status: 'loading'; retry: () => void }>
    | Readonly<{ status: 'unavailable'; reason: TemporaryComputerUnavailableReason;
        publicationFailure?: RunnerArtifactPublicationFailureV1; retry: () => void }>
    | Readonly<{
        status: 'available';
        artifacts: readonly VerifiedRunnerArtifactV1[];
        client: RunnerActivationClient;
        retry: () => void;
    }>;

export type TemporaryComputerDestinationProjectionState = 'pending' | 'empty' | 'available';

/**
 * Projects the Temporary-computer owner into the only three facts a destination picker needs.
 * Transport/protocol failures remain pending: they do not prove that no alternate destination exists.
 */
export function resolveTemporaryComputerDestinationProjectionState(
    availability: TemporaryComputerAvailability,
): TemporaryComputerDestinationProjectionState {
    if (availability.status === 'loading') return 'pending';
    if (availability.status === 'available') return 'available';
    switch (availability.reason) {
        case 'feature_disabled':
        case 'automation_unsupported':
        case 'home_unavailable':
        case 'home_identity_unavailable':
        case 'account_scope_unavailable':
        case 'artifact_unavailable':
            return 'empty';
        default:
            return 'pending';
    }
}

export function resolveTemporaryComputerEligibility(input: Readonly<{
    decision: FeatureDecision | null;
    interactive: boolean;
    profile: ServerProfile | null;
    accountScopeAvailable: boolean;
}>): 'loading' | TemporaryComputerUnavailableReason | 'eligible' {
    if (!input.interactive) return 'automation_unsupported';
    if (input.decision === null) return 'loading';
    if (input.decision.state !== 'enabled') return 'feature_disabled';
    if (!input.profile) return 'home_unavailable';
    if (!input.profile.homeConnectionDescriptor?.homeServerIdentityId) return 'home_identity_unavailable';
    if (!input.accountScopeAvailable) return 'account_scope_unavailable';
    return 'eligible';
}

/** One fail-closed decision and artifact projection for the mounted New Session target picker. */
export function useTemporaryComputerAvailability(input: Readonly<{
    serverId: string | null;
    accountScope: ServerAccountScope | null;
    profile: ServerProfile | null;
    interactive: boolean;
}>): TemporaryComputerAvailability {
    const decision = useFeatureDecision('sessions.ephemeralRunner', {
        scopeKind: 'spawn',
        serverId: input.serverId,
    });
    const [generation, setGeneration] = React.useState(0);
    const retry = React.useCallback(() => setGeneration((value) => value + 1), []);
    const eligibility = resolveTemporaryComputerEligibility({
        decision,
        interactive: input.interactive,
        profile: input.profile,
        accountScopeAvailable: input.accountScope !== null
            && input.accountScope.serverId === input.serverId,
    });
    const projectionContextKey = [
        input.serverId ?? '',
        input.accountScope?.accountId ?? '',
        input.profile?.serverUrl ?? '',
        input.profile?.homeConnectionDescriptor?.homeServerIdentityId ?? '',
        eligibility,
        generation,
    ].join('\u0000');
    const [loaded, setLoaded] = React.useState<Readonly<{
        contextKey: string;
        result: Exclude<TemporaryComputerAvailability, { status: 'loading' }>;
    }> | null>(null);

    React.useEffect(() => {
        if (eligibility !== 'eligible' || !input.serverId || !input.profile || !input.accountScope) return;
        // A superseded Home or an unmounted picker cancels its safe projection
        // read at the transport: a canceled read is not a typed unavailability.
        const abortController = new AbortController();
        const endpointRequest = createServerFetchAtEndpoint({
            endpointUrl: input.profile.serverUrl,
            serverId: input.serverId,
        });
        const client = createRunnerActivationClient(createServerRequestForServerAccountScope({
            scope: input.accountScope,
            activeRequest: endpointRequest,
        }));
        void client.listArtifacts(abortController.signal).then((projection) => {
            if (abortController.signal.aborted) return;
            setLoaded({
                contextKey: projectionContextKey,
                result: projection.artifacts.length > 0
                    ? { status: 'available', artifacts: projection.artifacts, client, retry }
                    : { status: 'unavailable', reason: 'artifact_unavailable', retry },
            });
        }).catch((error: RunnerActivationClientError) => {
            if (abortController.signal.aborted) return;
            const reason = error?.code ?? 'request_failed';
            setLoaded({ contextKey: projectionContextKey, result: { status: 'unavailable', reason, retry,
                ...(error?.publicationFailure ? { publicationFailure: error.publicationFailure } : {}),
            } });
        });
        return () => {
            abortController.abort(new Error('runner_artifact_projection_read_superseded'));
        };
    }, [eligibility, input.accountScope?.accountId, input.accountScope?.serverId, input.profile, input.serverId, projectionContextKey, retry]);

    if (eligibility === 'loading') return { status: 'loading', retry };
    if (eligibility !== 'eligible') return { status: 'unavailable', reason: eligibility, retry };
    if (!loaded || loaded.contextKey !== projectionContextKey) return { status: 'loading', retry };
    return loaded.result;
}
