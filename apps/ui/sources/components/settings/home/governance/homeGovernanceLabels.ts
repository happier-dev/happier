import { AccountErasureDeploymentBlockerV1Schema, projectAccountErasureDeploymentActionDetailsV1 } from '@happier-dev/protocol/home/governance';
import { ACCOUNT_ERASURE_REVIEW_UNAVAILABLE_CODE } from '@happier-dev/protocol/auth/accountErasureReview';
import type {
    AccountStatusV1,
    HomeAdmissionModeV1,
    HomeAuthenticationPolicyV1,
    HomeGovernancePolicyFieldV1,
    HomeIdentityNetworkPolicyV1,
    HomeRoleV1,
    HomeSettingsInvalidReasonV1,
    TeamCreationPolicyV1,
} from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import { resolveHomeAccountStatusPresentation } from '@/sync/domains/home/governance/homeAccountAdministration';
import type { HomeAccountActionUnavailableReason } from '@/sync/domains/home/governance/homeAccountAdministration';
import type { HomeAdministrationHomeEntry } from '@/sync/domains/home/governance/homeAdministrationSettingsAdmission';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { readHomeSettingsInvalidFailure } from '@/sync/ops/home/homeGovernanceOperations';

export const HOME_IDENTITY_NETWORK_MODE_LABEL_KEYS = {
    public_only: 'homeGovernance.signInProviders.privateEndpointsPublicOnlyShort',
    private_allowlist: 'homeGovernance.signInProviders.privateEndpointsAllowlistShort',
} as const satisfies Record<HomeIdentityNetworkPolicyV1['mode'], string>;

export function homeGovernancePolicyFieldLabel(field: HomeGovernancePolicyFieldV1): string {
    switch (field) {
        case 'teamCreationPolicy':
            return t('homeGovernance.teamCreation');
        case 'teamsVisibleToMembers':
            return t('homeGovernance.teamsVisibleToMembers');
        case 'authenticationPolicy':
            return t('homeGovernance.signInTitle');
        case 'teamProviderPolicy':
            return t('homeGovernance.activity.fieldTeamProviders');
        case 'identityNetworkPolicy':
            return t('homeGovernance.privateEndpoints');
        case 'sessionDefaults':
            return t('settingsAgents.detailPage.sessionDefaultsTitle');
    }
}

/**
 * The one place a Home-governance enum becomes words.
 *
 * Keeping these together is what stops the lifecycle vocabulary from drifting:
 * the reversible hold must read as **Disabled** and the terminal state as
 * **Retired** on every surface that shows an Account, not just the one where the
 * distinction was first written.
 */

type HomeUnresolvedReason = Extract<HomeAdministrationHomeEntry, { state: 'unresolved' }>['reason'];

/**
 * How one Home is named to the person administering it.
 *
 * The app's one Home label owner decides: the published or chosen name, else "Personal Home"
 * for this device's own Home, else "This Home". Addresses belong only in distinguishing meta.
 */
export function homeDisplayName(serverId: string): string {
    return resolveHomeDisplayLabel(getServerProfileById(serverId), serverId);
}

/** Why a Home in the exact set has not yet said whether it admits this device. */
export function homeUnresolvedReasonLabel(reason: HomeUnresolvedReason): string {
    switch (reason) {
        case 'loading':
            return t('homeGovernance.loading');
        case 'signed_out':
            return t('homeGovernance.signedOutBody');
        case 'unknown_home':
            return t('homeGovernance.notObservedBody');
        case 'unreachable':
            return t('homeGovernance.offlineNotice');
    }
}

export function homeRoleLabel(role: HomeRoleV1): string {
    switch (role) {
        case 'owner':
            return t('homeGovernance.roleOwner');
        case 'admin':
            return t('homeGovernance.roleAdmin');
        case 'member':
            return t('homeGovernance.roleMember');
    }
}

export function homeRoleDescription(role: HomeRoleV1): string {
    switch (role) {
        case 'owner':
            return t('homeGovernance.roleOwnerDescription');
        case 'admin':
            return t('homeGovernance.roleAdminDescription');
        case 'member':
            return t('homeGovernance.roleMemberDescription');
    }
}

export function homeAccountStatusLabel(status: AccountStatusV1): string {
    switch (resolveHomeAccountStatusPresentation(status).label) {
        case 'active':
            return t('homeGovernance.statusActive');
        case 'disabled':
            return t('homeGovernance.statusDisabled');
        case 'retired':
            return t('homeGovernance.statusRetired');
    }
}

/**
 * The extra sentence a lifecycle state deserves on a detail surface. An active
 * Account gets none: there is nothing unusual to explain. Neither ever claims a
 * cause or a timestamp, because neither is stored.
 */
export function homeAccountStatusDetail(status: AccountStatusV1): string | null {
    switch (resolveHomeAccountStatusPresentation(status).label) {
        case 'active':
            return null;
        case 'disabled':
            return t('homeGovernance.statusDisabledDetail');
        case 'retired':
            return t('homeGovernance.statusRetiredDetail');
    }
}

export function homeActionUnavailableReasonLabel(reason: HomeAccountActionUnavailableReason): string {
    switch (reason) {
        case 'last_active_owner':
            return t('homeGovernance.reasonLastActiveOwner');
        case 'target_inactive':
        case 'target_not_active':
        case 'target_not_suspended':
        case 'target_retired':
            return t('homeGovernance.reasonTargetInactive');
        case 'team_owner_transfer_required':
            return t('homeGovernance.errorTeamOwnerTransferRequired');
        case 'home_unreachable':
            return t('homeGovernance.reasonHomeUnreachable');
    }
}

/**
 * What a failed Home-governance read or mutation is called, in one place.
 *
 * The Home's own typed code comes first, because it names the actual obstacle.
 * Only when it sent none does the transport's own verdict speak — and the two
 * that matter most are the ones a code can never carry: a request that never
 * left, and a request that left and whose answer was lost.
 *
 * Reads use an unavailable notice when no specific cause is known. Mutations
 * remain the default for existing action callers. A lost mutation answer is why
 * this returns a title as well as a body: an unconfirmed mutation cannot be
 * introduced as a change that failed, because the Home may well have applied it. Saying otherwise
 * invites a second press, and a second press is a second non-idempotent
 * governance mutation.
 */
export function homeGovernanceFailureNotice(
    failure: HomeDomainFailure,
    context?: Readonly<{ effect: 'read' | 'write' }>,
): Readonly<{ title: string; body: string }> {
    const effect = context?.effect ?? 'write';
    if (failure.code === 'username-changed') {
        return Object.freeze({
            title: t('homeGovernance.person.publicProfileReclaimChangedTitle'),
            body: t('homeGovernance.person.publicProfileReclaimChangedBody'),
        });
    }
    if (effect === 'write' && failure.code === null && failure.kind === 'outcome_unknown') {
        return Object.freeze({
            title: t('homeGovernance.errorOutcomeUnknownTitle'),
            body: t('homeGovernance.errorOutcomeUnknown'),
        });
    }
    return Object.freeze({
        title: effect === 'read' ? t('homeGovernance.unavailableTitle') : t('homeGovernance.changeFailedTitle'),
        body: homeGovernanceFailureBody(failure, effect),
    });
}

export function homePagedReadFailureLabel(failure: HomeDomainFailure, fallback: string): string {
    switch (failure.code) {
        case 'invalid_home_cursor': return t('homeGovernance.peopleCursorExpired');
        case null: return fallback;
        default: return homeGovernanceFailureNotice(failure, { effect: 'read' }).body;
    }
}

export function accountErasureDeploymentRecovery(error: unknown) {
    if (!(error instanceof HappyError) || error.code !== 'account_erasure_deployment_cleanup_required') return null;
    const blocker = readErasureDeploymentBlocker(error.details);
    return blocker ? projectAccountErasureDeploymentActionDetailsV1(blocker) : null;
}

function readErasureDeploymentBlocker(details: unknown) {
    const parsed = AccountErasureDeploymentBlockerV1Schema.safeParse(
        details && typeof details === 'object' && 'blocker' in details ? details.blocker : undefined,
    );
    return parsed.success ? parsed.data : null;
}

type ErasureDeploymentNames = Readonly<{ name?: string; targetName?: string; platform?: string }>;

/** Self-erasure uses the Home's typed verdict and labels read in that same Account scope. */
export function accountErasureFailureNotice(error: unknown, deployment?: ErasureDeploymentNames): Readonly<{ title: string; body: string }> {
    if (error instanceof HappyError && error.code === ACCOUNT_ERASURE_REVIEW_UNAVAILABLE_CODE) {
        return { title: t('homeGovernance.erasureReviewUnavailableTitle'), body: t('homeGovernance.erasureReviewUnavailable') };
    }
    if (error instanceof HappyError && error.code === 'account_erasure_deployment_cleanup_required') {
        const blocker = readErasureDeploymentBlocker(error.details);
        return {
            title: t('homeGovernance.changeFailedTitle'),
            body: blocker ? erasureDeploymentBlockerBody(blocker, { self: true, deployment })
                : t('homeGovernance.erasureDeploymentBlockerUnavailable'),
        };
    }
    if (error instanceof HappyError && (error.code === 'account_erasure_transition_cleanup_pending'
        || error.code === 'account_erasure_upload_pending')) {
        return homeGovernanceFailureNotice({ kind: 'conflict', retryable: true, code: error.code, details: error.details });
    }
    if (error instanceof HappyError
        && (error.code === 'home_owner_transfer_required' || error.code === 'team_owner_transfer_required')) {
        return homeGovernanceFailureNotice({ kind: 'conflict', retryable: false, code: error.code });
    }
    if (error instanceof HappyError && error.code
        && error.code !== 'account_delete_failed' && error.code !== 'account_delete_invalid_response'
        && error.code !== 'action_failed'
        && !isActionOutcomeUnknownErrorCodeV1(error.code)) {
        return Object.freeze({
            title: t('homeGovernance.changeFailedTitle'),
            body: resolveActionExecutionErrorMessage(error, t('homeGovernance.errorGeneric')),
        });
    }
    return Object.freeze({
        title: t('settingsAccount.deleteAccountFailedTitle'),
        body: t('settingsAccount.deleteAccountFailed'),
    });
}

function erasureDeploymentBlockerBody(blocker: NonNullable<ReturnType<typeof readErasureDeploymentBlocker>>,
    context?: Readonly<{ self: true; deployment?: ErasureDeploymentNames }>): string {
    const { reason } = blocker;
    const self = context?.self && (reason === 'source_sharing' || reason === 'environment_dependencies' || reason === 'graph_dependencies');
    const message = self ? t(`homeGovernance.selfErasureDeploymentBlocker.${reason}`)
        : t(`homeGovernance.erasureDeploymentBlocker.${reason}`);
    const { name, targetName, platform } = context?.deployment ?? {};
    const target = targetName && platform ? t('homeGovernance.erasureDeploymentTarget', { name: targetName, platform }) : targetName;
    if (name || target) return [name, target, message].filter(Boolean).join('\n\n');
    const reference = blocker.targetLinkId
        ? [platform ?? blocker.targetKind, blocker.targetLinkId].filter(Boolean).join(' ')
        : blocker.deploymentId ?? blocker.environmentId ?? blocker.projectSourceId ?? blocker.artifactId;
    return reference ? `${message} (${reference})` : message;
}

type HomeSettingsFieldReason = Extract<HomeSettingsInvalidReasonV1, 'invalid_type' | 'out_of_bounds' | 'required'>;

/** Only value refusals can be corrected in the field that was submitted. */
export function homeSettingsFieldFailure(failure: HomeDomainFailure): Readonly<{ key: string; reason: HomeSettingsFieldReason }> | null {
    const invalid = readHomeSettingsInvalidFailure(failure);
    if (!invalid) return null;
    const { key, reason } = invalid;
    switch (reason) {
        case 'invalid_type':
        case 'out_of_bounds':
        case 'required':
            return { key, reason };
        default:
            return null;
    }
}

function homeGovernanceFailureBody(failure: HomeDomainFailure, effect: 'read' | 'write'): string {
    if (effect === 'read' && failure.code === 'invalid_home_input') return t('homeGovernance.invalidRead');
    switch (failure.code) {
        case 'home_governance_forbidden':
            return effect === 'read' ? t('homeGovernance.forbiddenBody') : t('homeGovernance.errorForbidden');
        case 'home_owner_transfer_required':
            return t('homeGovernance.errorOwnerTransferRequired');
        case 'team_owner_transfer_required':
            return t('homeGovernance.errorTeamOwnerTransferRequired');
        case 'home_account_not_found':
            return t('homeGovernance.errorAccountNotFound');
        case 'home_account_inactive':
            return t('homeGovernance.errorAccountInactive');
        case 'home_policy_revision_conflict':
            return t('homeGovernance.revisionConflictBody');
        case 'home_settings_invalid': {
            switch (readHomeSettingsInvalidFailure(failure)?.reason) {
                case 'unknown_key': return t('homeSettings.refused.unknownKey');
                case 'not_home_editable': return t('homeSettings.refused.notEditable');
                case 'secret_in_values': return t('homeSettings.refused.secretInValues');
                case 'not_secret': return t('homeSettings.refused.notSecret');
                default: return t('homeSettings.row.invalid');
            }
        }
        case 'account_erasure_transition_cleanup_pending':
            return t('homeGovernance.errorErasureTransitionCleanupPending');
        case 'account_erasure_upload_pending':
            return t('homeGovernance.errorErasureUploadPending');
        case 'account_erasure_deployment_cleanup_required': {
            const blocker = readErasureDeploymentBlocker(failure.details);
            return blocker ? erasureDeploymentBlockerBody(blocker) : t('homeGovernance.errorErasureDeploymentCleanupRequired');
        }
        case 'home_policy_widening_unconfirmed':
            return t('homeGovernance.signInPolicy.errorWideningUnconfirmed');
        case 'home_claim_refused':
            return t('homeGovernance.claim.refused');
        default:
            break;
    }
    if (failure.code) {
        const message = resolveActionExecutionErrorMessage({ code: failure.code, details: failure.details }, '');
        if (message) return message;
    }
    switch (failure.kind) {
        case 'unreachable':
            return t('homeGovernance.reasonHomeUnreachable');
        case 'unauthorized':
        case 'forbidden':
            return effect === 'read' ? t('homeGovernance.forbiddenBody') : t('homeGovernance.errorForbidden');
        case 'unsupported':
            return t('homeGovernance.unsupportedBody');
        case 'conflict':
            return t('homeGovernance.errorConflict');
        default:
            return effect === 'read' ? t('homeGovernance.unavailableBody') : t('homeGovernance.errorGeneric');
    }
}

export function teamCreationPolicyLabel(policy: TeamCreationPolicyV1): string {
    switch (policy) {
        case 'self_service':
            return t('homeGovernance.teamCreationSelfService');
        case 'managed_only':
            return t('homeGovernance.teamCreationManagedOnly');
        case 'disabled':
            return t('homeGovernance.teamCreationDisabled');
    }
}

export function teamCreationPolicyDescription(policy: TeamCreationPolicyV1): string {
    switch (policy) {
        case 'self_service':
            return t('homeGovernance.teamCreationSelfServiceDescription');
        case 'managed_only':
            return t('homeGovernance.teamCreationManagedOnlyDescription');
        case 'disabled':
            return t('homeGovernance.teamCreationDisabledDescription');
    }
}

export type HomeStoragePolicy = NonNullable<HomeAuthenticationPolicyV1['storagePolicy']>;

export function homeStoragePolicyLabel(policy: HomeStoragePolicy): string {
    switch (policy) {
        case 'required_e2ee': return t('homeGovernance.signInPolicy.storageRequired');
        case 'optional': return t('homeGovernance.signInPolicy.storageOptional');
        case 'plaintext_only': return t('homeGovernance.signInPolicy.storagePlaintext');
    }
}

/** An Account encryption mode as a short choice label ("E2EE", "Plain"). */
export function homeAccountModeLabel(mode: 'e2ee' | 'plain'): string {
    return mode === 'plain' ? t('homeGovernance.accountModePlain') : t('homeGovernance.signInPolicy.recommendedE2ee');
}

export function homeAdmissionModeLabel(mode: HomeAdmissionModeV1): string {
    switch (mode) {
        case 'self_service':
            return t('homeGovernance.admissionSelfService');
        case 'invitation_only':
            return t('homeGovernance.admissionInvitationOnly');
        case 'closed':
            return t('homeGovernance.admissionClosed');
    }
}
