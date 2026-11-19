import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { CollectionColumnsMenuTrigger } from '@/components/ui/lists/collection/CollectionColumnsMenu';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
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

/** Workflows' Group by choices for the phone sheet: Source (the shipped groups) or Project. */
export function useWorkflowGroupTabs(): readonly Readonly<{ id: 'source' | 'project'; label: string }>[] {
    return React.useMemo(() => (['source', 'project'] as const).map(id => ({ id, label: t(`workflows.destination.display.${id}`) })), []);
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
    const groupTabs = React.useMemo(() => RUN_GROUPINGS.map(id => ({ id, label: t(`workflows.destination.display.${id}`) })), []);
    // A phone's View is the same bottom sheet as the Workflows one (UI refinements ruling, fix 6b): Filter, then Group by.
    if (props.onFilters) return <CollectionColumnsMenuTrigger testID={props.testID} trigger={props.trigger} iconName="sliders-horizontal"
        phoneSheet label={t('workflows.destination.columns.view')}>
        <WorkflowsViewSheetBody<WorkflowRunGrouping> onFilters={props.onFilters} groupTabs={groupTabs} groupBy={props.groupBy}
            onGroupBy={props.onGroupBy} testIDPrefix={props.testID} />
    </CollectionColumnsMenuTrigger>;
    return <CollectionColumnsMenuTrigger testID={props.testID} trigger={props.trigger} iconName="sliders-horizontal"
        label={t('workflows.destination.columns.view')}>
        <ActionListSection title={t('workflows.destination.display.groupBy')} actions={RUN_GROUPINGS.map(groupBy => ({
            id: groupBy, testID: `${props.testID}:group:${groupBy}`,
            label: t(`workflows.destination.display.${groupBy}`), selected: props.groupBy === groupBy,
            onPress: () => props.onGroupBy(groupBy),
        }))} />
    </CollectionColumnsMenuTrigger>;
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

/**
 * A phone's View sheet (scene 8 `lists-view-390`, UI refinements ruling 18:23Z fix 6): the settings anatomy, not a menu.
 * Filters first, then Group by and Lines, then one switch per Row detail, then New section. The same display owner the
 * wide View menu writes.
 */
export function WorkflowsViewSheetBody<Group extends string>(props: Readonly<{
    onFilters: () => void;
    groupTabs: readonly Readonly<{ id: Group; label: string }>[];
    groupBy: Group;
    onGroupBy: (groupBy: Group) => void;
    /** Rows only (workflows): Lines, Row details and New section. Runs have none of them (D2). */
    rows?: Readonly<{
        lines: CollectionLines;
        onLines: (lines: CollectionLines) => void;
        details: Readonly<Record<string, boolean>> | undefined;
        onDetail: (id: string, enabled: boolean) => void;
        onNewSection: () => void;
    }>;
    testIDPrefix: string;
}>): React.ReactElement {
    const { rows } = props;
    const resolved = resolveWorkflowRowDetails(rows?.details);
    const lineTabs = React.useMemo(() => LINES.map(lines => ({ id: String(lines), label: String(lines) })), []);
    // A configuration sheet takes the page anatomy: its section labels stand on the cards' edge (acceptance item 5).
    return <ItemList presentation="page">
        <ItemGroup>
            <Item testID={`${props.testIDPrefix}:filters`} title={t('sessionsList.filterButton')} showChevron onPress={props.onFilters} />
        </ItemGroup>
        <ItemGroup>
            <Item title={t('workflows.destination.display.groupBy')} accessoryLayout="adaptive"
                rightElement={<SegmentedTabBar<Group> tabs={props.groupTabs} activeTabId={props.groupBy} segmentSizing="content"
                    onSelectTab={props.onGroupBy} testIDPrefix={`${props.testIDPrefix}:group`}
                    accessibilityLabel={t('workflows.destination.display.groupBy')} />} />
            {rows ? <Item title={t('settingsSession.sessionList.densityMenuTitle')} accessoryLayout="stacked"
                rightElement={<SegmentedTabBar tabs={lineTabs} activeTabId={String(rows.lines)} segmentSizing="equal"
                    onSelectTab={(id) => rows.onLines(Number(id) as CollectionLines)} testIDPrefix={`${props.testIDPrefix}:lines`}
                    accessibilityLabel={t('settingsSession.sessionList.densityMenuTitle')} />} /> : null}
        </ItemGroup>
        {rows ? <ItemGroup title={t('workflows.destination.display.rowDetails')}>
            {WORKFLOW_ROW_DETAILS.map(detail => <Item key={detail.id} testID={`${props.testIDPrefix}:detail:${detail.id}`}
                title={workflowRowDetailTitle(detail.id)}
                rightElement={<Switch value={resolved[detail.id]} onValueChange={(value) => rows.onDetail(detail.id, value)} />} />)}
        </ItemGroup> : null}
        {rows ? <ItemGroup>
            <Item testID={`${props.testIDPrefix}:new-section`} title={t('sessionsList.newSection')} onPress={rows.onNewSection} />
        </ItemGroup> : null}
    </ItemList>;
}
