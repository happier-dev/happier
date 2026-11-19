import * as React from 'react';

import { useProjectPickerOptions } from '@/components/projects/useProjectPickerOptions';
import {
  MultiSelectField,
  type MultiSelectCandidate,
} from '@/components/ui/forms/dropdown/MultiSelectField';
import { t } from '@/text';

import { usePluginProjectScopeControl } from '../model/usePluginProjectScopeControl';

/** The "All projects" choice: no Project restriction. Not a Project key, so it cannot collide with one. */
const ALL_PROJECTS_ID = '__allProjects__';
const ALL_PROJECTS_SELECTION: readonly string[] = Object.freeze([
  ALL_PROJECTS_ID,
]);

/**
 * "Who can use it": the Account intent's Project scope for one installed plugin (all projects, or only the chosen
 * ones), edited through the intent owner. The row is absent until that intent is readable.
 */
export function PluginProjectScopeItem(
  props: Readonly<{ pluginId: string; disabled?: boolean; testID?: string }>,
) {
  const control = usePluginProjectScopeControl(props.pluginId);
  const projects = useProjectPickerOptions();
  const allProjectsLabel = t('capabilities.store.allProjects');
  const candidates = React.useMemo<readonly MultiSelectCandidate[]>(
    () => [
      { id: ALL_PROJECTS_ID, title: allProjectsLabel },
      ...projects.map((project) => ({
        id: project.projectKey,
        title: project.label,
      })),
    ],
    [allProjectsLabel, projects],
  );
  const projectScope =
    control.kind === 'available' ? control.projectScope : null;
  const selectedIds = React.useMemo(
    () => (projectScope ? projectScope.projectKeys : ALL_PROJECTS_SELECTION),
    [projectScope],
  );
  if (control.kind !== 'available') return null;
  const labelOf = (projectKey: string) =>
    projects.find((project) => project.projectKey === projectKey)?.label ??
    projectKey;
  return (
    <MultiSelectField
      testID={
        props.testID ?? `settings.plugins.detail.${props.pluginId}.projectScope`
      }
      optionTestIDPrefix={`settings.plugins.detail.${props.pluginId}.projectScope.option`}
      title={t('settingsPlugins.surfaces.whoCanUse')}
      candidates={candidates}
      selectedIds={selectedIds}
      exclusiveId={ALL_PROJECTS_ID}
      minimumSelected={1}
      disabled={props.disabled}
      subtitle={(_count, _total, ids) => {
        if (ids.has(ALL_PROJECTS_ID) || ids.size === 0) return allProjectsLabel;
        return t('settingsPlugins.surfaces.projectScopeOnly', {
          projects: [...ids].map(labelOf).join(', '),
        });
      }}
      emptySubtitle={allProjectsLabel}
      searchPlaceholder={t('projects.searchPlaceholder')}
      onCommit={async (ids) => {
        const projectKeys = ids.filter((id) => id !== ALL_PROJECTS_ID);
        await control.setProjectScope(
          projectKeys.length === 0 ? null : { kind: 'only', projectKeys },
        );
      }}
    />
  );
}
