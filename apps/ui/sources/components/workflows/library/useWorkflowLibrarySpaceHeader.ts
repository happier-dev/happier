import * as React from 'react';
import type { CollectionConditionBindings } from '@happier-dev/plugin-ui/components';
import {
  workflowListFilterFieldsV1,
  type WorkflowListFilterV1,
} from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';

import { useCollectionSpaceHeader } from '@/components/ui/lists/collection/useCollectionSpaceHeader';
import { t } from '@/text';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import type { WorkflowLibraryViewController } from './useWorkflowLibraryView';
import { workflowLibraryRowFilterFacts } from './useWorkflowLibraryView';

/** The Workflow fields' words in the shared condition editor (R9): what a definition is doing. */
function buildWorkflowConditionBindings(): CollectionConditionBindings {
  return {
    fields: {
      view: {
        label: t('sessionsList.filtersStatus'),
        valueOptions: [
          {
            value: 'triggered',
            label: t('workflows.destination.views.triggered'),
          },
          {
            value: 'running',
            label: t('workflows.destination.sections.running'),
          },
        ],
      },
    },
  };
}
const WORKFLOW_SPACE_ICON = { kind: 'icon', name: 'list' } as const;

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
  const { rows, summaries } = libraryView;
  const readHeldFacts = React.useCallback(function* () {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      yield workflowLibraryRowFilterFacts(row, summaries);
    }
  }, [rows, summaries]);
  const updateLibraryView = libraryView.update;
  const setFilters = React.useCallback(
    (filters: WorkflowListFilterV1) => updateLibraryView({ filters }),
    [updateLibraryView],
  );
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
      setFilters,
    },
    registry: workflowListFilterFieldsV1,
    bindings,
    ...(libraryView.spacesReady ? { readHeldFacts } : {}),
    result: libraryView.filterResult,
    defaultIcon: WORKFLOW_SPACE_ICON,
    ...(titleScale ? { titleScale } : {}),
  });
}
