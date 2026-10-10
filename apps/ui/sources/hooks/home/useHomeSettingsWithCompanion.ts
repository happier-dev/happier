import * as React from 'react';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getHomeSettings, type HomeGovernanceQueryOutcome } from '@/sync/ops/home/homeGovernanceOperations';

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
    reload: () => Promise<void>;
    /** Adopts the projection a settings write answered with and re-reads the companion. */
    adoptSettings: (settings: HomeSettingsProjectionV1) => void;
    /** Adopts a companion answer a mutation returned (for example the new reachability). */
    adoptCompanion: (companion: TCompanion) => void;
}>;

type State<TCompanion> = Readonly<{
    settings: HomeSettingsProjectionV1 | null;
    companion: TCompanion | null;
    loading: boolean;
    failure: HomeDomainFailure | null;
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
    const [state, setState] = React.useState<State<TCompanion>>(() => ({ settings: null, companion: null, loading: true, failure: null, companionLoading: readCompanion !== null, companionFailure: null }));
    const generation = React.useRef(0);
    const readCompanionRef = React.useRef(readCompanion);
    readCompanionRef.current = readCompanion;

    const refreshCompanion = React.useCallback((currentGeneration: number) => {
        const read = readCompanionRef.current;
        if (!read) return;
        setState((previous) => ({ ...previous, companionLoading: true }));
        void (async () => {
            const companion = await read({ serverId, accountId });
            if (currentGeneration !== generation.current) return;
            setState((previous) => companion.kind === 'succeeded'
                ? { ...previous, companion: companion.value, companionLoading: false, companionFailure: null }
                : { ...previous, companionLoading: false, companionFailure: companion.failure });
        })();
    }, [serverId, accountId]);

    const load = React.useCallback(async () => {
        if (!enabled || !serverId || !accountId) return;
        const currentGeneration = (generation.current += 1);
        setState((previous) => ({ ...previous, loading: true, failure: null }));
        refreshCompanion(currentGeneration);
        const settings = await getHomeSettings({ scope: { serverId, accountId } });
        if (currentGeneration !== generation.current) return;
        setState((previous) => settings.kind === 'succeeded'
            ? { ...previous, settings: settings.value, loading: false, failure: null }
            : { ...previous, loading: false, failure: settings.failure });
    }, [enabled, serverId, accountId, refreshCompanion]);

    // Only another Home (or another Account on it) starts from nothing. A read that is merely
    // re-enabled or repeated keeps the last answer on screen, so a settled page and its unsaved
    // edits never fall back to a loading state.
    React.useEffect(() => {
        generation.current += 1;
        setState({ settings: null, companion: null, loading: true, failure: null, companionLoading: readCompanionRef.current !== null, companionFailure: null });
    }, [serverId, accountId]);

    React.useEffect(() => {
        void load();
    }, [load]);

    const adoptSettings = React.useCallback((settings: HomeSettingsProjectionV1) => {
        const currentGeneration = (generation.current += 1);
        setState((previous) => ({ ...previous, settings, loading: false, failure: null }));
        refreshCompanion(currentGeneration);
    }, [refreshCompanion]);

    const adoptCompanion = React.useCallback((companion: TCompanion) => {
        setState((previous) => ({ ...previous, companion, companionLoading: false, companionFailure: null }));
    }, []);

    return React.useMemo(() => Object.freeze({
        settings: state.settings,
        companion: state.companion,
        loading: state.loading,
        failure: state.failure,
        companionLoading: state.companionLoading,
        companionFailure: state.companionFailure,
        reload: load,
        adoptSettings,
        adoptCompanion,
    }), [state, load, adoptSettings, adoptCompanion]);
}
