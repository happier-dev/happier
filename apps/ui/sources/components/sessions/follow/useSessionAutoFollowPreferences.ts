import * as React from 'react';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { sessionAutoFollowPreferencesGet, sessionAutoFollowPreferencesSet } from '@/sync/api/session/sessionFollowApi';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAccountFollowConfigurationChangeRelevant } from './sessionFollowAccountChange';
import {
    createIdleSessionFollowMutationIntent,
    reduceSessionFollowMutationIntent,
    type SessionFollowMutationIntentEvent,
    type SessionFollowMutationIntentState,
} from './sessionFollowMutationIntent';
import {
    isServerReachabilityNetworkAllowed,
    subscribeServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

/**
 * The intent is the fields the user changed, not a captured whole-preferences snapshot: a retry (or a
 * save that settles after a refresh) then applies that change to the current confirmed value instead
 * of resurrecting the rest of a stale object.
 */
export type SessionAutoFollowPreferencesIntent = Readonly<{ patch: Partial<SessionAutoFollowPreferencesV1> }>;
export type SessionAutoFollowPreferencesSaveOutcome =
    | Readonly<{ kind: 'saved'; previous: SessionAutoFollowPreferencesIntent; value: SessionAutoFollowPreferencesV1 }>
    | Readonly<{ kind: 'failed'; cause: Extract<Awaited<ReturnType<typeof sessionAutoFollowPreferencesSet>>, { kind: 'failed' }>
        | Readonly<{ kind: 'exception'; cause: unknown }> }>
    | Readonly<{ kind: 'unchanged' }>;

function reduceAutoFollowMutation(
    state: SessionFollowMutationIntentState<SessionAutoFollowPreferencesIntent>,
    event: SessionFollowMutationIntentEvent<SessionAutoFollowPreferencesIntent>,
): SessionFollowMutationIntentState<SessionAutoFollowPreferencesIntent> {
    return reduceSessionFollowMutationIntent(state, event);
}

/**
 * The one reader/writer of the Home's Follow preferences (`follow.preferences.get/set`): the
 * relationship defaults and the creation levels share this payload, so every settings surface that
 * edits any of it goes through this hook and its retry owner.
 */
export function useSessionAutoFollowPreferences(serverId: string) {
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId });
    const [preferences, setPreferences] = React.useState<SessionAutoFollowPreferencesV1 | null>(null);
    // The shared Follow retry owner: a failed preference change keeps its exact intent until a
    // retry succeeds, so a passive AccountChange or reconnect refresh cannot revert the switch
    // and leave an error row with nothing to retry.
    const [mutation, dispatchMutation] = React.useReducer(
        reduceAutoFollowMutation,
        createIdleSessionFollowMutationIntent<SessionAutoFollowPreferencesIntent>(),
    );
    const preferencesRef = React.useRef(preferences);
    preferencesRef.current = preferences;
    const mutationRef = React.useRef(mutation);
    mutationRef.current = mutation;
    const [saving, setSaving] = React.useState(false);
    const [online, setOnline] = React.useState(isServerReachabilityNetworkAllowed);
    const currentOperation = React.useRef<object | null>(null);
    const savingRef = React.useRef(false);
    const desiredRef = React.useRef<SessionAutoFollowPreferencesIntent | null>(null);
    const savePromiseRef = React.useRef<Promise<SessionAutoFollowPreferencesSaveOutcome> | null>(null);
    const refreshAfterSaveRef = React.useRef(false);

    const refresh = React.useCallback(async () => {
        if (!enabled || !isServerReachabilityNetworkAllowed()) return;
        if (savingRef.current) {
            // AccountChange is only a content-free invalidation. Coalesce wakes while the
            // mutation owns this lifetime, then reconstruct the authoritative Home state
            // after settlement (the same serialization used by the Follow editor).
            refreshAfterSaveRef.current = true;
            return;
        }
        const operation = {};
        currentOperation.current = operation;
        const result = await sessionAutoFollowPreferencesGet(serverId);
        if (currentOperation.current !== operation) return;
        if (result.kind === 'ok') {
            setPreferences(result.value);
            dispatchMutation({ kind: 'refreshed' });
        } else {
            dispatchMutation({ kind: 'failed', error: true });
        }
    }, [enabled, serverId]);

    React.useEffect(() => {
        if (!enabled) return;
        let retired = false;
        const retire = () => {
            retired = true;
            currentOperation.current = null;
            setPreferences(null);
            dispatchMutation({ kind: 'abandoned' });
            setSaving(false);
            savingRef.current = false;
            desiredRef.current = null;
            savePromiseRef.current = null;
            refreshAfterSaveRef.current = false;
        };
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return;
        const retirement = lifetime.onRetire(retire);
        const credentials = subscribeHomeCredentialMutations((event) => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) retire();
        });
        // The reachability subscription replays its current value synchronously on
        // subscribe. The mount read below owns the initial load, so only a genuine
        // offline → online transition reconciles here; otherwise every mount issued
        // two authoritative reads.
        let networkAllowed: boolean | null = null;
        const connection = subscribeServerReachabilityNetworkAllowed((next) => {
            if (retired) return;
            setOnline(next);
            const wasAllowed = networkAllowed;
            networkAllowed = next;
            if (next && wasAllowed === false) void refresh();
        });
        const changes = subscribeHomeAccountChange((event) => {
            if (!retired && areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                && isAccountFollowConfigurationChangeRelevant(event)) void refresh();
        }, { reconnect: { readNotCurrent: () => preferencesRef.current === null || mutationRef.current.error !== null } });
        // Load the current Account preference as soon as the settings section mounts.
        // Without this initial read, the section remains in its loading placeholder until
        // a reconnect or account-change event happens to trigger refresh().
        void refresh();
        return () => {
            // One retirement owner for this section lifetime: a teardown that reset only
            // part of it left the mutation gate closed, so a later lifetime (the feature
            // decision returning after a transient absence) deferred every refresh forever.
            retire();
            retirement.dispose();
            credentials();
            connection();
            changes();
        };
    }, [enabled, refresh, serverId]);

    const save = React.useCallback(function save(intent: SessionAutoFollowPreferencesIntent): Promise<SessionAutoFollowPreferencesSaveOutcome> {
        const base = preferencesRef.current;
        if (!isServerReachabilityNetworkAllowed() || !base) return Promise.resolve({ kind: 'unchanged' });
        const combinedIntent = { patch: { ...mutationRef.current.failed?.patch, ...desiredRef.current?.patch, ...intent.patch } };
        if (savingRef.current) {
            desiredRef.current = combinedIntent;
            dispatchMutation({ kind: 'started', intent: combinedIntent });
            return savePromiseRef.current!;
        }
        const changedFields = (Object.keys(combinedIntent.patch) as (keyof SessionAutoFollowPreferencesV1)[])
            .filter(field => !sameStrictJsonValue(base[field], combinedIntent.patch[field]));
        if (changedFields.length === 0) return Promise.resolve({ kind: 'unchanged' });
        const noticeKey = `follow-preferences:${serverId}`;
        retirePresentationNotice(noticeKey);
        const operation = {};
        currentOperation.current = operation;
        savingRef.current = true;
        desiredRef.current = combinedIntent;
        setSaving(true);
        // A second section edit keeps the exact failed fields until a write applies them.
        // The confirmed Home baseline still supplies every neighbouring field at retry time.
        dispatchMutation({ kind: 'started', intent: combinedIntent });
        const pending = (async (): Promise<SessionAutoFollowPreferencesSaveOutcome> => {
            try {
                let confirmed = base;
                const previousPatch: Partial<SessionAutoFollowPreferencesV1> = {};
                while (true) {
                    const desired = desiredRef.current!;
                    const fields = (Object.keys(desired.patch) as (keyof SessionAutoFollowPreferencesV1)[])
                        .filter(field => !sameStrictJsonValue(confirmed[field], desired.patch[field]));
                    for (const field of fields) {
                        if (!Object.hasOwn(previousPatch, field)) Object.assign(previousPatch, { [field]: confirmed[field] });
                    }
                    if (fields.length === 0) break;
                    const result = await sessionAutoFollowPreferencesSet(serverId, { ...confirmed, ...desired.patch });
                    if (currentOperation.current !== operation) return { kind: 'unchanged' };
                    if (result.kind !== 'ok') {
                        dispatchMutation({ kind: 'failed', error: true });
                        return { kind: 'failed', cause: result };
                    }
                    confirmed = result.value;
                    preferencesRef.current = confirmed;
                    setPreferences(confirmed);
                    // Only a newer choice needs another write. The Home's returned value
                    // remains authoritative when it normalizes the submitted preference.
                    if (desiredRef.current === desired) break;
                }
                if (currentOperation.current !== operation) return { kind: 'unchanged' };
                const previous: SessionAutoFollowPreferencesIntent = { patch: previousPatch };
                dispatchMutation({ kind: 'succeeded' });
                publishPresentationNotice({ key: noticeKey, severity: 'info', message: t('settingsCoordination.followDefaultsSaved'),
                    undo: { label: t('common.undo'), run: () => {
                        void save(previous).then(outcome => {
                            if (outcome.kind === 'failed') publishPresentationNotice({ key: noticeKey, severity: 'error',
                                message: t('settingsCoordination.followDefaultsFailed') });
                        });
                    } } });
                return { kind: 'saved', previous, value: confirmed };
            } catch (cause) {
                if (currentOperation.current === operation) dispatchMutation({ kind: 'failed', error: true });
                return { kind: 'failed', cause: { kind: 'exception', cause } };
            } finally {
                if (currentOperation.current === operation) {
                    savingRef.current = false;
                    desiredRef.current = null;
                    savePromiseRef.current = null;
                    setSaving(false);
                    if (refreshAfterSaveRef.current) {
                        refreshAfterSaveRef.current = false;
                        await refresh();
                    }
                }
            }
        })();
        savePromiseRef.current = pending;
        return pending;
    }, [refresh, serverId]);

    const outstanding = mutation.pending;
    return {
        enabled,
        online,
        saving,
        error: mutation.error !== null,
        confirmed: preferences,
        failed: mutation.failed,
        // A failed intent stays with Retry; the control returns to the confirmed Home value.
        displayed: preferences && outstanding ? { ...preferences, ...outstanding.patch } : preferences,
        save,
        /** Retries the exact change that failed; a failed load retries by loading again. */
        retry: async (): Promise<SessionAutoFollowPreferencesSaveOutcome> => {
            if (mutation.failed) return save(mutation.failed);
            await refresh();
            return { kind: 'unchanged' };
        },
    };
}
