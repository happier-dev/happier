import type { AccountSettingMutationV1, AccountSettings } from '@happier-dev/protocol';

import { readStoredCredentials } from '@/persistence';
import {
    commitActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    updateAccountSettingsV2Once,
    updateAccountSettingsV2OnceAgainstLatest,
    updateAccountSettingsV2WithRetry,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import type {
    AccountSettingsMutationResult,
    AccountSettingsUpdateV2Deps,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

export function readActivePluginAccountSettings(): AccountSettings | null {
    return getActiveAccountSettingsSnapshot()?.settings ?? null;
}

export type UpdateActivePluginAccountSettingsOnceResult = AccountSettingsMutationResult;

type ActiveAccountSettingsUpdateDeps = Readonly<{
    readCredentials?: typeof readStoredCredentials;
    accountSettingsUpdateDeps?: AccountSettingsUpdateV2Deps;
    nowMs?: () => number;
    signal?: AbortSignal;
    assertCurrent?: () => void;
}>;

type ActiveAccountSettingsRetryMutation =
    | AccountSettingMutationV1
    | ((settings: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>);

type ActiveSnapshotPublicationIncumbent = Readonly<{
    lifetimeToken: number;
    hadActiveSnapshot: boolean;
}>;

function cancelledBeforeSubmission(): AccountSettingsMutationResult {
    return Object.freeze({ status: 'cancelled' as const, submitted: false as const });
}

function captureActiveSnapshotPublicationIncumbent(): ActiveSnapshotPublicationIncumbent {
    return Object.freeze({
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        hadActiveSnapshot: !!getActiveAccountSettingsSnapshot(),
    });
}

function activeSnapshotPublicationIncumbentIsCurrent(params: Readonly<{
    publicationIncumbent: ActiveSnapshotPublicationIncumbent;
    scopeKey: string;
}>): boolean {
    const current = getActiveAccountSettingsSnapshot();
    if (getActiveAccountSettingsSnapshotLifetimeToken() !== params.publicationIncumbent.lifetimeToken) {
        return false;
    }
    if (
        params.publicationIncumbent.hadActiveSnapshot
        && (!current || (current.scopeKey && current.scopeKey !== params.scopeKey))
    ) {
        return false;
    }
    // A no-active initial write may publish only while its captured lifetime
    // remains current; any subsequently installed scope rotates that token.
    // A captured active scope may not publish or submit into a different
    // account.
    return !current?.scopeKey || current.scopeKey === params.scopeKey;
}

function isSettledSuccess(
    result: AccountSettingsMutationResult,
): result is Extract<AccountSettingsMutationResult, { status: 'applied' | 'satisfied' | 'unchanged' }> {
    return result.status === 'applied'
        || result.status === 'satisfied'
        || result.status === 'unchanged';
}

function publishSettledActiveSnapshot(params: Readonly<{
    credentials: Awaited<ReturnType<typeof readStoredCredentials>>;
    result: Extract<AccountSettingsMutationResult, { status: 'applied' | 'satisfied' | 'unchanged' }>;
    publicationIncumbent: ActiveSnapshotPublicationIncumbent;
    nowMs?: () => number;
}>): void {
    if (!params.credentials) return;
    const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
    // An acknowledged write belongs to the original account, but must never
    // publish into a newer account scope that replaced it while in flight.
    // A captured active lifetime also prevents post-logout settlement from
    // reintroducing a cleared snapshot and its secret-read keys.
    if (!activeSnapshotPublicationIncumbentIsCurrent({
        publicationIncumbent: params.publicationIncumbent,
        scopeKey,
    })) return;
    commitActiveAccountSettingsSnapshot({
        source: 'network',
        settings: params.result.settings,
        settingsVersion: params.result.version,
        loadedAtMs: params.nowMs?.() ?? Date.now(),
        settingsSecretsReadKeys: deriveSettingsSecretsReadKeysForCredentials(params.credentials),
        scopeKey,
    });
}

/**
 * The non-retrying Account Settings CAS used by immutable SavedSecret
 * mutations.  It only runs against the caller's observed active version and
 * never promotes a stale mutation into the ordinary retry loop.
 */
export async function updateActivePluginAccountSettingsOnce(params: Readonly<{
    expectedVersion: number;
    mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>;
    deps?: ActiveAccountSettingsUpdateDeps;
}>): Promise<UpdateActivePluginAccountSettingsOnceResult> {
    const deps = params.deps ?? {};
    if (deps.signal?.aborted) return cancelledBeforeSubmission();
    deps.assertCurrent?.();
    // Capture before credentials can await. The resulting incumbent governs
    // both the final publication and the last transport-admission fence.
    const publicationIncumbent = captureActiveSnapshotPublicationIncumbent();
    const credentials = await (deps.readCredentials ?? readStoredCredentials)();
    if (deps.signal?.aborted) return cancelledBeforeSubmission();
    deps.assertCurrent?.();
    if (!credentials) {
        throw new Error('Plugin account settings require authenticated credentials');
    }

    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const active = getActiveAccountSettingsSnapshot();
    if (active && active.scopeKey && active.scopeKey !== scopeKey) {
        throw new Error('The active Account changed before the plugin secret mutation began');
    }
    if (active && active.settingsVersion !== params.expectedVersion) {
        return Object.freeze({ status: 'conflict', currentVersion: active.settingsVersion });
    }
    const isPublicationCurrent = (): boolean => activeSnapshotPublicationIncumbentIsCurrent({
        publicationIncumbent,
        scopeKey,
    });
    const shouldSubmit = (): boolean => {
        deps.assertCurrent?.();
        return isPublicationCurrent();
    };
    const result = await updateAccountSettingsV2Once({
        credentials,
        expectedVersion: params.expectedVersion,
        mutate: params.mutate,
        deps: deps.accountSettingsUpdateDeps,
        shouldSubmit,
        shouldCommit: isPublicationCurrent,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (isSettledSuccess(result)) {
        publishSettledActiveSnapshot({
            credentials,
            result,
            publicationIncumbent,
            nowMs: deps.nowMs,
        });
    }
    return result;
}

export async function updateActivePluginAccountSettings(
    mutation: ActiveAccountSettingsRetryMutation,
    deps: ActiveAccountSettingsUpdateDeps & Readonly<{
        /**
         * The caller's live authority fence. The Account write may finish
         * after a plugin invocation retires, but it must not publish a stale
         * snapshot into the current account scope.
         */
        assertCurrent?: () => void;
    }> = {},
): Promise<AccountSettingsMutationResult> {
    if (deps.signal?.aborted) return cancelledBeforeSubmission();
    deps.assertCurrent?.();
    const publicationIncumbent = captureActiveSnapshotPublicationIncumbent();
    const credentials = await (deps.readCredentials ?? readStoredCredentials)();
    if (deps.signal?.aborted) return cancelledBeforeSubmission();
    deps.assertCurrent?.();
    if (!credentials) {
        throw new Error('Plugin account settings require authenticated credentials');
    }
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const isPublicationCurrent = (): boolean => activeSnapshotPublicationIncumbentIsCurrent({
        publicationIncumbent,
        scopeKey,
    });
    const shouldSubmit = (): boolean => {
        deps.assertCurrent?.();
        return isPublicationCurrent();
    };
    const common = {
        credentials,
        deps: deps.accountSettingsUpdateDeps,
        shouldSubmit,
        shouldCommit: isPublicationCurrent,
        ...(deps.signal ? { signal: deps.signal } : {}),
    };
    const result = typeof mutation === 'function'
        ? await updateAccountSettingsV2OnceAgainstLatest({ ...common, mutate: mutation })
        : await updateAccountSettingsV2WithRetry({ ...common, mutation });
    if (isSettledSuccess(result)) {
        publishSettledActiveSnapshot({
            credentials,
            result,
            publicationIncumbent,
            nowMs: deps.nowMs,
        });
    }
    return result;
}
