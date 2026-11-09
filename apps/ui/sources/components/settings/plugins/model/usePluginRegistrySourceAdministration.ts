import * as React from 'react';
import type { RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { normalizeRegistrySourceUrlV1 } from '@happier-dev/protocol/registries';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourceMutations } from '@/registries/useRegistrySourceMutations';

/** Retained screen presentation only; never a persisted source registry or mutation owner. */
export type MarketplaceSourcePresentationV1 = Readonly<{
    id: string; title: string; sourceUrl: string; enabled: boolean; origin: 'curated' | 'user';
    description?: string | null; registryProfileId?: string; addedAtMs?: number; updatedAtMs?: number;
}>;
export type MarketplaceSourceRegistryPresentationV1 = Readonly<{
    sources: readonly MarketplaceSourcePresentationV1[];
}>;
export type MarketplaceSourceRegistryMutationSettlementV1 =
    | Readonly<{ status: 'success' }>
    | Readonly<{ status: 'unavailable'; reason?: 'not_supported' }>
    | Readonly<{ status: 'outcomeUnknown' }>
    | Readonly<{ status: 'superseded' }>;
type SourceDraftV1 = Readonly<{ sourceId?: string | null; sourceUrl: string; title?: string | null;
    enabled?: boolean; origin?: 'curated' | 'user' | null; description?: string | null; registryProfileId?: string | null;
    preferred?: boolean }>;
export type PluginRegistrySourceAdministrationV1 = Readonly<{
    registry: MarketplaceSourceRegistryPresentationV1 | null;
    sources: readonly RegistrySourceDescriptorV1[]; available: boolean; loading: boolean; loadError: boolean;
    mutationInFlight: boolean; mutationOutcomeUnknown: boolean; refresh: () => void;
    upsertSource: (input: SourceDraftV1) => Promise<MarketplaceSourceRegistryMutationSettlementV1>;
    setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<MarketplaceSourceRegistryMutationSettlementV1>;
    removeSource: (sourceId: string) => Promise<MarketplaceSourceRegistryMutationSettlementV1>;
    setSourceRegistryProfile: (sourceId: string, profileId: string | null) => Promise<MarketplaceSourceRegistryMutationSettlementV1>;
}>;
export type PluginRegistrySourceAdministrationParamsV1 = Readonly<{
    enabled: boolean; focused: boolean;
}>;

/** Thin old-screen projection over the one Account source Action owner. */
export function usePluginRegistrySourceAdministration(
    params: PluginRegistrySourceAdministrationParamsV1,
): PluginRegistrySourceAdministrationV1 {
    const read = useRegistrySources('plugin', params.enabled && params.focused);
    const mutations = useRegistrySourceMutations();
    const [mutationInFlight, setMutationInFlight] = React.useState(false);
    const inFlight = React.useRef(false);
    const [mutationOutcomeUnknown, setMutationOutcomeUnknown] = React.useState(false);
    const registry = React.useMemo(() => read.hasValue ? { sources: read.sources
        // The old screen already has a separate community-npm information row.
        .flatMap(source => {
            if ('packageContent' in source || source.format === 'happier-npm') return [];
            return [{ id: source.id, title: source.title, sourceUrl: source.url, enabled: source.enabled,
            origin: source.origin.kind === 'user' ? 'user' as const : 'curated' as const,
            addedAtMs: source.addedAt, updatedAtMs: source.addedAt,
            ...(source.npmRegistryProfileId ? { registryProfileId: source.npmRegistryProfileId } : {}) }];
        }) } : null, [read.hasValue, read.sources]);
    const apply = React.useCallback(async (run: () => Promise<unknown>): Promise<MarketplaceSourceRegistryMutationSettlementV1> => {
        if (!mutations.ready || inFlight.current) return { status: 'unavailable' };
        inFlight.current = true; setMutationInFlight(true);
        try {
            await run(); setMutationOutcomeUnknown(false);
            return { status: 'success' };
        } catch (cause) {
            const code = cause instanceof Error && 'code' in cause ? cause.code : cause instanceof Error ? cause.message : null;
            if (code === 'outcome_unknown') { setMutationOutcomeUnknown(true); return { status: 'outcomeUnknown' }; }
            return { status: 'unavailable' };
        } finally { inFlight.current = false; setMutationInFlight(false); }
    }, [mutations.ready]);
    const upsertSource = React.useCallback(async (input: SourceDraftV1): Promise<MarketplaceSourceRegistryMutationSettlementV1> => {
        if (input.description?.trim() || input.preferred === true
            || input.origin && input.origin !== 'user') return { status: 'unavailable', reason: 'not_supported' };
        const url = normalizeRegistrySourceUrlV1(input.sourceUrl);
        if (input.sourceId) {
            const source = read.sources.find(source => source.id === input.sourceId);
            if (!source) return { status: 'unavailable' };
            if ('packageContent' in source || source.url !== url) return { status: 'unavailable', reason: 'not_supported' };
            return apply(async () => {
              await mutations.update({ sourceId: source.id,
                ...(input.title?.trim() ? { title: input.title.trim() } : {}),
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }) });
              if(input.registryProfileId!==undefined)await mutations.setToken({sourceId:source.id,npmRegistryProfileId:input.registryProfileId});
            });
        }
        if (input.enabled === false) return { status: 'unavailable', reason: 'not_supported' };
        return apply(() => mutations.create({ url, kinds: ['plugin'], ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          ...(input.registryProfileId ? { npmRegistryProfileId: input.registryProfileId } : {}) }));
    }, [apply, mutations.create, mutations.update, mutations.setToken, read.sources]);
    const refresh = React.useCallback(() => { void read.refresh().then(() => setMutationOutcomeUnknown(false)); }, [read.refresh]);
    return React.useMemo(() => ({ registry, sources: read.sources, available: mutations.ready, loading: read.loading,
        loadError: Boolean(read.error), mutationInFlight, mutationOutcomeUnknown, refresh, upsertSource,
        setSourceEnabled: (sourceId: string, enabled: boolean) => apply(() => mutations.update({ sourceId, enabled })),
        removeSource: (sourceId: string) => apply(() => mutations.delete(sourceId)),
        setSourceRegistryProfile: (sourceId: string, profileId: string | null) => apply(() => mutations.setToken({sourceId,npmRegistryProfileId:profileId})),
    }), [registry, read.sources, read.loading, read.error, mutations.ready, mutations.update, mutations.delete,
        mutations.setToken, apply, mutationInFlight, mutationOutcomeUnknown, refresh, upsertSource]);
}
