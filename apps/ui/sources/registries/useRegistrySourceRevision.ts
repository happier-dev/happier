import * as React from 'react';
import { listRegistrySourcesV1, type RegistryKindV1 } from '@happier-dev/protocol/registries';
import { usePromptLibraryCatalogSelection } from '@/sync/store/usePromptLibraryCatalog';
import type { PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { registrySourceRevision } from './registrySourceRevision';

/** Selected reads retire only with their consumed source; source-list readers consume the whole row. */
export function useRegistrySourceRevision(enabled = true, sourceIds?: readonly string[]): string {
    return useRegistrySourceSelection(enabled, sourceIds).revision;
}

/** Lists acquire additions as a new selection, retaining unchanged source pages while it settles. */
export function useRegistryListSourceSelection(kind: RegistryKindV1, enabled = true, sourceIds?: readonly string[]) {
    return useRegistrySourceSelection(enabled, sourceIds, kind);
}

function useRegistrySourceSelection(enabled: boolean, sourceIds?: readonly string[], kind?: RegistryKindV1) {
    const presented = useLayoutPresentationActive();
    const registrySourcesById = useAppShellPluginUiProjection(value => value.pluginUiProjection?.registrySourcesById);
    const pluginSources = React.useMemo(() => projectPluginRegistrySources(registrySourcesById ? { registrySourcesById } : null), [registrySourcesById]);
    const sourceIdsKey = JSON.stringify(sourceIds);
    const selectedIds = React.useMemo(() => sourceIdsKey === undefined ? undefined : JSON.parse(sourceIdsKey) as string[], [sourceIdsKey]);
    const lifetime = React.useRef<{ sourceIdsKey: string | undefined; fingerprint: string; revision: string; generation: number } | null>(null);
    const priorIdsKey = lifetime.current?.sourceIdsKey;
    const priorIds = React.useMemo(() => priorIdsKey === undefined ? undefined : JSON.parse(priorIdsKey) as string[], [priorIdsKey]);
    const select = React.useCallback((snapshot: PromptLibraryCatalogValueSnapshot<'registry-sources'>) => {
        const sources = listRegistrySourcesV1({ record: snapshot.value ?? { v: 2, sources: [], disabledSourceIds: [] }, pluginSources });
        const fingerprint = (ids: readonly string[] | undefined) => ids === undefined
            ? JSON.stringify([snapshot.revision, pluginSources]) : registrySourceRevision(sources, ids);
        const consumedIds = kind === undefined ? selectedIds : sources.filter(source => source.enabled
            && source.kinds.includes(kind) && (selectedIds === undefined || selectedIds.includes(source.id))).map(source => source.id);
        return JSON.stringify([fingerprint(consumedIds), fingerprint(priorIds), consumedIds ?? null]);
    }, [selectedIds, priorIds, pluginSources, kind]);
    const selection = usePromptLibraryCatalogSelection('registry-sources', select, undefined, { enabled: enabled && presented });
    const [fingerprint, priorFingerprint, consumedIds] = React.useMemo(
        () => JSON.parse(selection) as [string, string, string[] | null], [selection]);
    const previous = lifetime.current;
    // Changing the query's source selection acquires new rows while retaining the
    // former rows inert. Only a change to their consumed configuration retires them.
    const generation = previous ? previous.generation + Number(previous.fingerprint !== priorFingerprint) : 0;
    const revision = previous && generation === previous.generation ? previous.revision : JSON.stringify([fingerprint, generation]);
    lifetime.current = { sourceIdsKey: kind === undefined ? sourceIdsKey : JSON.stringify(consumedIds ?? undefined),
        fingerprint, revision, generation };
    return React.useMemo(() => ({ revision, sourceIds: consumedIds ?? undefined }), [revision, consumedIds]);
}
