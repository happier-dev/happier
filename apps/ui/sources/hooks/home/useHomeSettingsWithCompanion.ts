import * as React from 'react';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { HomeGovernanceQueryOutcome } from '@/sync/ops/home/homeGovernanceOperations';
import { observeHomeSettings, refreshHomeSettings, type HomeSettingsRefreshReason } from '@/sync/engine/home/governance/homeSettingsEngine';
import { adoptHomeSettingsProjection, getHomeSettingsSnapshot, subscribeHomeSettingsAdoptions, subscribeHomeSettingsSnapshots } from '@/sync/store/home/governance/homeSettingsSnapshots';
import { useHomeSettingsLifetime } from './homeSettingsLifetime';

export type HomeSettingsWithCompanion<TCompanion> = Readonly<{
    /** Last settings the Home answered; kept through a later failed read. */
    settings: HomeSettingsProjectionV1 | null;
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

type State<TCompanion> = Readonly<{
    scopeKey: string;
    companion: TCompanion | null;
    companionLoading: boolean;
    companionFailure: HomeDomainFailure | null;
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
    readCompanion: ((scope: ServerAccountScope) => Promise<HomeGovernanceQueryOutcome<TCompanion>>) | null,
): HomeSettingsWithCompanion<TCompanion> {
    const serverId = scope?.serverId ?? '';
    const accountId = scope?.accountId ?? '';
    const capturedScope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const scopeKey = capturedScope ? serverAccountScopeKeySuffix(capturedScope) : '';
    const retain = useHomeSettingsLifetime();
    const readSettings = React.useCallback(() => capturedScope ? getHomeSettingsSnapshot(capturedScope) : null, [capturedScope]);
    const subscribeSettings = React.useCallback((listener: () => void) => (
        enabled && capturedScope ? subscribeHomeSettingsSnapshots(capturedScope, listener) : () => {}
    ), [enabled, capturedScope]);
    const settings = React.useSyncExternalStore(subscribeSettings, readSettings, readSettings);
    const [state, setState] = React.useState<State<TCompanion>>(() => ({ scopeKey, companion: null, companionLoading: readCompanion !== null, companionFailure: null }));
    const generation = React.useRef(0);
    const currentScopeKey = React.useRef(scopeKey);
    React.useLayoutEffect(() => { currentScopeKey.current = scopeKey; }, [scopeKey]);
    const readCompanionRef = React.useRef(readCompanion);
    readCompanionRef.current = readCompanion;
    const hasCompanion = readCompanion !== null;

    const refreshCompanion = React.useCallback((currentGeneration: number) => {
        const read = readCompanionRef.current;
        if (!read || currentScopeKey.current !== scopeKey) return;
        setState((previous) => ({ ...previous, scopeKey, companionLoading: true }));
        void (async () => {
            const companion = await read({ serverId, accountId });
            if (currentGeneration !== generation.current || currentScopeKey.current !== scopeKey) return;
            setState((previous) => companion.kind === 'succeeded'
                ? { ...previous, companion: companion.value, companionLoading: false, companionFailure: null }
                : { ...previous, companionLoading: false, companionFailure: companion.failure });
        })();
    }, [serverId, accountId, scopeKey]);

    const load = React.useCallback(async (reason?: HomeSettingsRefreshReason) => {
        if (!enabled || !capturedScope || currentScopeKey.current !== scopeKey) return;
        const currentGeneration = (generation.current += 1);
        refreshCompanion(currentGeneration);
        await refreshHomeSettings(capturedScope, reason);
    }, [enabled, capturedScope, scopeKey, refreshCompanion]);

    // Only another Home (or another Account on it) starts from nothing. A read that is merely
    // re-enabled or repeated keeps the last answer on screen, so a settled page and its unsaved
    // edits never fall back to a loading state.
    React.useEffect(() => {
        generation.current += 1;
        setState({ scopeKey, companion: null, companionLoading: readCompanionRef.current !== null, companionFailure: null });
        return () => { generation.current += 1; };
    }, [scopeKey]);

    React.useEffect(() => {
        if (!enabled || !capturedScope) return;
        retain?.(capturedScope);
        return observeHomeSettings(capturedScope);
    }, [enabled, capturedScope, retain]);

    React.useEffect(() => {
        if (!enabled || !capturedScope || !hasCompanion) return;
        return subscribeHomeSettingsAdoptions(capturedScope, () => refreshCompanion(generation.current += 1));
    }, [enabled, capturedScope, hasCompanion, refreshCompanion]);

    React.useEffect(() => {
        if (enabled && capturedScope) refreshCompanion(generation.current += 1);
    }, [enabled, capturedScope, refreshCompanion]);

    const adoptSettings = React.useCallback((settings: HomeSettingsProjectionV1) => {
        if (!capturedScope) return;
        adoptHomeSettingsProjection(capturedScope, settings);
    }, [capturedScope]);

    const adoptCompanion = React.useCallback((companion: TCompanion) => {
        if (currentScopeKey.current !== scopeKey) return;
        generation.current += 1;
        setState({ scopeKey, companion, companionLoading: false, companionFailure: null });
    }, [scopeKey]);

    return React.useMemo(() => Object.freeze({
        settings: settings?.settings ?? null,
        companion: state.scopeKey === scopeKey ? state.companion : null,
        loading: settings?.loading ?? true,
        failure: settings?.failure ?? null,
        companionLoading: state.scopeKey === scopeKey ? state.companionLoading : readCompanion !== null,
        companionFailure: state.scopeKey === scopeKey ? state.companionFailure : null,
        reload: load,
        adoptSettings,
        adoptCompanion,
    }), [settings, state, scopeKey, readCompanion, load, adoptSettings, adoptCompanion]);
}
