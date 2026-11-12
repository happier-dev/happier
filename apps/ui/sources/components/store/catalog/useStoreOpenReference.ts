import * as React from 'react';
import type { MarketplaceCatalogReferenceV1 } from '@happier-dev/protocol/marketplace';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { useOpenAgentBrowse } from '@/components/settings/agents/collection/AgentCollectionList';
import { useOpenMcpAddModal } from '@/components/settings/mcpServers/add/useOpenMcpAddModal';
import { newProviderRoute } from '@/components/settings/providers/collection/providerCollectionModel';
import { useOpenSkillAddModal } from '@/components/settings/skills/add/useOpenSkillAddModal';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useOpenStoreListing } from '../StoreListing';
import { useOpenNewApp } from '@/components/projects/starters/newAppPresentation';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import { useStoreMachineScope, useStoreBrowserProfileScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';

/** Every category/collection opens the same source-qualified Store list, retaining its existing scopes. */
export function useOpenStoreCategory() {
  const router = useRouter();
  const { project } = useStoreProjectScope();
  const machine = useStoreMachineScope();
  const browserProfile = useStoreBrowserProfileScope();
  const directory = useStoreDirectoryState().state;
  const navigateWithFocusReturn = useNavigationFocusReturn();
  return React.useCallback((categoryId: string, catalogSourceId: string) => {
    const href = buildPluginsHomeRoute('app', { view: 'category', category: categoryId, catalogSourceId,
      project, machine, browserProfile, query: directory?.query, filters: directory?.filters });
    const result = runGuardedNavigation(() => navigateWithFocusReturn(() => router.pushRetainingCurrent(href as never)));
    if (result !== true) fireAndForget(result, { tag: 'useOpenStoreCategory' });
  }, [router, project, machine, browserProfile, directory, navigateWithFocusReturn]);
}

/** Declaration navigation uses the existing domain route owners, independent of a displayed title. */
export function resolveStoreContributionRoute(reference: Extract<MarketplaceCatalogReferenceV1, { type: 'providerContribution' | 'agentContribution' }>): string | null {
  if (reference.type === 'providerContribution') return newProviderRoute(reference.contributionKey);
  const entry = getResolvedAgentCatalogEntries({ enabledAgentIds: [] })
    .find(candidate => candidate.backendTargetKey === reference.targetKey);
  return entry ? createAgentSettingsRoute(entry) : null;
}

/**
 * Opens one curated choice (featured, a job's option, a category row) through its kind's existing Add/listing
 * owner, seeded at the exact native reference: an MCP server or skill at its source/item (and version when the
 * curation pinned one), a registry Agent in the Agent browse, a Provider in its setup, an Agent built into Happier on
 * its own Settings page (nothing to add). A reference kind without
 * such an owner keeps the Store selection, the one place a listing for it is addressed. No title lookup.
 */
export function useStoreOpenReference(): (
  reference: MarketplaceCatalogReferenceV1,
) => void {
  const router = useRouter();
  const openMcp = useOpenMcpAddModal();
  const openSkill = useOpenSkillAddModal();
  const openAgent = useOpenAgentBrowse();
  // The one listing opener: beside the page where a pane fits, pushed as its own page on a phone (S40 §4.2).
  const openStore = useOpenStoreListing();
  const openNewApp = useOpenNewApp();
  return React.useCallback(
    (reference) => {
      const go = (href: string, tag: string) => {
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag });
      };
      if (reference.type === 'software') {
        openStore(reference);
        return;
      }
      if (reference.type !== 'registryItem') {
        const href = resolveStoreContributionRoute(reference);
        if (href) go(href, 'useStoreOpenReference.contribution');
        else openStore(reference);
        return;
      }
      const pointer = {
        sourceId: reference.sourceId,
        itemId: reference.itemId,
        ...(reference.version ? { version: reference.version } : {}),
      };
      switch (reference.kind) {
        case 'starter':
          openNewApp(reference.itemId);
          return;
        case 'mcpServer':
          openMcp({
            modeKey: 'catalog',
            initialSelection: {
              sourceId: reference.sourceId,
              itemId: reference.itemId,
              version: reference.version,
            },
          });
          return;
        case 'skill':
          openSkill({ modeKey: 'browse', initialSelection: pointer });
          return;
        case 'agent':
          openAgent({ initialModeKey: 'browse', initialSelection: pointer });
          return;
        default:
          openStore(reference);
      }
    },
    [openAgent, openMcp, openSkill, openStore, openNewApp, router],
  );
}
