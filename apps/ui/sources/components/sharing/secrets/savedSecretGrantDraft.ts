import type { PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type { SavedSecretCatalogAudienceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';

/**
 * Who a Saved Secret should reach once the person saves: the people, Teams and Groups listed under
 * "Who has access". Nothing is written while it is edited; the host's one revision-fenced write
 * carries it.
 */
export type SavedSecretGrantDraft = readonly PrincipalRefV1[];

export function createEmptySavedSecretGrantDraft(): SavedSecretGrantDraft {
    return [];
}

export function savedSecretGrantDraftFromAudience(audience: SavedSecretCatalogAudienceV1 | null | undefined): SavedSecretGrantDraft {
    if (!audience) return [];
    return [
        ...audience.accounts.map((account): PrincipalRefV1 => ({ kind: 'account', accountId: account.accountId })),
        ...audience.teams.map((team): PrincipalRefV1 => ({ kind: 'team', teamId: team.teamId })),
        ...audience.groups.map((group): PrincipalRefV1 => ({ kind: 'group', teamId: group.teamId, groupId: group.groupId })),
    ];
}

/** The draft as the Saved Secret grant Actions take it: one id list per principal kind. */
export function savedSecretGrantInputs(draft: SavedSecretGrantDraft): Readonly<{
    accountGrants: string[];
    teamGrants: string[];
    groupGrants: string[];
}> {
    return {
        accountGrants: draft.flatMap((principal) => principal.kind === 'account' ? [principal.accountId] : []),
        teamGrants: draft.flatMap((principal) => principal.kind === 'team' ? [principal.teamId] : []),
        groupGrants: draft.flatMap((principal) => principal.kind === 'group' ? [principal.groupId] : []),
    };
}

export function sameSavedSecretGrantDraft(left: SavedSecretGrantDraft, right: SavedSecretGrantDraft): boolean {
    if (left.length !== right.length) return false;
    const keys = new Set(left.map(sessionAccessSubjectKey));
    return right.every((principal) => keys.has(sessionAccessSubjectKey(principal)));
}
