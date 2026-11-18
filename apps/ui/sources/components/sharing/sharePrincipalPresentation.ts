import type { AccountDisplayProfileV1} from '@happier-dev/protocol/account/accountDisplayProfileV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { formatAccountDisplayName, resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';
import type { SharePrincipalPresentation } from './shareSheetTypes';

export function sharePrincipalKey(ref: PrincipalRefV1): string {
    switch (ref.kind) {
        case 'account': return `account:${ref.accountId}`;
        case 'team': return `team:${ref.teamId}`;
        case 'group': return `group:${ref.teamId}:${ref.groupId}`;
    }
}

/** Safe display inputs from an acknowledged audience or directory, never authority inferred from a name. */
export function presentSharePrincipal(input: Readonly<{
    ref: PrincipalRefV1;
    name?: string | null;
    username?: string | null;
    profile?: AccountDisplayProfileV1 | null;
    viewerProfile?: AccountDisplayProfileV1 | null;
    avatarUrl?: string | null;
    teamName?: string | null;
    viewerAccountId?: string | null;
}>): SharePrincipalPresentation {
    const { ref } = input;
    const key = sharePrincipalKey(ref);
    if (ref.kind !== 'account') {
        const displayName = input.name?.trim() || t(ref.kind === 'team' ? 'shareSheet.team' : 'shareSheet.group');
        const secondaryLabel = input.teamName?.trim() || undefined;
        return { ref, key, displayName, ...(secondaryLabel ? { secondaryLabel } : {}),
            accessibilityLabel: secondaryLabel ? `${displayName}, ${secondaryLabel}` : displayName };
    }
    const viewerProfile = ref.accountId === input.viewerAccountId ? input.viewerProfile : null;
    // A scoped profile may still be its empty loading default. Do not erase an acknowledged name.
    const profile = viewerProfile && formatAccountDisplayName(viewerProfile) ? viewerProfile : input.profile;
    const person = resolveAccountDisplayName({ profile, accountId: ref.accountId,
        viewerAccountId: input.viewerAccountId });
    const username = input.username?.trim() || profile?.username?.trim();
    const displayName = person.viewer && person.named ? person.name
        : input.name?.trim() || (person.named || person.viewer || !username ? person.name : `@${username}`);
    const secondaryLabel = person.viewer ? t('shareSheet.you')
        : username ? displayName !== `@${username}` ? `@${username}` : undefined
            : input.name?.trim() ? undefined : person.hint ?? undefined;
    const avatarUrl = input.avatarUrl || viewerProfile?.avatarUrl || profile?.avatarUrl;
    return { ref, key, displayName, ...(secondaryLabel ? { secondaryLabel } : {}),
        avatar: { id: ref.accountId, ...(avatarUrl ? { imageUrl: avatarUrl } : {}) },
        accessibilityLabel: secondaryLabel ? `${displayName}, ${secondaryLabel}` : displayName };
}

/** An explicit grant to the owning Team adds no one to the displayed audience. */
export function isGrantToOwningTeam(owner: PrincipalRefV1 | undefined, principal: PrincipalRefV1): boolean {
    return owner?.kind === 'team' && principal.kind === 'team' && principal.teamId === owner.teamId;
}

/** Compact sharing summary from the displayed resource's admitted audience. */
export function presentShareAudience(input: Readonly<{
    owner?: PrincipalRefV1;
    grants: readonly Readonly<{ principal: PrincipalRefV1 }>[];
    teamName: (teamId: string) => string | null;
}>): string {
    const { owner, grants, teamName } = input;
    const owningTeam = owner?.kind === 'team' ? owner : null;
    const count = grants.length + (owningTeam && !grants.some(({ principal }) => isGrantToOwningTeam(owningTeam, principal)) ? 1 : 0);
    if (count === 0) return t('projects.sources.onlyMe');
    const only = count === 1 ? owningTeam ?? grants[0]?.principal : null;
    if (only?.kind === 'team') {
        const team = teamName(only.teamId) || (owningTeam ? t('shareSheet.team') : null);
        if (team) return t('projects.sources.teamEveryone', { team });
    }
    return t('projects.sources.audienceCount', { count });
}
