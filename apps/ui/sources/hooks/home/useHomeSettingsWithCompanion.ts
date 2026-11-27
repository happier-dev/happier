import * as React from 'react';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { HomeAdministrationRead } from '@/sync/engine/home/governance/homeAdministrationReads';
import { observeHomeSettings, refreshHomeSettings, type HomeSettingsRefreshReason } from '@/sync/engine/home/governance/homeSettingsEngine';
import { adoptHomeSettingsProjection, getHomeSettingsSnapshot, subscribeHomeSettingsSnapshots } from '@/sync/store/home/governance/homeSettingsSnapshots';
import { useHomeAdministrationRead } from './useHomeAdministrationRead';

export type HomeSettingsWithCompanion<TCompanion, TSettings = HomeSettingsProjectionV1> = Readonly<{
    /** Selected settings from the last answer, retained after a transient failed read. */
    settings: TSettings | null;
    /** Last answer of the page's companion read; `null` until it answers. */
    companion: TCompanion | null;
    loading: boolean;
    /** The failure of the latest settings read, when it failed. */
    failure: HomeDomainFailure | null;
    companionLoading: boolean;
    /** Failure of the latest companion read; the last successful answer is retained. */
    companionFailure: HomeDomainFailure | null;
    /** Completes after the settings answer has been adopted (or its failure recorded). */
    reload: (reason?: HomeSettingsRefreshReason) => Promise<void>;
    /** Adopts the projection a settings write answered with and re-reads the companion. */
    adoptSettings: (settings: HomeSettingsProjectionV1) => void;
    /** Adopts a companion answer a mutation returned (for example the new reachability). */
    adoptCompanion: (companion: TCompanion) => void;
}>;

/**
 * The two reads of a Home console page that edits registry settings: the effective settings (values,
 * sources, locks, pending restart state) and one companion read only its server owner can answer —
 * mail readiness for Email, reachability for Reach. The companion is re-read after every settings
 * write, because only its owner can say what the write changed. Answers for a superseded Home or a
 * superseded read are dropped.
 */
export function useHomeSettingsWithCompanion<TCompanion>(
    scope: ServerAccountScope | null,
    enabled: boolean,
    /** `null` for a page whose settings need no companion read (Features, Data). */
    resource: HomeAdministrationRead<TCompanion> | null,
): HomeSettingsWithCompanion<TCompanion> {
    return useHomeSettingsReads(scope, enabled, resource, selectAllSettings);
}

function selectAllSettings(settings: HomeSettingsProjectionV1): HomeSettingsProjectionV1 {
    return settings;
}

export function useHomeSettingsSelection<TSettings>(
    scope: ServerAccountScope | null,
    enabled: boolean,
    selectSettings: (settings: HomeSettingsProjectionV1) => TSettings,
) {
    return useHomeSettingsReads<never, TSettings>(scope, enabled, null, selectSettings);
}

function useHomeSettingsReads<TCompanion, TSettings>(
    scope: ServerAccountScope | null,
    enabled: boolean,
    resource: HomeAdministrationRead<TCompanion> | null,
    selectSettings: (settings: HomeSettingsProjectionV1) => TSettings,
): HomeSettingsWithCompanion<TCompanion, TSettings> {
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const capturedScope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const readSettings = React.useMemo(() => {
        let lastSnapshot: ReturnType<typeof getHomeSettingsSnapshot> = null;
        let selection: Pick<HomeSettingsWithCompanion<TCompanion, TSettings>, 'settings' | 'loading' | 'failure'> = {
            settings: null, loading: true, failure: null,
        };
        return () => {
            const snapshot = capturedScope ? getHomeSettingsSnapshot(capturedScope) : null;
            if (snapshot === lastSnapshot) return selection;
            lastSnapshot = snapshot;
            const settings = snapshot?.settings ? selectSettings(snapshot.settings) : null;
            const loading = snapshot?.loading ?? true;
            const failure = snapshot?.failure ?? null;
            if (!Object.is(selection.settings, settings) || selection.loading !== loading || selection.failure !== failure) {
                selection = { settings, loading, failure };
            }
            return selection;
        };
    }, [capturedScope, selectSettings]);
    const subscribeSettings = React.useCallback((listener: () => void) => (
        enabled && capturedScope ? subscribeHomeSettingsSnapshots(capturedScope, listener) : () => {}
    ), [enabled, capturedScope]);
    const settings = React.useSyncExternalStore(subscribeSettings, readSettings, readSettings);
    const companion = useHomeAdministrationRead(resource, enabled ? capturedScope : null);
    const { refresh, adopt } = companion;
    const load = React.useCallback(async (reason?: HomeSettingsRefreshReason) => {
        if (!enabled || !capturedScope) return;
        refresh();
        await refreshHomeSettings(capturedScope, reason);
    }, [enabled, capturedScope, refresh]);

    React.useEffect(() => {
        if (enabled && capturedScope) return observeHomeSettings(capturedScope);
    }, [enabled, capturedScope]);

    const adoptSettings = React.useCallback((settings: HomeSettingsProjectionV1) => {
        if (!capturedScope) return;
        adoptHomeSettingsProjection(capturedScope, settings);
    }, [capturedScope]);

    return React.useMemo(() => Object.freeze({
        settings: settings.settings,
        companion: companion.snapshot?.data ?? null,
        loading: settings.loading,
        failure: settings.failure,
        companionLoading: companion.snapshot?.loading ?? resource !== null,
        companionFailure: companion.snapshot?.failure ?? null,
        reload: load,
        adoptSettings,
        adoptCompanion: adopt,
    }), [settings, companion.snapshot, resource, load, adoptSettings, adopt]);
}
