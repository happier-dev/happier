import * as React from 'react';
import type { AccountDisplayProfileV1} from '@happier-dev/protocol/account/accountDisplayProfileV1';
import type { PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type { SavedSecretCatalogAudienceV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { sessionAccessSubjectKey } from '@/components/sessions/access/projectSessionAccessEditorSnapshot';
import { presentSharePrincipal } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import { useAudienceDraftShareController } from '../useAudienceDraftShareController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type {
    SharePrincipalPresentation,
    ShareSheetActions,
    ShareSheetModel,
    ShareUiReason,
} from '../shareSheetTypes';
import type { SavedSecretGrantDraft } from './savedSecretGrantDraft';

export function savedSecretAudiencePresentations(audience: SavedSecretCatalogAudienceV1 | undefined, viewerAccountId: string, viewerProfile: AccountDisplayProfileV1 | null): Readonly<Record<string, SharePrincipalPresentation>> {
    const values: Record<string, SharePrincipalPresentation> = {};
    for (const account of audience?.accounts ?? []) {
        const ref: PrincipalRefV1 = { kind: 'account', accountId: account.accountId };
        values[sessionAccessSubjectKey(ref)] = presentSharePrincipal({ ref,
            profile: account.accountId === viewerAccountId && viewerProfile ? viewerProfile : account,
            avatarUrl: account.avatarUrl, viewerAccountId });
    }
    for (const team of audience?.teams ?? []) {
        const ref: PrincipalRefV1 = { kind: 'team', teamId: team.teamId };
        values[sessionAccessSubjectKey(ref)] = presentSharePrincipal({ ref, name: team.name });
    }
    for (const group of audience?.groups ?? []) {
        const ref: PrincipalRefV1 = { kind: 'group', teamId: group.teamId, groupId: group.groupId };
        values[sessionAccessSubjectKey(ref)] = presentSharePrincipal({ ref, name: group.name, teamName: group.teamName });
    }
    return values;
}

/**
 * The Saved Secret adapter's controller: the shared draft-audience controller with the secret's
 * one level ("Can use") and the names of the audience the Home holds now. The host's Save is the
 * one write, through the existing Saved Secret grant Actions.
 */
export function useSavedSecretShareController(input: Readonly<{
    scope: ServerAccountScope;
    draft: SavedSecretGrantDraft;
    onChange: (draft: SavedSecretGrantDraft) => void;
    disabled: boolean;
    retainedAudience?: SavedSecretCatalogAudienceV1;
}>): Readonly<{ model: ShareSheetModel; actions: ShareSheetActions; notice?: ShareUiReason }> {
    const viewerProfile = useShareViewerProfile(input.scope);
    const retainedNames = React.useMemo(() => savedSecretAudiencePresentations(input.retainedAudience, input.scope.accountId, viewerProfile),
        [input.retainedAudience, input.scope.accountId, viewerProfile]);
    const lockReason = React.useMemo<ShareUiReason>(() => ({ code: 'saved_secret_single_level', message: t('shareSheet.secrets.oneLevel') }), []);
    return useAudienceDraftShareController({ scope: input.scope, draft: input.draft, onChange: input.onChange,
        disabled: input.disabled, lockReason, retainedNames });
}
