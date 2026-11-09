import type { CollectionSpaceV1, QualifiedSessionSpaceTagV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { SessionSpaceMembershipTargetV1 } from '@happier-dev/protocol/actions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { buildSessionOrganizationServerKey } from './keys';
import { readSessionOrganizationSpaceMembership } from './tagLabels';
import type { UiSessionOrganizationTag } from './types';

/** A membership tag already carries the catalog identity; no settings association is needed. */
export function isSessionOrganizationTagForSpace(tag: UiSessionOrganizationTag, target: SessionSpaceMembershipTargetV1): boolean {
    const identity = readSessionOrganizationSpaceMembership(tag);
    return tag.archivedAt === null && identity?.spaceId === target.spaceId
        && identity.spaceSettingsTarget.accountId === target.spaceSettingsTarget.accountId
        && areServerProfileIdentifiersEquivalent(identity.spaceSettingsTarget.serverId, target.spaceSettingsTarget.serverId);
}

/** Keep subscriptions local to the opened tags belonging to this Space catalog. */
export function selectSessionSpaceMembershipTags(tags: Readonly<Record<string, UiSessionOrganizationTag>>,
    scope: AccountSettingsScope | null): Readonly<Record<string, UiSessionOrganizationTag>> {
    if (!scope) return {};
    return Object.fromEntries(Object.entries(tags).filter(([, tag]) => {
        const identity = readSessionOrganizationSpaceMembership(tag);
        return identity && isSessionOrganizationTagForSpace(tag, { ...identity, spaceSettingsTarget: scope });
    }));
}

/** All matching tags are members, including overlapping first preparations and historical links. */
export function projectSessionSpaceMemberships(spaces: readonly CollectionSpaceV1<'sessionWork'>[],
    tags: Readonly<Record<string, UiSessionOrganizationTag>>, viewerAccounts: ReadonlyMap<string, string>): readonly CollectionSpaceV1<'sessionWork'>[] {
    const relatedBySpace = new Map<string, QualifiedSessionSpaceTagV1[]>();
    for (const [serverId, accountId] of viewerAccounts) {
        for (const tag of Object.values(tags)) {
            if (tags[buildSessionOrganizationServerKey(serverId, tag.tagId)] !== tag) continue;
            const identity = readSessionOrganizationSpaceMembership(tag);
            if (!identity) continue;
            const related = relatedBySpace.get(identity.spaceId) ?? [];
            related.push({ serverId, accountId, tagId: tag.tagId });
            relatedBySpace.set(identity.spaceId, related);
        }
    }
    let changed = false;
    const projected = spaces.map(space => {
        const related = (relatedBySpace.get(space.id) ?? []).filter(tag => !space.membership?.tags.some(held =>
            held.accountId === tag.accountId && held.tagId === tag.tagId
            && areServerProfileIdentifiersEquivalent(held.serverId, tag.serverId)));
        if (!related.length) return space;
        changed = true;
        return { ...space, membership: { mode: space.membership?.mode ?? 'filter_or_manual',
            tags: [...space.membership?.tags ?? [], ...related] } } satisfies CollectionSpaceV1<'sessionWork'>;
    });
    return changed ? projected : spaces;
}
