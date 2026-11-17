import * as React from 'react';
import type { TeamSummaryV1 } from '@happier-dev/protocol/teams/projections';

import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { serverAccountScopedTeamKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { useHomeSetupDismissals } from '../layout/useHomeSetupDismissals';

export type TeamSetupOffer = Readonly<{
    stepId: string;
    address: TeamAddress;
    teamName: string;
    logo: TeamSummaryV1['logo'];
}>;

/** The layout already belongs to an Account; the key also names the exact viewed Home/Account/Team. */
export function teamSetupStepId(scope: ServerAccountScope, address: TeamAddress): string {
    return `team:${serverAccountScopedTeamKey(scope, { serverId: scope.serverId, teamId: address.teamId })}`;
}

/** The selected setup page can retire its Home offer without observing the Teams directory. */
export function useTeamSetupDismissal(): (address: TeamAddress) => Promise<void> {
    const { dismiss } = useHomeSetupDismissals();
    return React.useCallback(async (address: TeamAddress) => {
        const account = await resolveServerCredentialAccountScope(address.serverId);
        if (account.kind !== 'bound') throw Object.assign(new Error(account.kind), { code: account.kind });
        await dismiss(teamSetupStepId(account.scope, address));
    }, [dismiss]);
}

/** Home offers the latest known join per Home; selected setup owns resource and Machine reads. */
export function useTeamSetupOffers(): Readonly<{
    offers: readonly TeamSetupOffer[];
    dismiss(address: TeamAddress): Promise<void>;
    complete(address: TeamAddress): Promise<void>;
}> {
    const directory = useTeamsDirectory();
    const { hasSnapshot, hidden } = useHomeSetupDismissals();
    const dismiss = useTeamSetupDismissal();
    const previous = React.useRef<readonly TeamSetupOffer[] | null>(null);
    const offers = React.useMemo(() => {
        const scopes = new Map(directory.scopes.map(scope => [scope.serverId, scope]));
        const incoming: TeamSetupOffer[] = [];
        const latestByHome = new Map<string, (typeof directory.rows)[number]>();
        if (hasSnapshot) for (const row of directory.rows) {
            const scope = scopes.get(resolveServerProfileScopeIdForIdentifier(row.address.serverId));
            if (!scope || row.team.viewerJoinedAt == null) continue;
            const latest = latestByHome.get(scope.serverId);
            if (!latest || row.team.viewerJoinedAt > latest.team.viewerJoinedAt!
                || (row.team.viewerJoinedAt === latest.team.viewerJoinedAt && row.team.id < latest.team.id)) {
                latestByHome.set(scope.serverId, row);
            }
        }
        // Select before dismissal: dismissing the latest join must not turn
        // historical memberships into a queue of unsolicited setup offers.
        for (const [serverId, row] of latestByHome) {
            const scope = scopes.get(serverId)!;
            const stepId = teamSetupStepId(scope, row.address);
            if (!hidden.has(stepId)) incoming.push({ stepId, address: row.address, teamName: row.team.name, logo: row.team.logo });
        }
        const next = retainKeyedRows(previous.current, incoming, offer => offer.stepId);
        previous.current = next;
        return next;
    }, [directory.rows, directory.scopes, hasSnapshot, hidden]);
    return React.useMemo(() => ({ offers, dismiss, complete: dismiss }), [offers, dismiss]);
}
