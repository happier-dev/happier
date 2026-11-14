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
    const { scope, groups } = params;
    const [opened, setOpened] = React.useState<ReadonlyMap<string, OpenedTeamGroupName>>(NO_OPENED_NAMES);
    const openedRef = React.useRef(opened);

    React.useEffect(() => {
        openedRef.current = opened;
    }, [opened]);

    React.useEffect(() => {
        const currentIds = new Set(groups.map((group) => group.id));
        const prune = (previous: ReadonlyMap<string, OpenedTeamGroupName>) => {
            let changed = false;
            const next = new Map<string, OpenedTeamGroupName>();
            for (const [groupId, name] of previous) {
                if (currentIds.has(groupId)) next.set(groupId, name);
                else changed = true;
            }
            return changed ? next : previous;
        };

        if (!scope) {
            setOpened((previous) => previous.size === 0 ? previous : NO_OPENED_NAMES);
            return;
        }

        const candidates = groups.filter((group) => group.name.kind === 'available'
            && openedRef.current.get(group.id)?.projection !== group.name);
        if (candidates.length === 0) {
            setOpened(prune);
            return;
        }

        const controller = new AbortController();
        const client = createPrivateLabelClient(scope);
        void Promise.all(candidates.map(async (group) => ({
            group,
            // One missing key or cancelled label must not suppress sibling rows.
            // Each ordinary failed reader stays explicitly unavailable while the
            // loaded structural list remains intact. Account lifecycle failures
            // withdraw the whole captured reader and must not publish siblings.
            value: await openTeamGroupNameProjection({ client, groupId: group.id, name: group.name, signal: controller.signal })
                .catch((error: unknown) => {
                    if (isPrivateLabelLifecycleFailureV1(error, controller.signal)) throw error;
                    return null;
                }),
        }))).then((resolved) => {
            if (controller.signal.aborted) return;
            setOpened((previous) => {
                const retained = prune(previous);
                const next = retained === previous
                    ? new Map<string, OpenedTeamGroupName>(previous)
                    : retained;
                for (const { group, value } of resolved) {
                    next.set(group.id, { projection: group.name, value });
                }
                return next;
            });
        }, () => {
            // Lifecycle refusal cancels this captured reader batch. Ordinary
            // label failures were handled per item above, so no sibling value is
            // published from a withdrawn Account context.
        });
        return () => controller.abort();
    }, [scope?.serverId, scope?.accountId, groups]);

    return React.useMemo(() => {
        const names = new Map<string, string | null>();
        for (const group of groups) {
            const current = opened.get(group.id);
            names.set(group.id, current?.projection === group.name ? current.value : null);
        }
        return names;
    }, [groups, opened]);
}
