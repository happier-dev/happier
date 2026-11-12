import * as React from 'react';

import {
  useIsFocused,
  useLocalSearchParams,
} from '@/components/appShell/workspace/destinationRoute';
import PluginSettingsHomeScreen from '@/components/settings/plugins/PluginSettingsHomeScreen';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { StoreMachineSelectionProvider } from '@/components/settings/plugins/model/useStoreMachineScope';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import {
  StoreCategoryPage,
  StoreDiscoverPage,
  StoreJobPage,
  StoreJobsPage,
} from './discover/StoreDiscoverPages';
import { StoreKindPage, type StoreDirectoryKind } from './StoreKindPage';
import { StoreSearchPage } from './StoreSearchPage';
import { StoreSoftwarePage } from './StoreSoftwarePage';
import { InstalledPage } from './inventory/InstalledPage';
import { StoreUpdatesScreen } from './updates/StoreUpdatesScreen';
import { StoreKindSurface } from './StoreKindSurface';
import { STORE_KIND_ORDER } from './catalog/storeKinds';

const DIRECTORY_KINDS = STORE_KIND_ORDER.filter(kind => kind !== 'software' && kind !== 'plugin');
function isDirectoryKind(kind: unknown): kind is StoreDirectoryKind {
  return typeof kind === 'string' && DIRECTORY_KINDS.some(candidate => candidate === kind);
}

/**
 * The app Store destination's one page dispatcher (`/plugins?view=…`). Discover is the default page.
 *
 * Mount points by owner (S40-UI lanes): Discover, Browse by job, a job and a category belong here (S40-UI-A).
 * Kind pages and search are S40-UI-B's and the Plugins kind still opens the existing Plugins page
 * (S40-UI-B recomposes it); `view=installed` is S50-UI's Installed. A legacy `?plugin=` deep link and `view=browse` keep that page.
 */
export const StoreScreen = React.memo(function StoreScreen() {
  const focused = useIsFocused();
  const accountScope = useAccountSettingsScope();
  return <>
    <PluginSurfaceProjectionDemand accountScope={accountScope} enabled={focused} />
    <StoreMachineSelectionProvider presented={focused} accountScope={accountScope}>
      <StoreScreenContent focused={focused} />
    </StoreMachineSelectionProvider>
  </>;
});

function StoreScreenContent({ focused }: Readonly<{ focused: boolean }>) {
  const params = useLocalSearchParams<{
    view?: string;
    job?: string;
    category?: string;
    catalogSource?: string;
    kind?: string;
    plugin?: string;
  }>();
  const { project } = useStoreProjectScope();
  const view = typeof params.view === 'string' ? params.view : undefined;
  const catalogSourceId = params.catalogSource === undefined ? undefined
    : typeof params.catalogSource === 'string' && params.catalogSource.trim() ? params.catalogSource : null;
  if (view === 'kind' && params.kind === 'software')
    return <StoreSoftwarePage presented={focused} />;
  if (view === 'kind' && typeof params.kind === 'string' && (params.kind === 'app' || !isDirectoryKind(params.kind) && params.kind !== 'plugin'))
    return <StoreKindSurface kind={params.kind} mode="browse" presented={focused} />;
  if (view === 'kind' && isDirectoryKind(params.kind))
    return <StoreKindPage kind={params.kind} presented={focused} />;
  if (view === 'search') return <StoreSearchPage presented={focused} />;
  // Installed is every kind Happier manages (S50-UI); Settings → Plugins keeps the plugin-only list.
  if (view === 'installed') return <InstalledPage projectKey={project?.projectKey ?? null} />;
  if (view === 'updates') return <StoreUpdatesScreen />;
  if (view === 'jobs') return <StoreJobsPage />;
  if (view === 'job' && typeof params.job === 'string')
    return <StoreJobPage jobId={params.job} catalogSourceId={catalogSourceId} />;
  if (view === 'category' && typeof params.category === 'string')
    return <StoreCategoryPage categoryId={params.category} catalogSourceId={catalogSourceId} />;
  if (
    view === 'discover' ||
    (view === undefined && params.plugin === undefined)
  )
    return <StoreDiscoverPage project={project} storeRoot={view === undefined} />;
  return <PluginSettingsHomeScreen />;
}
