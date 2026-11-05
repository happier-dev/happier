import * as React from 'react';
import { usePromptLibraryCatalogSelection } from '@/sync/store/usePromptLibraryCatalog';
import type { PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from './pluginRegistrySources';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const readRevision = (snapshot: PromptLibraryCatalogValueSnapshot<'registry-sources'>) => snapshot.revision;
/** Existing Account row and declaration publication jointly invalidate registry reads. */
export function useRegistrySourceRevision(enabled = true): string {
    const presented = useLayoutPresentationActive();
    const revision = usePromptLibraryCatalogSelection('registry-sources', readRevision, undefined, { enabled: enabled && presented });
    const registrySourcesById = useAppShellPluginUiProjection(value => value.pluginUiProjection?.registrySourcesById);
    return React.useMemo(() => JSON.stringify([revision,
        projectPluginRegistrySources(registrySourcesById ? { registrySourcesById } : null),
    ]), [revision, registrySourcesById]);
}
