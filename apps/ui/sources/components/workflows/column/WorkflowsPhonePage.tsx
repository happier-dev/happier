import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { useWorkflowLibraryView } from '@/components/workflows/library/useWorkflowLibraryView';
import { useWorkflowLibrarySpaceHeader } from '@/components/workflows/library/useWorkflowLibrarySpaceHeader';
import { t } from '@/text';

import { useWorkflowsColumnEvents, WorkflowsColumnEventsFilters, WorkflowsColumnEventsListening, WorkflowsColumnEventsRows } from '../events/WorkflowsColumnEvents';

import { WorkflowsColumnActions } from './WorkflowsColumnActions';
import { WorkflowRunsPage } from '../library/WorkflowRunsHome';
import { CollectionColumnsMenuTrigger } from '@/components/ui/lists/collection/CollectionColumnsMenu';
import { useCollectionDisplayOptions } from '@/components/ui/lists/collection/useCollectionDisplayOptions';
import { useWorkflowGroupTabs, WorkflowRunsViewMenu, WorkflowsViewSheetBody } from '../library/WorkflowsViewMenu';
import { useWorkflowRunCollection, useWorkflowRunCollectionHeader } from '../library/useWorkflowRunCollection';
import { useWorkflowLibraryRowExtensions } from '../library/useWorkflowListExtensions';
import { workflowRowDetailChoices, workflowRunRowDetailChoices } from '../library/workflowLibraryCells';
import {
  WorkflowsColumnLibraryContext,
  type WorkflowsColumnLentLibrary,
} from './workflowsColumnCreation';

export type WorkflowsColumnView = 'definitions' | 'runs' | 'events';

/**
 * Workflows as a phone's main screen (owner 11-11): the shell's Home line, then the main-screen head — the library's
 * space as the title ("All workflows ⌄", its spaces and filters), the magnifier that opens the library search, the
 * "⋯" and the "+" whose menu the bar's "+" opens too — with the Definitions | Runs switch and the spaces right under
 * it. The home below reads the same library controller, so it adds no second scope line or search.
 */
export const WorkflowsPhonePage = React.memo(function WorkflowsPhonePage(
  props: Readonly<{
    view: WorkflowsColumnView;
    onSelectView: (view: WorkflowsColumnView) => void;
    ownsCreation: boolean;
    pathname: string;
    definitionsContent: React.ReactNode;
  }>,
) {
  const presented = useLayoutPresentationActive();
  const definitions = props.view === 'definitions';
  const libraryView = useWorkflowLibraryView(presented && definitions);
  const eventsShown = props.view === 'events';
  const events = useWorkflowsColumnEvents(presented && eventsShown);
  const spaceHeader = useWorkflowLibrarySpaceHeader(
    libraryView,
    'workflows-column-space',
  );
  // Runs read the one `workflowRun` collection (scene 8 D2): its space is the title, its search and filters the head's.
  const runsShown = props.view === 'runs';
  const display = useCollectionDisplayOptions('workflow', true);
  const workflowGroupTabs = useWorkflowGroupTabs();
  const createSection = libraryView.workflowSections.create;
  // The same Row details the page and the sidebar offer: the built-ins, then the plugin details the list admits.
  const extensions = useWorkflowLibraryRowExtensions();
  const sheetRows = React.useMemo(() => ({
    lines: display.lines, onLines: display.setLines, details: workflowRowDetailChoices(display.details, extensions.details),
    onDetail: display.setDetail, onNewSection: createSection,
  }), [createSection, display.details, display.lines, display.setDetail, display.setLines, extensions.details]);
  const runs = useWorkflowRunCollection(presented && runsShown);
  const runHeader = useWorkflowRunCollectionHeader(runs, 'workflows-column-runs-space');
  const runSearchQuery = runs.binding.searchQuery;
  const setRunSearchQuery = runs.setSearchQuery;
  const safeAreaTop = useChromeSafeAreaInsets().top;
  const openAddRef = React.useRef<(() => void) | null>(null);
  const addLabel = t('workflows.destination.addAccessibility');
  const create = React.useMemo<PageCreateAction | null>(
    () =>
      props.ownsCreation
        ? {
            label: addLabel,
            testID: 'workflows-add',
            onPress: () => openAddRef.current?.(),
          }
        : null,
    [addLabel, props.ownsCreation],
  );
  const lent = React.useMemo<WorkflowsColumnLentLibrary>(
    () => ({ libraryView }),
    [libraryView],
  );
  const { setSearchQuery } = libraryView;
  const search = React.useMemo(
    () =>
      definitions
        ? {
            value: libraryView.searchQuery,
            onChangeText: setSearchQuery,
            placeholder: t('workflows.destination.searchPlaceholder'),
            testID: 'workflows-search',
            // The space's conditions end the field, as on My work; the title's menu also opens them.
            trailing: spaceHeader.filterButton,
          }
        : runsShown
          ? {
              value: runSearchQuery,
              onChangeText: setRunSearchQuery,
              placeholder: t('workflows.destination.display.searchRuns'),
              testID: 'workflows-runs-search',
              trailing: runHeader.filterButton,
            }
          : null,
    [definitions, libraryView.searchQuery, setSearchQuery, spaceHeader.filterButton, runsShown, runSearchQuery, setRunSearchQuery, runHeader.filterButton],
  );
  return (
    <View testID="workflows-column" style={styles.column}>
      <View
        testID="workflows-column:header"
        style={{ paddingTop: safeAreaTop }}
      >
        <MainScreenHeader
          testID="workflows-header"
          title={t('workflows.title')}
          titleControl={definitions ? spaceHeader.titleControl : runsShown ? runHeader.titleControl : undefined}
          search={search}
          actions={
            <>
              {/* The phone's View sheet (scene 8): Filters first, then the same options as the wide View menu. */}
              {definitions ? (
                <CollectionColumnsMenuTrigger testID="workflows-phone:view" iconName="sliders-horizontal" phoneSheet
                  label={t('workflows.destination.columns.view')}>
                  <WorkflowsViewSheetBody onFilters={spaceHeader.openFilters} groupTabs={workflowGroupTabs} groupBy={display.groupBy}
                    onGroupBy={display.setGroupBy} rows={sheetRows} testIDPrefix="workflows-phone:view" />
                </CollectionColumnsMenuTrigger>
              ) : runsShown ? (
                <WorkflowRunsViewMenu groupBy={runs.display.groupBy} onGroupBy={runs.display.setGroupBy} trigger="icon"
                  rows={{ lines: runs.display.lines, onLines: runs.display.setLines,
                    details: workflowRunRowDetailChoices(runs.display.details, runs.extensions.details), onDetail: runs.display.setDetail }}
                  onFilters={runHeader.openFilters} testID="workflows-phone:runs-view" />
              ) : null}
              <WorkflowsColumnActions
                canCreate={props.ownsCreation}
                addOpenerRef={openAddRef}
                barOwnsAdd
              />
            </>
          }
          create={create}
          createTrigger={null}
          band={
            <>
              <SegmentedTabBar<WorkflowsColumnView>
                testIDPrefix="workflows-column:view"
                accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
                tabs={[
                  { id: 'definitions', label: t('workflows.title') },
                  { id: 'runs', label: t('workflows.tabs.runs') },
                  { id: 'events', label: t('workflows.tabs.events') },
                ]}
                activeTabId={props.view}
                onSelectTab={props.onSelectView}
                segmentSizing="equal"
              />
              {definitions ? spaceHeader.strip : null}
              {definitions ? spaceHeader.conditionRow : null}
              {runsShown ? runHeader.strip : null}
              {runsShown ? runHeader.conditionRow : null}
              {eventsShown ? (
                <View style={styles.eventsHead}>
                  <WorkflowsColumnEventsListening state={events} />
                  <WorkflowsColumnEventsFilters state={events} />
                </View>
              ) : null}
            </>
          }
        />
        {spaceHeader.overlays}
        {runHeader.overlays}
      </View>
      {/* Both views stay built once shown and the switch only presents one: a switch never rebuilds a list. */}
      <RetainedPanelSurface isActive={definitions} hiddenMode="activity" testID="workflows-column:definitions">
        <WorkflowsColumnLibraryContext.Provider value={lent}>
          {props.definitionsContent}
        </WorkflowsColumnLibraryContext.Provider>
      </RetainedPanelSurface>
      {/* Runs are a page: the page list's rows and group labels, as the index (UI refinements 21:44Z, item 4). */}
      <RetainedPanelSurface isActive={props.view === 'runs'} hiddenMode="activity" testID="workflows-column:runs">
        <WorkflowRunsPage model={runs} />
      </RetainedPanelSurface>
      <RetainedPanelSurface isActive={eventsShown} hiddenMode="activity" testID="workflows-column:events">
        <ItemList presentation="grouped" style={styles.events}>
          <WorkflowsColumnEventsRows feed={events.feed} scope={events.scope} filter={events.filter} surface="page"
            active={presented && eventsShown} />
        </ItemList>
      </RetainedPanelSurface>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  column: { flex: 1, minHeight: 0 },
  events: { backgroundColor: 'transparent' },
  eventsHead: { gap: theme.space.s4, paddingTop: theme.space.s4 },
}));
