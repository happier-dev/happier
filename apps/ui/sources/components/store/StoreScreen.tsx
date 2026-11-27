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
  const discover = view === 'discover' || (view === undefined && params.plugin === undefined);
  const catalogSourceId = params.catalogSource === undefined ? undefined
    : typeof params.catalogSource === 'string' && params.catalogSource.trim() ? params.catalogSource : null;
  let page: React.ReactElement;
  if (discover) page = <StoreDiscoverPage project={project} storeRoot={view === undefined} />;
  else if (view === 'kind' && params.kind === 'software')
    page = <StoreSoftwarePage presented={focused} />;
  else if (view === 'kind' && typeof params.kind === 'string' && (params.kind === 'app' || !isDirectoryKind(params.kind) && params.kind !== 'plugin'))
    page = <StoreKindSurface kind={params.kind} mode="browse" presented={focused} />;
  else if (view === 'kind' && isDirectoryKind(params.kind))
    page = <StoreKindPage kind={params.kind} presented={focused} />;
  else if (view === 'search') page = <StoreSearchPage presented={focused} />;
  // Installed is every kind Happier manages (S50-UI); Settings → Plugins keeps the plugin-only list.
  else if (view === 'installed') page = <InstalledPage projectKey={project?.projectKey ?? null} />;
  else if (view === 'updates') page = <StoreUpdatesScreen />;
  else if (view === 'jobs') page = <StoreJobsPage />;
  else if (view === 'job' && typeof params.job === 'string')
    page = <StoreJobPage jobId={params.job} catalogSourceId={catalogSourceId} />;
  else if (view === 'category' && typeof params.category === 'string')
    page = <StoreCategoryPage categoryId={params.category} catalogSourceId={catalogSourceId} />;
  else page = <PluginSettingsHomeScreen />;

  return <>
    {discover ? null : <PluginSurfaceProjectionDemand accountScope={accountScope} enabled={focused} />}
    <StoreMachineSelectionProvider presented={focused} accountScope={accountScope}>
      {page}
    </StoreMachineSelectionProvider>
  </>;
});
