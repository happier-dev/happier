import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import type { EntityListFilterResultV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import {
  compileDeploymentEnvironmentListFilterV1,
  DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1,
  deploymentEnvironmentListFilterFieldsV1,
  type DeploymentEnvironmentListFilterFactsV1,
} from '@happier-dev/protocol/deployments/deploymentEnvironmentListFilterV1';

import {
  createCollectionSpaceDraftStore,
  useCollectionSpaceFilter,
} from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { t } from '@/text';

import { COLLECTION_SPACE_KIND_PRESENTATION } from '@/components/settings/session/collectionSpaceKindPresentation';
import { deploymentEnvironmentRowState } from './deploymentPresentation';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];

/**
 * What a Services row is doing, as its filter reads it, from the same readiness owner its State mark draws
 * (`deploymentEnvironmentRowState`, live health included): a failed or unverified deploy needs the person, a queued or running one deploys, a settled one
 * is deployed, and an Environment nothing was deployed to says so.
 */
export function deploymentEnvironmentListFilterFacts(
  item: EnvironmentItem,
): DeploymentEnvironmentListFilterFactsV1 {
  const latest = deploymentEnvironmentRowState(item);
  return {
    projectSourceId: item.environment.projectSourceId,
    state: !item.currentDeployment
      ? 'notDeployed'
      : latest?.tone === 'danger' || latest?.tone === 'warning'
        ? 'needsYou'
        : latest
          ? 'deploying'
          : 'deployed',
    machineId: item.environment.controllerMachineId,
  };
}

const NO_ITEMS: readonly EnvironmentItem[] = Object.freeze([]);
const SERVICES_SPACE_ICON = { kind: 'icon', name: 'rocket-launch' } as const;
const SERVICES_FILTER_FIELD_ICONS = Object.freeze({
  projects: 'folder',
  states: 'circle-half',
  machines: 'desktop',
} as const);

/** The one Services draft every mounted Services list narrows through (the column and the Apps page). */
const servicesListDraft =
  createCollectionSpaceDraftStore<'deploymentEnvironment'>();

/**
 * Services' saved views and filters (owner D5): the selected space, its added conditions and the Environments they keep.
 * The Services column and the Apps page read the same items through the same draft, so a filter set in one narrows
 * both; neither decides what a filter means.
 */
export function useServicesListView(
  items: readonly EnvironmentItem[] | null | undefined,
  focused: boolean,
) {
  const held = items ?? NO_ITEMS;
  const lifetime = useActiveServerAccountScopeLifetime();
  const binding = useCollectionSpaceFilter('deploymentEnvironment', {
    lifetime,
    defaultName: t(
      COLLECTION_SPACE_KIND_PRESENTATION.deploymentEnvironment.defaultNameKey,
    ),
    defaultFilter: DEFAULT_DEPLOYMENT_ENVIRONMENT_LIST_FILTER_V1,
    draft: servicesListDraft,
  });
  const { filters } = binding;
  const match = React.useMemo(
    () => compileDeploymentEnvironmentListFilterV1(filters),
    [filters],
  );
  const { visible, filterResult } = React.useMemo(() => {
    const visible = new Set<string>();
    let unavailable = !binding.spacesReady || !binding.bound;
    for (const item of binding.bound ? held : NO_ITEMS) {
      const result = match(deploymentEnvironmentListFilterFacts(item));
      if (result === 'match') visible.add(item.environment.id);
      else if (result === 'unavailable') unavailable = true;
    }
    const coverage: EntityListFilterResultV1['coverage'] = unavailable
      ? visible.size
        ? 'partial'
        : 'unavailable'
      : 'complete';
    return {
      visible,
      filterResult: {
        matchedCount: visible.size,
        coverage,
      } satisfies EntityListFilterResultV1,
    };
  }, [binding.bound, binding.spacesReady, held, match]);
  // Until the space binds, nothing narrows: the rows stand as read rather than flashing empty.
  const narrowing = binding.bound && Object.keys(filters).length > 0;
  const isVisible = React.useCallback(
    (environmentId: string) => !narrowing || visible.has(environmentId),
    [narrowing, visible],
  );
  return {
    focused,
    items: held,
    filters,
    // The header's whole next filter from this registry: it replaces the draft, so a removed condition is gone.
    setFilters: binding.setFilters,
    isVisible,
    narrowing,
    filterResult,
    spaces: binding.spaces,
    selectedSpaceId: binding.selectedSpaceId,
    selectedSpace: binding.selectedSpace,
    activeSpace: binding.activeSpace,
    spacesEnabled: binding.spacesEnabled,
    spacesReady: binding.spacesReady,
    spaceSettingsScope: binding.spaceSettingsScope,
  };
}

export type ServicesListViewController = ReturnType<typeof useServicesListView>;

/**
 * The Services saved-view header (owner D5): the shared title chevron, spaces strip, condition tokens, filter button and
 * editor of Sessions and Workflows, bound to the Services view. Each surface places the pieces in its own header.
 */
export function useServicesSpaceHeader(
  view: ServicesListViewController,
  testIDPrefix: string,
  titleScale?: 'page' | 'section',
) {
  const focusEligible = usePluginSurfaceFocusEligibility();
  const { items } = view;
  const machineIds = React.useMemo(
    () => [
      ...new Set(items.map((item) => item.environment.controllerMachineId)),
    ],
    [items],
  );
  const machineNames = useMachineDisplayNamesById(machineIds);
  const bindings = React.useMemo((): CollectionConditionBindings => {
    const projects = new Map<string, string>();
    for (const item of items) {
      if (item.projectSourceName)
        projects.set(item.environment.projectSourceId, item.projectSourceName);
    }
    return {
      fields: {
        projects: {
          label: t('projects.deployments.services.filterProject'),
          valueOptions: [...projects].map(([value, label]) => ({
            value,
            label,
          })),
        },
        states: {
          label: t('projects.deployments.services.columnState'),
          valueOptions: [
            {
              value: 'needsYou',
              label: t('projects.deployments.services.filterNeedsYou'),
            },
            {
              value: 'deploying',
              label: t('projects.deployments.stateRunning'),
            },
            {
              value: 'deployed',
              label: t('projects.deployments.stateSucceeded'),
            },
            {
              value: 'notDeployed',
              label: t('projects.deployments.services.filterNotDeployed'),
            },
          ],
        },
        machines: {
          label: t('sessionsList.filtersMachine'),
          valueOptions: machineIds.flatMap((value) => {
            const label = machineNames[value];
            return label ? [{ value, label }] : [];
          }),
        },
      },
    };
  }, [items, machineIds, machineNames]);
  // What people narrow Services by most, one press each in the title menu: what needs them.
  const facets = React.useMemo(
    () => [
      {
        fieldId: 'states',
        value: 'needsYou',
        label: t('projects.deployments.services.filterNeedsYou'),
      },
    ],
    [],
  );
  const readHeldFacts = React.useCallback(
    function* () {
      for (const item of items)
        yield deploymentEnvironmentListFilterFacts(item);
    },
    [items],
  );
  return useCollectionSpaceHeader({
    entityKind: 'deploymentEnvironment',
    keyboardEnabled: focusEligible && view.focused,
    testIDPrefix,
    defaultName: t(
      COLLECTION_SPACE_KIND_PRESENTATION.deploymentEnvironment.defaultNameKey,
    ),
    view,
    registry: deploymentEnvironmentListFilterFieldsV1,
    bindings,
    fieldIcons: SERVICES_FILTER_FIELD_ICONS,
    facets,
    ...(view.spacesReady ? { readHeldFacts } : {}),
    result: view.filterResult,
    defaultIcon: SERVICES_SPACE_ICON,
    ...(titleScale ? { titleScale } : {}),
  });
}
