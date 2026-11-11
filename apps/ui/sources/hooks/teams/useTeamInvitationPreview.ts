import * as React from 'react';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions';
import {
    TeamInvitationPreviewResultV1Schema,
    type TeamInvitationPreviewV1,
    type TeamInvitationPreviewResultV1,
} from '@happier-dev/protocol/teams';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';

import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { decodeBoundedJsonResponse } from '@/sync/api/capabilities/decodeBoundedJsonResponse';
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
        let current = true;
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
                // Method, path and body come from the preview Action row — the
                // single declaration of this intent's transport — exactly as the
                // authenticated family port binds its requests. The join screen is
                // pre-authentication, so it carries the bound request on the
                // credential-free exact-Home fetch instead of an Account scope.
                const boundRequest = bindHomeDomainActionHttpRequestV1('teams.invitations.preview', { v: 1, token });
                const response = await request(boundRequest.path, {
                    method: boundRequest.method,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(boundRequest.body),
                }, { includeAuth: false, retry: 'none' });
                if (!current) return;
                // Route failure is not evidence of an old binary. The canonical
                // exact-Home feature decision owns capability diagnostics.
                if (!response.ok) {
                    fail(response.status >= 500);
                    return;
                }
                const raw = await decodeBoundedJsonResponse(response, 64 * 1024);
                const outcome = TeamInvitationPreviewResultV1Schema.safeParse(raw);
                if (!outcome.success) {
                    fail(true);
                    return;
                }
                if (outcome.data.outcome === 'ok') {
                    setState({ scopeKey, value: { kind: 'ready', preview: outcome.data.preview } });
                    return;
                }
                // `feature_unavailable` is a capable Home's operator choice, not
                // an old binary, and not an unusable link: child 05 :437 requires
                // enabled, operator-disabled, unsupported and unreachable to stay
                // distinguishable, so the Home's own declared outcome is carried
                // through instead of being folded into `unavailable`.
                setState({
                    scopeKey,
                    value: outcome.data.outcome === 'feature_unavailable'
                        ? { kind: 'feature_unavailable' }
                        : { kind: 'unavailable', ...(outcome.data.reason ? { reason: outcome.data.reason } : {}) },
                });
            } catch {
                // An approval-pending or transport throw is not a description of
                // the invitation; the surface keeps its own retry.
                if (current) fail(true);
                return;
            }
        })();
        return () => { current = false; };
    }, [resolvedTarget, scopeKey, revision]);

    return state.scopeKey === scopeKey ? state.value : scopeKey ? LOADING : IDLE;
}
