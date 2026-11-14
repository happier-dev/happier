import * as React from 'react';
import type { TeamGroupNameProjectionV1, TeamGroupV1 } from '@happier-dev/protocol/teams';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createPrivateLabelClient, isPrivateLabelLifecycleFailureV1 } from '@/sync/ops/privateLabels/privateLabelClient';
import { openTeamGroupNameProjection } from '@/sync/ops/teams/teamGroupLabels';

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

type OpenedTeamGroupName = Readonly<{
    projection: TeamGroupNameProjectionV1;
    value: string | null;
}>;

const NO_OPENED_NAMES: ReadonlyMap<string, OpenedTeamGroupName> = new Map();

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
    const [opened, setOpened] = React.useState<ReadonlyMap<string, OpenedTeamGroupName>>(NO_OPENED_NAMES);
    const openedRef = React.useRef(opened);

    React.useEffect(() => {
        openedRef.current = opened;
    }, [opened]);

    React.useEffect(() => {
        const currentIds = new Set(groups.map((group) => teamGroupDisplayNameKey(group.scope, group.id)));
        const prune = (previous: ReadonlyMap<string, OpenedTeamGroupName>) => {
            let changed = false;
            const next = new Map<string, OpenedTeamGroupName>();
            for (const [groupId, name] of previous) {
                if (currentIds.has(groupId)) next.set(groupId, name);
                else changed = true;
            }
            return changed ? next : previous;
        };

        const candidates = groups.filter((group) => group.name.kind === 'available'
            && openedRef.current.get(teamGroupDisplayNameKey(group.scope, group.id))?.projection !== group.name);
        if (candidates.length === 0) {
            setOpened(prune);
            return;
        }

        const controller = new AbortController();
        const byScope = new Map<string, ScopedTeamGroupNameProjectionInput[]>();
        for (const group of candidates) {
            const scopeKey = JSON.stringify([group.scope.serverId, group.scope.accountId]);
            const batch = byScope.get(scopeKey) ?? [];
            batch.push(group);
            byScope.set(scopeKey, batch);
        }
        for (const batch of byScope.values()) {
            const client = createPrivateLabelClient(batch[0]!.scope);
            void Promise.all(batch.map(async (group) => ({
                group,
                // Ordinary label failures stay local to the row. An Account
                // lifecycle refusal withdraws this Home's captured batch.
                value: await openTeamGroupNameProjection({ client, groupId: group.id, name: group.name, signal: controller.signal })
                    .catch((error: unknown) => {
                        if (isPrivateLabelLifecycleFailureV1(error, controller.signal)) throw error;
                        return null;
                    }),
            }))).then((resolved) => {
                if (controller.signal.aborted) return;
                setOpened((previous) => {
                    const next = new Map(prune(previous));
                    for (const { group, value } of resolved) {
                        next.set(teamGroupDisplayNameKey(group.scope, group.id), { projection: group.name, value });
                    }
                    return next;
                });
            }, () => {
                // Other Homes retain their independently opened labels.
            });
        }
        return () => controller.abort();
    }, [groups]);

    return React.useMemo(() => {
        const names = new Map<string, string | null>();
        for (const group of groups) {
            const key = teamGroupDisplayNameKey(group.scope, group.id);
            const current = opened.get(key);
            names.set(key, current?.projection === group.name ? current.value : null);
        }
        return names;
    }, [groups, opened]);
}
