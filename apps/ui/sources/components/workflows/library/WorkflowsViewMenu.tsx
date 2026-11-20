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

import type { RowDetailChoice } from './workflowLibraryCells';

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

/**
 * "Row details" for rows and cards: one switch per detail the list kind declares, its built-ins then the plugin details
 * it admits (`workflowRowDetailChoices`, `workflowRunRowDetailChoices`): every surface lists the same choices.
 */
export function WorkflowsViewRowDetails(
  props: Readonly<{
    choices: readonly RowDetailChoice[];
    onChange: (id: string, enabled: boolean) => void;
    testIDPrefix: string;
  }>,
): React.ReactElement {
  return (
    <ActionListSection
      title={t('workflows.destination.display.rowDetails')}
      actions={props.choices.map((detail) => ({
        id: detail.id,
        testID: `${props.testIDPrefix}:${detail.id}`,
        label: detail.title,
        checked: detail.on,
        onPress: () => props.onChange(detail.id, !detail.on),
      }))}
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

/** Group by for Runs (scene 8 Runs, D2): Date, Project or Workflow. */
export function WorkflowRunsViewGroupBy(props: Readonly<{
    groupBy: WorkflowRunGrouping;
    onGroupBy: (groupBy: WorkflowRunGrouping) => void;
    testID: string;
}>): React.ReactElement {
    return <ActionListSection title={t('workflows.destination.display.groupBy')} actions={RUN_GROUPINGS.map(groupBy => ({
        id: groupBy, testID: `${props.testID}:group:${groupBy}`,
        label: t(`workflows.destination.display.${groupBy}`), selected: props.groupBy === groupBy,
        onPress: () => props.onGroupBy(groupBy),
    }))} />;
}

/**
 * Runs' View menu for its rows (the sidebar and a phone): Group by, then Lines and Row details from the Run display
 * owner (B1 list review 2). The Runs table names its fields Columns instead (`WorkflowRunsHome`). No sections, pins
 * or cards.
 */
export function WorkflowRunsViewMenu(props: Readonly<{
    groupBy: WorkflowRunGrouping;
    onGroupBy: (groupBy: WorkflowRunGrouping) => void;
    rows: Readonly<{
        lines: CollectionLines;
        onLines: (lines: CollectionLines) => void;
        details: readonly RowDetailChoice[];
        onDetail: (id: string, enabled: boolean) => void;
    }>;
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
            onGroupBy={props.onGroupBy} rows={props.rows} testIDPrefix={props.testID} />
    </CollectionColumnsMenuTrigger>;
    return <CollectionColumnsMenuTrigger testID={props.testID} trigger={props.trigger} iconName="sliders-horizontal"
        label={t('workflows.destination.columns.view')}>
        <WorkflowRunsViewGroupBy groupBy={props.groupBy} onGroupBy={props.onGroupBy} testID={props.testID} />
        <WorkflowsViewLines lines={props.rows.lines} onChange={props.rows.onLines} testIDPrefix={`${props.testID}:lines`} />
        <WorkflowsViewRowDetails choices={props.rows.details} onChange={props.rows.onDetail} testIDPrefix={`${props.testID}:detail`} />
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
    /** Rows: Lines and Row details (every list kind), and New section where the kind has sections (workflows). */
    rows?: Readonly<{
        lines: CollectionLines;
        onLines: (lines: CollectionLines) => void;
        details: readonly RowDetailChoice[];
        onDetail: (id: string, enabled: boolean) => void;
        onNewSection?: () => void;
    }>;
    testIDPrefix: string;
}>): React.ReactElement {
    const { rows } = props;
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
            {rows.details.map(detail => <Item key={detail.id} testID={`${props.testIDPrefix}:detail:${detail.id}`}
                title={detail.title}
                rightElement={<Switch value={detail.on} onValueChange={(value) => rows.onDetail(detail.id, value)} />} />)}
        </ItemGroup> : null}
        {rows?.onNewSection ? <ItemGroup>
            <Item testID={`${props.testIDPrefix}:new-section`} title={t('sessionsList.newSection')} onPress={rows.onNewSection} />
        </ItemGroup> : null}
    </ItemList>;
}
