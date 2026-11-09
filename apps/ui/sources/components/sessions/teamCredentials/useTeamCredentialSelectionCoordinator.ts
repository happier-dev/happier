import * as React from 'react';
import type { TeamCredentialResourceCatalogEntryV1, TeamCredentialRouteV1 } from '@happier-dev/protocol/teams';

import { Modal } from '@/modal';
import { t } from '@/text';
import { describeDirectDeliveryVisibility, readDirectDeliveryVisibility, type DirectDeliveryVisibility } from './directDeliveryDisclosure';

export type TeamCredentialSelectionConsequence = Readonly<{
    deliveryMode: TeamCredentialRouteV1;
    directDisclosure: 'required' | 'not_applicable';
    materialVisibility: DirectDeliveryVisibility | null;
    recipient: Readonly<{ mode: 'current_account'; count: 1 }>;
    visibilityRequirement: 'team_visibility_required' | 'team_context_required' | 'none';
}>;

export type TeamCredentialSelectionOutcome<TSelection> =
    | Readonly<{ kind: 'continue'; selection: TSelection; consequence: TeamCredentialSelectionConsequence }>
    | Readonly<{ kind: 'cancel'; consequence: TeamCredentialSelectionConsequence }>
    | Readonly<{ kind: 'invalidated'; consequence: TeamCredentialSelectionConsequence }>;

export function projectTeamCredentialSelectionConsequence(
    resource: TeamCredentialResourceCatalogEntryV1,
    deliveryMode: TeamCredentialRouteV1,
): TeamCredentialSelectionConsequence {
    const includesDirect = deliveryMode === 'direct';
    return {
        deliveryMode,
        // First direct use asks once (child 06 L10D-R3). Whether this viewer
        // was already disclosed to is the Home's retained delivery history,
        // not readiness: a custodian prepares a `current` tuple before the
        // recipient ever opens it. Reuse that canonical history instead of
        // keeping UI acknowledgement.
        directDisclosure: includesDirect && resource.directDeliveryRecorded !== true
            ? 'required'
            : 'not_applicable',
        materialVisibility: includesDirect ? readDirectDeliveryVisibility() : null,
        recipient: { mode: 'current_account', count: 1 },
        visibilityRequirement: resource.sessionUsePolicy === 'team_visibility_required'
            ? 'team_visibility_required'
            : resource.sessionUsePolicy === 'team_context_required'
                ? 'team_context_required'
                : 'none',
    };
}

export function useTeamCredentialSelectionCoordinator(homeIdentity: string | null | undefined) {
    const currentHomeIdentityRef = React.useRef(homeIdentity ?? null);
    currentHomeIdentityRef.current = homeIdentity ?? null;

    return React.useCallback(async <TSelection,>(params: Readonly<{
        resource: TeamCredentialResourceCatalogEntryV1;
        deliveryMode: TeamCredentialRouteV1;
        selection: TSelection;
        isCurrent: () => boolean;
    }>): Promise<TeamCredentialSelectionOutcome<TSelection>> => {
        const consequence = projectTeamCredentialSelectionConsequence(params.resource, params.deliveryMode);
        const startedHomeIdentity = currentHomeIdentityRef.current;
        if (consequence.directDisclosure === 'required') {
            const confirmed = await Modal.confirm(
                t('teams.credentials.directUse.title'),
                [t('teams.credentials.directUse.body'), consequence.materialVisibility
                    ? describeDirectDeliveryVisibility(consequence.materialVisibility) : null].filter(Boolean).join('\n\n'),
                {
                    confirmText: t('common.continue'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) return { kind: 'cancel', consequence };
        }
        if (currentHomeIdentityRef.current !== startedHomeIdentity) {
            // The person left this Home while deciding. Whatever they are
            // looking at now is not this resource, so there is nothing here to
            // tell them about.
            return { kind: 'invalidated', consequence };
        }
        if (!params.isCurrent()) {
            // The resource moved underneath a selection this person made, and
            // every caller drops an invalidated outcome. Saying so once here
            // keeps that from reading as a control that does nothing.
            Modal.alert(t('common.error'), t('teams.credentials.edit.conflict'));
            return { kind: 'invalidated', consequence };
        }
        return { kind: 'continue', selection: params.selection, consequence };
    }, []);
}
