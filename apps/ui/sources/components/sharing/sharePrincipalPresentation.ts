import type { AccountDisplayProfileV1, PrincipalRefV1 } from '@happier-dev/protocol';
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
