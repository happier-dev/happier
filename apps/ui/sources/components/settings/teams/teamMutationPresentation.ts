import { isActionApprovalDeclinedErrorCode, isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TeamErrorV1Schema, isTeamLegacyCredentialRefusalV1 } from '@happier-dev/protocol/teams';

import type { AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

/**
 * One truthful failure vocabulary for Team administration mutations.
 *
 * In particular, an Action dispatched before its carrier failed has an unknown
 * outcome. It must not reuse the generic “nothing changed” copy: callers refresh
 * their canonical reader and ask the person to review that state before acting
 * again.
 */
/**
 * The same vocabulary for a *read* that could not be completed.
 *
 * Only transport loss proves unreachability. A retryable server answer or an
 * invalid response is a load failure; settled refusals retain their typed meaning.
 */
export function teamReadFailureLabel(failure: HomeDomainFailure<string> | ScopedSnapshotError): string {
    // A read the person turned off in Settings, Actions never reached the Home. It is not a load
    // failure; the Action front door's own copy says so and where to turn it back on.
    if (isActionTurnedOffErrorCode(failure.code)) return t('actionConfirmations.turnedOffReadMessage');
    if (failure.kind === 'unreachable') return t('teams.unavailable.offline');
    if (failure.code === 'team_authentication_required') return t('session.access.authenticationRequired');
    if (failure.code === 'invalid_team_input') return t('homeGovernance.invalidRead');
    if (failure.code === 'invalid_team_cursor') return t('teams.errors.listCursorExpired');
    const refusal = teamRefusalLabel({ ...failure, code: failure.code ?? null });
    if (refusal) return refusal;
    if (failure.kind === 'forbidden') return t('errors.permissionDenied');
    if (failure.kind === 'unknown' || failure.kind === 'invalid') return t('teams.errors.loadFailed');
    return teamFailureKindLabel(failure.kind);
}

export type TeamReadFailureRetry = Readonly<{
    onPress: () => void;
    testIDPrefix?: string;
    reloadsFirstPage?: true;
}>;

/**
 * The one way forward a failed Team read offers: the repair route for an Action turned off in
 * Settings (a retry could not help), Retry when asking again can, nothing for a settled refusal.
 * Test ids derive from the surface's prefix so `<prefix>-retry` stays what it was.
 */
export function teamReadFailureAction(
    failure: HomeDomainFailure<string> | ScopedSnapshotError,
    retry: TeamReadFailureRetry,
    openActionSettings: () => void,
): AttentionBannerAction | undefined {
    if (isActionTurnedOffErrorCode(failure.code)) {
        return {
            label: t('actionConfirmations.openActionSettings'),
            onPress: openActionSettings,
            testID: retry.testIDPrefix ? `${retry.testIDPrefix}-open-actions-settings` : undefined,
        };
    }
    if (failure.code === 'invalid_team_cursor' && retry.reloadsFirstPage) {
        return {
            label: t('common.refresh'),
            onPress: retry.onPress,
            testID: retry.testIDPrefix ? `${retry.testIDPrefix}-reload` : undefined,
        };
    }
    if (!failure.retryable || failure.code === 'team_authentication_unavailable') return undefined;
    return {
        label: t('teams.unavailable.retry'),
        onPress: retry.onPress,
        testID: retry.testIDPrefix ? `${retry.testIDPrefix}-retry` : undefined,
    };
}

type TeamMutationContext = 'authentication_policy' | 'policy' | 'details';

export function teamMutationFailureLabel(failure: HomeDomainFailure<string>, context?: TeamMutationContext): string | null {
    if (isActionApprovalDeclinedErrorCode(failure.code)) return null;
    return teamFailureLabel(failure, context);
}

function teamFailureLabel(failure: HomeDomainFailure<string>, context?: TeamMutationContext): string {
    return teamRefusalLabel(failure, context) ?? teamFailureKindLabel(failure.kind);
}

function teamRefusalLabel(failure: HomeDomainFailure<string>, context?: TeamMutationContext): string | undefined {
    // Team routes refuse a released 0.2 sign-in; signing in again is the fix, not the person's role.
    if (isTeamLegacyCredentialRefusalV1(failure.code, failure.details)) return t('teams.errors.signInOutdated');
    switch (failure.code) {
        case 'team_not_found': return t('teams.errors.notFound');
        case 'teams_unavailable': return t('teams.unavailable.disabled');
        case 'team_authentication_unavailable': return t('teams.credentials.externalApi.authenticationUnavailable');
        case 'team_archived': return t('teams.errors.archived');
        case 'group_archived': return t('teams.groups.archivedReadOnly');
    }
    if (failure.code === 'managed_default_machine_not_member_usable') return t('teams.settings.memberDefaults.machineNotMemberUsable');
    if (failure.code === 'team_authentication_required') return context === 'authentication_policy'
        ? t('teams.authentication.policy.authenticationRequired')
        : t('teams.errors.authenticationRequired');
    if (failure.code === 'team_owner_transfer_required') return t('teams.members.lastOwnerBlocked');
    if (failure.code === 'managed_by_directory') return t('teams.members.managedReadOnly');
    if (failure.code === 'management_conflict') return t('teams.members.managementConflict');
    // Admission and every new ownership require an active Account (L01/01 :337);
    // the pickers cannot know it, so the Home's typed refusal says it.
    if (failure.code === 'account_ineligible') return t('teams.members.accountInactive');
    if (context === 'policy' && failure.code === 'invalid_team_input') return t('teams.errors.policySaveFailed');
    if (context === 'details' && failure.code === 'invalid_team_input') return t('teams.errors.invalidTeamDetails');
    return undefined;
}

function teamFailureKindLabel(kind: HomeDomainFailure<string>['kind']): string {
    switch (kind) {
        case 'outcome_unknown':
            return t('teams.errors.outcomeUnknown');
        case 'unreachable':
            return t('teams.errors.offline');
        case 'unsupported':
            // An operation this Home does not have is an age fact about the Home.
            // Never relabelled as a domain-specific failure such as mail delivery.
            return t('teams.unavailable.updateRequired');
        case 'forbidden':
        case 'unauthorized':
            return t('teams.errors.forbidden');
        case 'conflict':
            return t('teams.errors.conflict');
        default:
            return t('teams.errors.generic');
    }
}

/** Present the Home's refusal for either an immediate or an approved creation. */
export function presentTeamCreateFailure(failure: HomeDomainFailure<string>): Readonly<{
    message: string | null;
    ownerRecovery?: 'show_picker' | 'choose_another';
}> {
    switch (failure.code) {
        case 'invalid_team_input': {
            const body = TeamErrorV1Schema.safeParse(failure.details).data;
            const details = body?.error === failure.code ? body.details : undefined;
            if (!details || !('field' in details)) return { message: t('teams.errors.invalidTeamDetails') };
            switch (details.field) {
                case 'name':
                    return { message: details.reason === 'control_characters'
                        ? t('teams.errors.invalidNameCharacters') : t('teams.errors.invalidName') };
                case 'description':
                    return { message: details.reason === 'control_characters'
                        ? t('teams.errors.invalidDescriptionCharacters') : t('teams.errors.invalidDescription') };
                case 'initialOwnerAccountId':
                    if (details.reason === 'required') {
                        return { message: t('teams.create.initialOwnerRequired'), ownerRecovery: 'show_picker' };
                    }
                    if (details.reason === 'account_not_found') {
                        return { message: t('homeGovernance.errorAccountNotFound'), ownerRecovery: 'choose_another' };
                    }
                    if (details.reason === 'account_ineligible') {
                        return { message: t('teams.create.initialOwnerIneligible'), ownerRecovery: 'choose_another' };
                    }
                    return { message: t('teams.errors.invalidTeamDetails') };
            }
        }
        case 'team_conflict':
            return { message: t('teams.errors.createRequestConflict') };
        case 'teams_unavailable':
            return { message: t('teams.unavailable.disabled') };
        case 'team_authentication_unavailable':
            return { message: t('teams.credentials.externalApi.authenticationUnavailable') };
        case 'team_forbidden':
            return { message: resolveActionExecutionFailureMessage(
                { ok: false, errorCode: failure.code, details: failure.details }, teamFailureLabel(failure),
            ) };
        default:
            return { message: failure.kind === 'outcome_unknown' ? t('teams.create.outcomeUnknown') : teamMutationFailureLabel(failure) };
    }
}
