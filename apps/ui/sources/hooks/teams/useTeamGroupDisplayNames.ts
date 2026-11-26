import * as React from 'react';
import type { TeamGroupNameProjectionV1, TeamGroupV1 } from '@happier-dev/protocol/teams';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useScopedOpenedPrivateLabels } from '@/sync/ops/privateLabels/useOpenedPrivateLabels';
import { TEAM_GROUP_LABEL_READ_POLICY, teamGroupNameBinding } from '@/sync/ops/teams/teamGroupLabels';

export type TeamGroupNameProjectionInput = Readonly<{
    id: string;
    name: TeamGroupNameProjectionV1;
}>;

export type ScopedTeamGroupNameProjectionInput = TeamGroupNameProjectionInput & Readonly<{
    scope: ServerAccountScope;
}>;

export function teamGroupDisplayNameKey(scope: ServerAccountScope, groupId: string): string {
    return JSON.stringify([scope.serverId, scope.accountId, groupId]);
}

export type GroupLabelGrant = Readonly<{
    principal: PrincipalRefV1;
    groupName?: TeamGroupNameProjectionV1;
}>;

/**
 * Opens the recipient-safe names for one already-loaded Group collection.
 *
 * The Group snapshot owns rows and freshness; this hook only derives the
 * viewer's local presentation and withdraws stale decryptions on scope or row
 * replacement. It deliberately has no alternate key or plaintext path.
 */
export function useTeamGroupDisplayNames(params: Readonly<{
    scope: ServerAccountScope | null;
    groups: readonly TeamGroupV1[];
}>): ReadonlyMap<string, string | null> {
    return useTeamGroupNameProjectionDisplayNames(params);
}

/** Recipient-safe Group display names carried by resource-grant roster rows. */
export function useResourceGrantGroupDisplayNames(params: Readonly<{
    scope: ServerAccountScope | null;
    grants: readonly GroupLabelGrant[];
}>): ReadonlyMap<string, string | null> {
    const groups = React.useMemo<readonly TeamGroupNameProjectionInput[]>(() => params.grants.flatMap((grant) =>
        grant.principal.kind === 'group' && grant.groupName !== undefined
            ? [{ id: grant.principal.groupId, name: grant.groupName }]
            : []), [params.grants]);
    return useTeamGroupNameProjectionDisplayNames({ scope: params.scope, groups });
}

/**
 * Opens Group names for any already-loaded recipient-safe projection collection.
 * This is presentation-only: callers retain ownership of list paging and rows.
 */
export function useTeamGroupNameProjectionDisplayNames(params: Readonly<{
    scope: ServerAccountScope | null;
    groups: readonly TeamGroupNameProjectionInput[];
}>): ReadonlyMap<string, string | null> {
    const scopedGroups = React.useMemo(() => {
        const scope = params.scope;
        return scope ? params.groups.map((group) => ({ ...group, scope })) : [];
    }, [params.groups, params.scope?.serverId, params.scope?.accountId]);
    const opened = useScopedTeamGroupNameProjectionDisplayNames(scopedGroups);
    return React.useMemo(() => new Map(params.groups.map((group) => [group.id, params.scope
        ? opened.get(teamGroupDisplayNameKey(params.scope, group.id)) ?? null
        : null])), [opened, params.groups, params.scope?.serverId, params.scope?.accountId]);
}

/** One recipient-label owner for collections spanning several credential-bound Homes. */
export function useScopedTeamGroupNameProjectionDisplayNames(
    groups: readonly ScopedTeamGroupNameProjectionInput[],
): ReadonlyMap<string, string | null> {
    const requests = React.useMemo(() => groups.map(({ id, name, scope }) => ({
        scope,
        key: teamGroupDisplayNameKey(scope, id),
        binding: teamGroupNameBinding(id),
        label: name.kind === 'available' ? name.label : null,
        readPolicy: TEAM_GROUP_LABEL_READ_POLICY,
    })), [groups]);
    const opened = useScopedOpenedPrivateLabels(requests);
    return React.useMemo(() => new Map(groups.map(({ scope, id }) => {
        const key = teamGroupDisplayNameKey(scope, id);
        return [key, opened.get(serverAccountScopeKeySuffix(scope))?.[key] ?? null];
    })), [groups, opened]);
}
