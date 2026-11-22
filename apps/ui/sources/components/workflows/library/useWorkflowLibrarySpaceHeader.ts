import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import { workflowListFilterFieldsV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';

import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { t } from '@/text';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import type { WorkflowLibraryView, WorkflowLibraryViewController } from './useWorkflowLibraryView';
import { workflowLibraryRowFilterFacts } from './useWorkflowLibraryView';

/** The Workflow views' words in the shared condition editor. */
function buildWorkflowConditionBindings(): CollectionConditionBindings {
  const views = {
    triggered: t('workflows.destination.views.triggered'),
    running: t('workflows.destination.sections.running'),
    hunts: t('workflows.destination.views.hunts'),
  } satisfies Record<Exclude<WorkflowLibraryView, 'all'>, string>;
  return {
    fields: {
      view: {
        label: t('workflows.destination.columns.view'),
        valueOptions: Object.entries(views).map(([value, label]) => ({ value, label })),
      },
    },
  };
}
const WORKFLOW_SPACE_ICON = { kind: 'icon', name: 'list' } as const;
/** The Workflows registry's field mark in the filter editor. */
const WORKFLOW_FILTER_FIELD_ICONS = Object.freeze({ view: 'circle-half' } as const);

/**
 * The saved-space header of a Workflow library list (R9, R8-7): the title chevron, spaces strip, condition
 * tokens, filter button and editor of Sessions, bound to the one Workflow library controller. The column
 * and the library home each place the pieces in their own header; both narrow through the same draft.
 */
export function useWorkflowLibrarySpaceHeader(
  libraryView: WorkflowLibraryViewController,
  testIDPrefix: string,
  titleScale?: 'page' | 'section',
) {
  const focusEligible = usePluginSurfaceFocusEligibility();
  const bindings = React.useMemo(buildWorkflowConditionBindings, []);
  // The field's own choices, in its own words, one press away in the title menu.
  const facets = React.useMemo(() => (bindings.fields?.view?.valueOptions ?? []).map((option) => ({
    fieldId: 'view', value: option.value, label: option.label ?? String(option.value),
  })), [bindings]);
  const { rows, summaries } = libraryView;
  const readHeldFacts = React.useCallback(function* () {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      yield workflowLibraryRowFilterFacts(row, summaries);
    }
  }, [rows, summaries]);
  return useCollectionSpaceHeader({
    entityKind: 'workflow',
    keyboardEnabled: focusEligible && libraryView.focused,
    testIDPrefix,
    defaultName: t('sessionsList.spacesAllWorkflows'),
    view: {
      spaces: libraryView.spaces,
      selectedSpaceId: libraryView.selectedSpaceId,
      selectedSpace: libraryView.selectedSpace,
      activeSpace: libraryView.activeSpace,
      spacesEnabled: libraryView.spacesEnabled,
      spacesReady: libraryView.spacesReady,
      spaceSettingsScope: libraryView.spaceSettingsScope,
      filters: libraryView.filters,
      setFilters: libraryView.setFilters,
    },
    registry: workflowListFilterFieldsV1,
    bindings,
    fieldIcons: WORKFLOW_FILTER_FIELD_ICONS,
    facets,
    ...(libraryView.spacesReady ? { readHeldFacts } : {}),
    result: libraryView.filterResult,
    defaultIcon: WORKFLOW_SPACE_ICON,
    ...(titleScale ? { titleScale } : {}),
  });
}
