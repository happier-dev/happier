import type {
    TeamCredentialResourceCatalogEntryV1,
    TeamCredentialResourceRecoveryActionV1,
    TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';

import { t } from '@/text';
import { resourceStateLabel } from './readinessPresentation';
import { teamCredentialOwnerHandoffLabel } from './sourceHealthPresentation';

/**
 * The Home's recovery instruction for one unavailable resource, mapped to the
 * single destination that instruction names.
 *
 * The server owns the enum; this module only decides which existing destination
 * each arm means and what the row says. Nothing here decides authority: whether
 * a viewer may actually reach the resource's Settings is applied again by the
 * surface they land on, from the Home's own viewer projection.
 */
export type TeamCredentialRecoveryDestination =
    | 'retry'
    | 'resource_settings'
    | 'broker_selection'
    | 'source_owner_handoff'
    | 'app_update'
    | 'choose_another_resource';

export type TeamCredentialRecoveryTranslationKey =
    | 'teams.unavailable.retry'
    | 'teams.credentials.recovery.openSettings'
    | 'teams.credentials.recovery.selectBroker'
    | 'teams.credentials.recovery.ownerHandoff'
    | 'teams.credentials.recovery.updateApp'
    | 'teams.credentials.recovery.chooseAnother';

export type TeamCredentialRecoveryPresentation = Readonly<{
    destination: TeamCredentialRecoveryDestination;
    labelKey: TeamCredentialRecoveryTranslationKey;
}>;

/**
 * Maps the server-owned recovery enum onto one destination.
 *
 * `source_owner_action` and `select_broker` can only be repaired by the source
 * custodian, so anyone else — including a Team manager, whose surface is
 * audience and limits, not the source — is handed to the owner instead of
 * being offered a destination that would refuse them.
 */
export function teamCredentialRecoveryPresentation(
    action: TeamCredentialResourceRecoveryActionV1 | null | undefined,
    options?: Readonly<{ isSourceCustodian?: boolean }>,
): TeamCredentialRecoveryPresentation | null {
    switch (action) {
        case 'retry':
            return { destination: 'retry', labelKey: 'teams.unavailable.retry' };
        case 'source_owner_action':
            return options?.isSourceCustodian === true
                ? { destination: 'resource_settings', labelKey: 'teams.credentials.recovery.openSettings' }
                : { destination: 'source_owner_handoff', labelKey: 'teams.credentials.recovery.ownerHandoff' };
        case 'select_broker':
            return options?.isSourceCustodian === true
                ? { destination: 'broker_selection', labelKey: 'teams.credentials.recovery.selectBroker' }
                : { destination: 'source_owner_handoff', labelKey: 'teams.credentials.recovery.ownerHandoff' };
        case 'update_required':
            return { destination: 'app_update', labelKey: 'teams.credentials.recovery.updateApp' };
        case 'choose_another_resource':
            return { destination: 'choose_another_resource', labelKey: 'teams.credentials.recovery.chooseAnother' };
        default:
            return null;
    }
}

/** The localized label for surfaces that own the global translator; a handoff names the source owner when known. */
export function teamCredentialRecoveryLabel(
    presentation: TeamCredentialRecoveryPresentation,
    sourceOwnerDisplayName?: string | null,
): string {
    return presentation.destination === 'source_owner_handoff'
        ? teamCredentialOwnerHandoffLabel(sourceOwnerDisplayName)
        : t(presentation.labelKey);
}

/**
 * Whether this recovery names a destination the current surface can open.
 *
 * `source_owner_handoff` is guidance because the viewer is not the person who
 * can act. `choose_another_resource` navigates back to the existing
 * resource catalog; it does not create another selection owner.
 */
export function recoveryDestinationIsNavigable(destination: TeamCredentialRecoveryDestination): boolean {
    return destination !== 'source_owner_handoff';
}

/**
 * What one viewer is told about a resource that is not usable: the cause, said
 * the same way to everyone, and then either the repair this viewer can make or
 * whom to ask.
 *
 * The cause is not a role fact, so its copy never names an owner-only action.
 * Who may repair is the Home's own per-resource `capabilities`; a recipient
 * catalog row carries none and no owner identity, so a recipient is handed to
 * the person who shared the credential without a name.
 */
export type TeamCredentialStatusPresentation = Readonly<{
    cause: string;
    /** For a viewer who cannot repair it: whom to ask. */
    handoff: string | null;
    /** A repair this viewer can make; never `source_owner_handoff`. */
    recovery: TeamCredentialRecoveryPresentation | null;
}>;

/** Whether this viewer administers the source itself, from the Home's per-resource operation capabilities. */
export function teamCredentialViewerIsSourceCustodian(
    resource: TeamCredentialResourceSummaryV1 | TeamCredentialResourceCatalogEntryV1,
): boolean {
    if (!('capabilities' in resource)) return false;
    const { capabilities } = resource;
    return capabilities.updateBrokerPlacement || capabilities.narrowDisclosure || capabilities.refreshDirectMaterial;
}

export function teamCredentialStatusPresentation(
    resource: TeamCredentialResourceSummaryV1 | TeamCredentialResourceCatalogEntryV1,
): TeamCredentialStatusPresentation {
    const recovery = teamCredentialRecoveryPresentation(resource.recoveryAction, {
        isSourceCustodian: teamCredentialViewerIsSourceCustodian(resource),
    });
    const ownerName = 'sourceOwnerDisplayName' in resource ? resource.sourceOwnerDisplayName : null;
    return {
        cause: resourceStateLabel(resource.readiness),
        handoff: recovery?.destination === 'source_owner_handoff' ? teamCredentialRecoveryLabel(recovery, ownerName) : null,
        recovery: recovery?.destination === 'source_owner_handoff' ? null : recovery,
    };
}
