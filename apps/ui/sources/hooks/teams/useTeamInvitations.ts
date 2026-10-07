import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type {
    TeamInvitationEmailDeliveryAvailabilityV1,
    TeamInvitationRowV1,
    TeamInvitationStateV1,
} from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { serverAccountScopedTeamResourceKey } from '@/sync/domains/teams/teamAddress';
import { listTeamInvitations } from '@/sync/ops/teams/teamInvitationOperations';

import { useTeamPagedList, type TeamPagedList } from './useTeamPagedList';

/**
 * One Team's invitations for one exact Home and Account.
 *
 * Rows carry no bearer — the secret is delivered once, at creation — so this is
 * a safe governance list a manager can review, and a lost link is answered by
 * reissuing rather than by re-reading anything here.
 *
 * `emailDelivery` is the Home's own answer about whether it can currently mail
 * an invitation, and `linkDelivery` whether it can render a shareable join link
 * at all; both are carried on the same authenticated page rather than guessed
 * from this device. Each is `null` until the Home has answered once, which is why
 * the surfaces treat that as "do not offer this yet" rather than as unavailable.
 */
export type TeamInvitationsRoster = TeamPagedList<TeamInvitationRowV1> & Readonly<{
    emailDelivery: TeamInvitationEmailDeliveryAvailabilityV1 | null;
    linkDelivery: TeamInvitationEmailDeliveryAvailabilityV1 | null;
}>;

export function useTeamInvitations(params: Readonly<{
    scope: ServerAccountScope | null;
    address: TeamAddress | null;
    /** `null` shows every retained state, including terminal provenance. */
    state: TeamInvitationStateV1 | null;
    enabled: boolean;
    /**
     * For a caller that wants the Home's delivery answer and not the roster.
     * The invite sheet renders no rows, so it asks for the smallest page.
     */
    limit?: number;
}>): TeamInvitationsRoster {
    const serverId = params.scope?.serverId ?? '';
    const accountId = params.scope?.accountId ?? '';
    const teamId = params.address?.teamId ?? '';
    const { state, limit } = params;
    const sequenceKey = serverAccountScopedTeamResourceKey(
        { serverId, accountId },
        { serverId, teamId },
        'invitations',
        state ?? 'all',
    );
    const activeSequenceKeyRef = React.useRef(sequenceKey);
    activeSequenceKeyRef.current = sequenceKey;
    const [emailDelivery, setEmailDelivery] = React
        .useState<TeamInvitationEmailDeliveryAvailabilityV1 | null>(null);
    const [linkDelivery, setLinkDelivery] = React
        .useState<TeamInvitationEmailDeliveryAvailabilityV1 | null>(null);

    React.useEffect(() => {
        setEmailDelivery(null);
        setLinkDelivery(null);
    }, [sequenceKey]);

    const loadPage = React.useCallback(
        async (cursor: string | null) => {
            const outcome = await listTeamInvitations({
                scope: { serverId, accountId },
                address: { serverId, teamId },
                state,
                cursor,
                ...(limit === undefined ? {} : { limit }),
            });
            // Read from the answer rather than kept as separate state to refresh:
            // every page of one sequence carries the same Home fact, and a failed
            // page leaves the last answer standing instead of blanking the offer.
            if (outcome.kind === 'succeeded' && activeSequenceKeyRef.current === sequenceKey) {
                setEmailDelivery(outcome.value.emailDelivery);
                setLinkDelivery(outcome.value.linkDelivery);
            }
            return outcome;
        },
        [serverId, accountId, teamId, state, limit, sequenceKey],
    );

    const list = useTeamPagedList<TeamInvitationRowV1>({
        key: params.scope && params.address ? sequenceKey : '',
        enabled: params.enabled && serverId !== '' && accountId !== '' && teamId !== '',
        loadPage,
        accountChange: { serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });

    return React.useMemo(
        () => Object.freeze({ ...list, emailDelivery, linkDelivery }),
        [list, emailDelivery, linkDelivery],
    );
}
