import type { SystemTaskResult } from '@happier-dev/protocol';
import { removeServerProfileUiAction } from '@/components/serverProfiles/removeServerProfileUiAction';
import { listServerProfiles, retirePersonalHomeBootstrapCompletion } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

export type PersonalHomeEraseOutcome = Readonly<{
    outcome: 'completed' | 'completed_with_cleanup_attention' | 'partial';
    removedPaths: readonly string[];
    remainingOwnedPaths: readonly string[];
    remainingUnknownPaths: readonly string[];
    stoppedRunningHome: boolean;
    inspectionComplete: boolean;
    inspectionError: string | null;
    error: string | null;
}>;

/** Finish the app's binding only after the native erase has reported success. */
export async function completePersonalHomeErase(
    result: Extract<SystemTaskResult, { ok: true }>,
    erasedIdentity: string | null,
): Promise<PersonalHomeEraseOutcome> {
    const data = result.data as Record<string, unknown> | undefined;
    const erase = {
        outcome: data?.outcome === 'partial'
            ? 'partial' as const
            : data?.outcome === 'completed_with_cleanup_attention'
                ? 'completed_with_cleanup_attention' as const
                : 'completed' as const,
        removedPaths: Array.isArray(data?.removedPaths) ? data.removedPaths.filter((value): value is string => typeof value === 'string') : [],
        remainingOwnedPaths: Array.isArray(data?.remainingOwnedPaths) ? data.remainingOwnedPaths.filter((value): value is string => typeof value === 'string') : [],
        remainingUnknownPaths: Array.isArray(data?.remainingUnknownPaths) ? data.remainingUnknownPaths.filter((value): value is string => typeof value === 'string') : [],
        stoppedRunningHome: data?.stoppedRunningHome === true,
        inspectionComplete: data?.inspectionComplete !== false,
        inspectionError: typeof data?.inspectionError === 'string' ? data.inspectionError : null,
        error: typeof data?.error === 'string' ? data.error : null,
    };
    // Partial deletion retains its saved binding. Once data is gone, completion is
    // retired before guarded credential/profile cleanup, which may still refuse.
    const erasedProfile = erasedIdentity
        ? listServerProfiles().find((profile) => profile.serverIdentityId === erasedIdentity)
        : null;
    if (erase.outcome !== 'partial' && erasedProfile && erasedIdentity) {
        try {
            await retirePersonalHomeBootstrapCompletion(erasedIdentity);
            const removal = await removeServerProfileUiAction({
                profileId: erasedProfile.id,
                serverUrl: erasedProfile.serverUrl,
                // Disconnected above, after the erase was confirmed and before any data went.
                thisComputer: 'disconnected',
            });
            if (removal.kind !== 'completed') throw new Error(t('errors.operationFailed'));
        } catch (error) {
            erase.outcome = 'completed_with_cleanup_attention';
            const cleanupError = error instanceof Error ? error.message : t('errors.operationFailed');
            erase.error = [erase.error, cleanupError].filter(Boolean).join('\n');
        }
    }
    return erase;
}
