import * as React from 'react';
import { listRegistrySourcesV1 } from '@happier-dev/protocol/registries';
import { usePromptLibraryCatalogSelection } from '@/sync/store/usePromptLibraryCatalog';
import type { PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { registrySourceRevision } from './registrySourceRevision';

/** Selected reads retire only with their consumed source; source-list readers consume the whole row. */
export function useRegistrySourceRevision(enabled = true, sourceIds?: readonly string[]): string {
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
        return JSON.stringify([fingerprint(selectedIds), fingerprint(priorIds)]);
    }, [selectedIds, priorIds, pluginSources]);
    const selection = usePromptLibraryCatalogSelection('registry-sources', select, undefined, { enabled: enabled && presented });
    const [fingerprint, priorFingerprint] = JSON.parse(selection) as [string, string];
    const previous = lifetime.current;
    // Changing the query's source selection acquires new rows while retaining the
    // former rows inert. Only a change to their consumed configuration retires them.
    const generation = previous ? previous.generation + Number(previous.fingerprint !== priorFingerprint) : 0;
    const revision = previous && generation === previous.generation ? previous.revision : JSON.stringify([fingerprint, generation]);
    lifetime.current = { sourceIdsKey, fingerprint, revision, generation };
    return revision;
}
