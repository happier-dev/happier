import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
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
    if (failure.kind === 'unknown' || failure.kind === 'invalid') return t('teams.errors.loadFailed');
    return teamMutationFailureLabel({ ...failure, code: failure.code ?? null });
}

export type TeamReadFailureRetry = Readonly<{ onPress: () => void; testIDPrefix?: string }>;

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
    if (!failure.retryable) return undefined;
    return {
        label: t('teams.unavailable.retry'),
        onPress: retry.onPress,
        testID: retry.testIDPrefix ? `${retry.testIDPrefix}-retry` : undefined,
    };
}

export function teamMutationFailureLabel(failure: HomeDomainFailure<string>, context?: 'authentication_policy'): string {
    if (failure.code === 'team_authentication_required') return context === 'authentication_policy'
        ? t('teams.authentication.policy.authenticationRequired')
        : t('teams.errors.authenticationRequired');
    if (failure.code === 'team_owner_transfer_required') return t('teams.members.lastOwnerBlocked');
    if (failure.code === 'managed_by_directory') return t('teams.members.managedReadOnly');
    if (failure.code === 'management_conflict') return t('teams.members.managementConflict');
    // Admission and every new ownership require an active Account (L01/01 :337);
    // the pickers cannot know it, so the Home's typed refusal says it.
    if (failure.code === 'account_ineligible') return t('teams.members.accountInactive');
    switch (failure.kind) {
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
