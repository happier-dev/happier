import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkflowLibraryView } from '@/components/workflows/library/useWorkflowLibraryView';
import { useWorkflowLibrarySpaceHeader } from '@/components/workflows/library/useWorkflowLibrarySpaceHeader';
import { t } from '@/text';

import { WorkflowsColumnActions } from './WorkflowsColumnActions';
import {
  WorkflowsColumnLibraryContext,
  type WorkflowsColumnLentLibrary,
} from './workflowsColumnCreation';

export type WorkflowsColumnView = 'definitions' | 'runs';

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
  const spaceHeader = useWorkflowLibrarySpaceHeader(
    libraryView,
    'workflows-column-space',
  );
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
        : null,
    [definitions, libraryView.searchQuery, setSearchQuery, spaceHeader.filterButton],
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
          titleControl={definitions ? spaceHeader.titleControl : undefined}
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
                ]}
                activeTabId={props.view}
                onSelectTab={props.onSelectView}
                segmentSizing="equal"
              />
              {definitions ? spaceHeader.strip : null}
              {definitions ? spaceHeader.conditionRow : null}
            </>
          }
        />
        {spaceHeader.overlays}
      </View>
      {definitions ? (
        <WorkflowsColumnLibraryContext.Provider value={lent}>
          {props.definitionsContent}
        </WorkflowsColumnLibraryContext.Provider>
      ) : (
        <SessionsList fixedShow="runs" pathname={props.pathname} />
      )}
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  column: { flex: 1, minHeight: 0 },
}));
