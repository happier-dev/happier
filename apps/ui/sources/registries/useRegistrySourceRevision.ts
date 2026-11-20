import * as React from 'react';
import { listRegistrySourcesV1, type RegistryKindV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { selectRegistrySources } from './registrySourceSelection';
import { usePromptLibraryCatalogSelection } from '@/sync/store/usePromptLibraryCatalog';
import type { PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { useAppShellPluginUiProjection, useAppShellPluginUiProjectionSubscription } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { registrySourceRevision } from './registrySourceRevision';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

const noSubscription = () => () => {};

/** Selected reads retire only with their consumed source; source-list readers consume the whole row. */
export function useRegistrySourceRevision(enabled = true, sourceIds?: readonly string[]): string {
    return useRegistrySourceSelection(enabled, sourceIds).revision;
}

/** Lists acquire additions as a new selection, retaining unchanged source pages while it settles. */
export function useRegistryListSourceSelection(kind: RegistryKindV1 | undefined, enabled = true, sourceIds?: readonly string[], scope?: ServerAccountScope) {
    return useRegistrySourceSelection(enabled, sourceIds, kind, scope);
}

/** A selected listing consumes its configured descriptor without acquiring the source-list catalog. */
export function useRegistrySourceDescriptor(sourceId: string, enabled = true): RegistrySourceDescriptorV1 | undefined {
    const presented = useLayoutPresentationActive();
    const active = enabled && presented;
    const projection = useAppShellPluginUiProjectionSubscription();
    const readPluginSources = React.useCallback(() => registrySourceRevision(
        projectPluginRegistrySources(projection.getSnapshot().pluginUiProjection), [sourceId]), [projection, sourceId]);
    const pluginSelection = React.useSyncExternalStore(active ? projection.subscribe : noSubscription,
        readPluginSources, readPluginSources);
    const pluginSources = React.useMemo(() => JSON.parse(pluginSelection) as RegistrySourceDescriptorV1[], [pluginSelection]);
    const select = React.useCallback((snapshot: PromptLibraryCatalogValueSnapshot<'registry-sources'>) => registrySourceRevision(
        listRegistrySourcesV1({ record: snapshot.value ?? { v: 2, sources: [], disabledSourceIds: [] }, pluginSources }), [sourceId]),
    [pluginSources, sourceId]);
    const selection = usePromptLibraryCatalogSelection('registry-sources', select, undefined, { enabled: active, rowOnly: true });
    return React.useMemo(() => (JSON.parse(selection) as RegistrySourceDescriptorV1[])[0], [selection]);
}

function useRegistrySourceSelection(enabled: boolean, sourceIds?: readonly string[], kind?: RegistryKindV1, scope?: ServerAccountScope) {
    const presented = useLayoutPresentationActive();
    const active = enabled && presented;
    // A Machine still owing its registry sources may carry the only source of this kind (Deploy an app's starters),
    // so an empty selection waits for it; one that answered them, or failed, no longer may. A known catalog never waits.
    const pluginsResolving = useAppShellPluginUiProjection(value => value.registrySourcesPending === true, active);
    const activeSources = useAppShellPluginUiProjection(value => scope === undefined ? value.pluginUiProjection?.registrySourcesById : undefined, active);
    const readSources = React.useCallback(() => scope ? readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })?.registrySourcesById : undefined,
        [scope?.serverId, scope?.accountId]);
    const scopedSources = React.useSyncExternalStore(scope && active ? subscribeCommittedAppShellPluginUiProjection : noSubscription, readSources, readSources);
    const registrySourcesById = scope === undefined ? activeSources : scopedSources;
    const pluginSources = React.useMemo(() => projectPluginRegistrySources(registrySourcesById ? { registrySourcesById } : null), [registrySourcesById]);
    const sourceIdsKey = JSON.stringify(sourceIds);
    const selectedIds = React.useMemo(() => sourceIdsKey === undefined ? undefined : JSON.parse(sourceIdsKey) as string[], [sourceIdsKey]);
    const lifetime = React.useRef<{ sourceIdsKey: string | undefined; fingerprint: string; revision: string; generation: number; sourceIds: string[] | undefined } | null>(null);
    const priorIdsKey = lifetime.current?.sourceIdsKey;
    const priorIds = React.useMemo(() => priorIdsKey === undefined ? undefined : JSON.parse(priorIdsKey) as string[], [priorIdsKey]);
    const select = React.useCallback((snapshot: PromptLibraryCatalogValueSnapshot<'registry-sources'>) => {
        // Partial plugin membership cannot veto known catalogs; each admitted source reports its own failure.
        const { sources, matching, resolving } = selectRegistrySources({ record: snapshot.value,
            recordLoading: snapshot.value === null && snapshot.status === 'loading', pluginSources, pluginsResolving, kind, selectedIds });
        const fingerprint = (ids: readonly string[] | undefined) => ids === undefined
            ? JSON.stringify([snapshot.revision, pluginSources]) : registrySourceRevision(sources, ids);
        const matchingIds = matching.map(source => source.id);
        const consumedIds = kind === undefined ? selectedIds : matchingIds;
        const titles = kind === undefined ? [] : matching.map(source => [source.id, source.title]);
        return JSON.stringify([fingerprint(consumedIds), fingerprint(priorIds), consumedIds ?? null, resolving, titles]);
    }, [selectedIds, priorIds, pluginSources, kind, pluginsResolving]);
    const selection = usePromptLibraryCatalogSelection('registry-sources', select, scope, { enabled: active, rowOnly: true });
    const [fingerprint, priorFingerprint, consumedIds, resolving, titles] = React.useMemo(
        () => JSON.parse(selection) as [string, string, string[] | null, boolean, [string, string][]], [selection]);
    const sourceTitles = React.useMemo(() => new Map(titles), [titles]);
    const previous = lifetime.current;
    // Changing the query's source selection acquires new rows while retaining the
    // former rows inert. Only a change to their consumed configuration retires them.
    const generation = previous ? previous.generation + Number(!resolving && previous.fingerprint !== priorFingerprint) : 0;
    const revision = previous && generation === previous.generation ? previous.revision : JSON.stringify([fingerprint, generation]);
    if (!resolving) lifetime.current = { sourceIdsKey: kind === undefined ? sourceIdsKey : JSON.stringify(consumedIds ?? undefined),
        fingerprint, revision, generation, sourceIds: consumedIds ?? undefined };
    // An unanswered source owner cannot retire a hydrated list or certify an empty one.
    const ids = resolving ? previous?.sourceIds : consumedIds ?? undefined;
    return React.useMemo(() => ({ revision, sourceIds: ids, resolving, sourceTitles }), [revision, ids, resolving, sourceTitles]);
}
