import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { CollectionColumnsMenuTrigger } from '@/components/ui/lists/collection/CollectionColumnsMenu';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';

import {
  resolveWorkflowRowDetails,
  WORKFLOW_ROW_DETAILS,
  workflowRowDetailTitle,
} from './workflowLibraryCells';

type CollectionLines = 1 | 2 | 3;
const LINES: readonly CollectionLines[] = [1, 2, 3];

/** Lines 1 · 2 · 3 as one segmented row (scene 8 View menu): the setting changes in place and the menu stays open. */
export function WorkflowsViewLines(
  props: Readonly<{
    lines: CollectionLines;
    onChange: (lines: CollectionLines) => void;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const tabs = React.useMemo(
    () => LINES.map((lines) => ({ id: String(lines), label: String(lines) })),
    [],
  );
  return (
    <ActionListSection
      actions={[
        {
          id: 'lines',
          testID: props.testIDPrefix,
          label: t('settingsSession.sessionList.densityMenuTitle'),
          right: (
            <SegmentedTabBar
              tabs={tabs}
              activeTabId={String(props.lines)}
              compact
              segmentSizing="equal"
              onSelectTab={(id) =>
                props.onChange(Number(id) as CollectionLines)
              }
              testIDPrefix={props.testIDPrefix}
              accessibilityLabel={t(
                'settingsSession.sessionList.densityMenuTitle',
              )}
            />
          ),
          rightElementOutsidePressable: true,
        },
      ]}
    />
  );
}

/** "Row details" for rows and cards: one switch per declared detail, then the plugin details the list declares. */
export function WorkflowsViewRowDetails(
  props: Readonly<{
    details: Readonly<Record<string, boolean>> | undefined;
    onChange: (id: string, enabled: boolean) => void;
    pluginDetails: readonly Readonly<{ id: string; title: string }>[];
    testIDPrefix: string;
  }>,
): React.ReactElement {
  const resolved = resolveWorkflowRowDetails(props.details);
  return (
    <ActionListSection
      title={t('workflows.destination.display.rowDetails')}
      actions={[
        ...WORKFLOW_ROW_DETAILS.map((detail) => ({
          id: detail.id,
          testID: `${props.testIDPrefix}:${detail.id}`,
          label: workflowRowDetailTitle(detail.id),
          checked: resolved[detail.id],
          onPress: () => props.onChange(detail.id, !resolved[detail.id]),
        })),
        ...props.pluginDetails.map((detail) => ({
          id: detail.id,
          testID: `${props.testIDPrefix}:${detail.id}`,
          label: detail.title,
          checked: props.details?.[detail.id] === true,
          onPress: () =>
            props.onChange(detail.id, props.details?.[detail.id] !== true),
        })),
      ]}
    />
  );
}

/** The menu's foot: a new section for workflows, through the one sections owner (scene 8 View menu). */
export function WorkflowsViewNewSection(
  props: Readonly<{ onPress: () => void; testID: string }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <ActionListSection
      actions={[
        {
          id: 'newSection',
          testID: props.testID,
          label: t('sessionsList.newSection'),
          icon: (
            <Icon
              name="plus"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
          ),
          onPress: props.onPress,
        },
      ]}
    />
  );
}

type WorkflowRunGrouping = 'date' | 'project' | 'workflow';
const RUN_GROUPINGS: readonly WorkflowRunGrouping[] = ['date', 'project', 'workflow'];

/** Runs' View menu (scene 8 Runs, D2): Group by Date, Project or Workflow; no sections, pins or cards. */
export function WorkflowRunsViewMenu(props: Readonly<{
    groupBy: WorkflowRunGrouping;
    onGroupBy: (groupBy: WorkflowRunGrouping) => void;
    trigger: 'icon' | 'labelled';
    /** A phone's sheet leads with Filters. */
    onFilters?: () => void;
    testID: string;
}>): React.ReactElement {
    return <CollectionColumnsMenuTrigger testID={props.testID} trigger={props.trigger} iconName="sliders-horizontal"
        label={t('workflows.destination.columns.view')}>
        {props.onFilters ? <WorkflowsViewFilters onPress={props.onFilters} testID={`${props.testID}:filters`} /> : null}
        <ActionListSection title={t('workflows.destination.display.groupBy')} actions={RUN_GROUPINGS.map(groupBy => ({
            id: groupBy, testID: `${props.testID}:group:${groupBy}`,
            label: t(`workflows.destination.display.${groupBy}`), selected: props.groupBy === groupBy,
            onPress: () => props.onGroupBy(groupBy),
        }))} />
    </CollectionColumnsMenuTrigger>;
}

/** A phone's View sheet opens the filters too (scene 8 review follow-up 2): no second filter glyph in the head. */
export function WorkflowsViewFilters(props: Readonly<{ onPress: () => void; testID: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    return <ActionListSection actions={[{
        id: 'filters',
        testID: props.testID,
        label: t('sessionsList.filterButton'),
        icon: <Icon name="funnel-simple" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
        right: <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />,
        onPress: props.onPress,
    }]} />;
}

/** Group by for workflows (scene 8 View menu): Source (the default, the shipped groups) or Project ("No project" for the rest). */
export function WorkflowsViewGroupBy(props: Readonly<{
    groupBy: 'source' | 'project';
    onChange: (groupBy: 'source' | 'project') => void;
    testIDPrefix: string;
}>): React.ReactElement {
    return <ActionListSection title={t('workflows.destination.display.groupBy')} actions={(['source', 'project'] as const).map(groupBy => ({
        id: groupBy, testID: `${props.testIDPrefix}:${groupBy}`,
        label: t(`workflows.destination.display.${groupBy}`), selected: props.groupBy === groupBy,
        onPress: () => props.onChange(groupBy),
    }))} />;
}
