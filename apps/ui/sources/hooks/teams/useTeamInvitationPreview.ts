import * as React from 'react';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import type { TeamInvitationPreviewV1, TeamInvitationPreviewResultV1 } from '@happier-dev/protocol/teams';
import { TEAM_INVITATION_PREVIEW_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { decodeBoundedJsonResponse } from '@/sync/api/capabilities/decodeBoundedJsonResponse';
import { homeDomainActionFailureFromDomainFailure } from '@/sync/api/home/homeDomainActions';
import { homeDomainFailureKindForHttpStatus } from '@/sync/api/home/homeServerActionTransport';
import { createServerFetchAtEndpoint } from '@/sync/http/client';

/**
 * The bounded invitation preview for one exact bearer on one exact Home.
 *
 * Preview is the canonical owner of what a join screen may say about an offer —
 * role, history horizon, expiry, masked recipient, the Home's own name and its
 * storage disclosure — and it never consumes the invitation. The screen renders
 * this and nothing it inferred elsewhere: the authentication entry projection
 * deliberately carries only the Team lockup, so reading consequences off it
 * would be a second, weaker answer to a question this owner already answers.
 *
 * `unavailable` stays generic when the Home supplies no reason. A known bearer's
 * typed terminal reason is retained for the join presenter; the client never
 * infers that reason or treats an unknown bearer as proof of a specific state.
 *
 * `feature_unavailable` is a different answer and stays distinct: the Home is
 * reachable and current, and has Teams administratively turned off. Collapsing
 * it into `unavailable` is what made a valid invitation read as "Team not
 * found", and it is the one state whose recovery is the Home's administrator
 * rather than a new link.
 */
export type TeamInvitationPreviewState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'loading' }>
    | Readonly<{
        kind: 'ready';
        preview: TeamInvitationPreviewV1;
        refreshing?: true;
        refreshFailure?: Readonly<{ retryable: boolean }>;
    }>
    | Readonly<{ kind: 'unavailable'; reason?: Extract<TeamInvitationPreviewResultV1, { outcome: 'unavailable' }>['reason'] }>
    | Readonly<{ kind: 'feature_unavailable' }>
    | Readonly<{ kind: 'failed'; retryable: boolean }>;

const IDLE: TeamInvitationPreviewState = Object.freeze({ kind: 'idle' as const });
const LOADING: TeamInvitationPreviewState = Object.freeze({ kind: 'loading' as const });

export function useTeamInvitationPreview(params: Readonly<{
    target: HomeTargetInput | null | undefined;
    token: string | null | undefined;
    /** Bumped by the surface's own retry so one control refreshes the whole page. */
    revision?: number;
}>): TeamInvitationPreviewState {
    const resolvedTarget = React.useMemo(
        () => params.target ? resolveHomeAuthenticationTarget(params.target) : null,
        [params.target],
    );
    const token = params.token ?? '';
    const revision = params.revision ?? 0;
    const scopeKey = resolvedTarget && token
        ? `${resolvedTarget.serverIdentityId}\u0000${resolvedTarget.endpointUrl}\u0000${token}`
        : null;
    const [state, setState] = React.useState<Readonly<{
        scopeKey: string | null;
        value: TeamInvitationPreviewState;
    }>>({ scopeKey: null, value: IDLE });

    React.useEffect(() => {
        if (!resolvedTarget || !scopeKey) {
            setState({ scopeKey: null, value: IDLE });
            return;
        }
        const controller = new AbortController();
        setState((previous) => ({
            scopeKey,
            value: previous.scopeKey === scopeKey && previous.value.kind === 'ready'
                ? { kind: 'ready', preview: previous.value.preview, refreshing: true }
                : LOADING,
        }));
        const fail = (retryable: boolean) => {
            setState((previous) => ({
                scopeKey,
                value: previous.scopeKey === scopeKey && previous.value.kind === 'ready'
                    ? { kind: 'ready', preview: previous.value.preview, refreshFailure: { retryable } }
                    : { kind: 'failed', retryable },
            }));
        };
        void (async () => {
            try {
                const request = createServerFetchAtEndpoint({
                    endpointUrl: resolvedTarget.endpointUrl,
                    serverId: resolvedTarget.serverId,
                    credentials: null,
                });
                const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
                if (controller.signal.aborted) return;
                // The bearer preview uses ordinary Action admission with a credential-free Home transport.
                const executor = createActionExecutor({
                    homeDomainAction: async ({ actionId, input, signal }) => {
                        const bound = bindHomeDomainActionHttpRequestV1(actionId, input);
                        return request(bound.path, {
                            method: bound.method,
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify(bound.body),
                            signal,
                        }, { includeAuth: false, retry: 'none' }, async (response) => {
                            if (response.ok) return decodeBoundedJsonResponse(response, 64 * 1024);
                            return homeDomainActionFailureFromDomainFailure(actionId, {
                                kind: homeDomainFailureKindForHttpStatus(response.status),
                                code: null,
                                retryable: response.status >= 500,
                                httpStatus: response.status,
                            });
                        });
                    },
                });
                const execution = await executor.execute(TEAM_INVITATION_PREVIEW_ACTION_ID_V1, { v: 1, token }, {
                    surface: 'ui',
                    authority: 'present_user',
                    actionCaller: { kind: 'host' },
                    serverId: resolvedTarget.serverId,
                    serverIdentityId: resolvedTarget.serverIdentityId,
                    signal: controller.signal,
                });
                if (controller.signal.aborted) return;
                if (!execution.ok) {
                    const details = execution.details;
                    const status = typeof details === 'object' && details !== null && 'httpStatus' in details
                        ? details.httpStatus : undefined;
                    fail(typeof status !== 'number' || status >= 500);
                    return;
                }
                // The Action executor has already validated this row's result schema.
                const outcome = execution.result as TeamInvitationPreviewResultV1;
                if (outcome.outcome === 'ok') {
                    setState({ scopeKey, value: { kind: 'ready', preview: outcome.preview } });
                    return;
                }
                // `feature_unavailable` is a capable Home's operator choice, not
                // an old binary, and not an unusable link: child 05 :437 requires
                // enabled, operator-disabled, unsupported and unreachable to stay
                // distinguishable, so the Home's own declared outcome is carried
                // through instead of being folded into `unavailable`.
                setState({
                    scopeKey,
                    value: outcome.outcome === 'feature_unavailable'
                        ? { kind: 'feature_unavailable' }
                        : { kind: 'unavailable', ...(outcome.reason ? { reason: outcome.reason } : {}) },
                });
            } catch {
                // An approval-pending or transport throw is not a description of
                // the invitation; the surface keeps its own retry.
                if (!controller.signal.aborted) fail(true);
                return;
            }
        })();
        return () => controller.abort();
    }, [resolvedTarget, scopeKey, revision]);

    return state.scopeKey === scopeKey ? state.value : scopeKey ? LOADING : IDLE;
}
