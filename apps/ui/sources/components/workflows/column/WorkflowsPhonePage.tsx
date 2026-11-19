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
import { WorkflowRunsColumnRows } from './WorkflowRunsColumnRows';
import { useWorkflowRunCollection, useWorkflowRunCollectionHeader } from '../library/useWorkflowRunCollection';
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
            <WorkflowsColumnActions
              canCreate={props.ownsCreation}
              addOpenerRef={openAddRef}
            />
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
      <RetainedPanelSurface isActive={props.view === 'runs'} hiddenMode="activity" testID="workflows-column:runs">
        <ItemList presentation="grouped" style={styles.events}>
          <WorkflowRunsColumnRows model={runs} selectedRunId={null} testIDPrefix="workflows-phone:runs" />
        </ItemList>
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
