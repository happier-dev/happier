import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol';
import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_LIST_TEXT, HAPPIER_PRESS_FEEDBACK_V1, HappierPressable, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CollectionList, CollectionListGroupLabel, CollectionNavigationRow, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { AccountTriggersSection } from '@/components/workflows/triggers/AccountTriggersSection';
import { useWorkflowDefinitionLibrary } from '@/components/workflows/library/workflowLibraryReads';
import { useSocketStatus } from '@/sync/domains/state/storage';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';

import { WorkflowsColumnActions } from './WorkflowsColumnActions';
import { splitLibraryDefinitions } from './workflowsColumnModel';

type WorkflowsColumnView = 'definitions' | 'runs';

function isRunPath(pathname: string): boolean {
    return /^\/workflows\/runs(?:\/|$)/.test(pathname);
}

function readOpenDefinition(pathname: string): string | null {
    const match = /^\/workflows\/([^/?#]+)$/.exec(pathname);
    if (!match || ['new', 'runs', 'settings', 'edit'].includes(match[1]!)) return null;
    try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}

/** Definitions and the canonical Sessions list's Runs view share the destination's column. */
export const WorkflowsColumn = React.memo(function WorkflowsColumn(props: Readonly<{ surface?: 'plane' | 'page' }>) {
    const access = useWorkflowsDestinationAccess();
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ trigger?: string }>();
    const [view, setView] = React.useState<WorkflowsColumnView>(() => isRunPath(pathname) ? 'runs' : 'definitions');
    React.useEffect(() => {
        if (params.trigger) setView('definitions');
        else if (isRunPath(pathname)) setView('runs');
        else if (readOpenDefinition(pathname)) setView('definitions');
    }, [pathname, params.trigger]);
    const content = access.kind === 'workflows' ? <View style={styles.column}>
        <View style={styles.views}>
            <SegmentedTabBar<WorkflowsColumnView>
                testIDPrefix="workflows-column:view"
                accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
                tabs={[
                    { id: 'definitions', label: t('workflows.list.definitions') },
                    { id: 'runs', label: t('workflows.tabs.runs') },
                ]}
                activeTabId={view}
                onSelectTab={setView}
                segmentSizing="equal"
            />
        </View>
        {view === 'runs' ? <SessionsList fixedShow="runs" pathname={pathname} /> : (
            <ItemList presentation="grouped" style={styles.definitionsList}><WorkflowsColumnDefinitions /></ItemList>
        )}
    </View> : undefined;
    return <View testID="workflows-column" style={styles.column}>
        <CollectionList
            testID="workflows-column:list"
            surface={props.surface ?? 'plane'}
            title={t('workflows.title')}
            headerAction={access.kind === 'workflows' || access.kind === 'triggersOnly'
                ? <WorkflowsColumnActions canCreate={access.kind === 'workflows'} /> : null}
            scrollContent={content}
        >
            {access.kind === 'triggersOnly' ? <AccountTriggersSection first /> : null}
        </CollectionList>
    </View>;
});

const WorkflowsColumnDefinitions = React.memo(function WorkflowsColumnDefinitions() {
    const router = useRouter();
    const pathname = usePathname();
    const selectedDefinitionId = readOpenDefinition(pathname);
    const socket = useSocketStatus();
    const library = useWorkflowDefinitionLibrary();
    const split = React.useMemo(() => splitLibraryDefinitions(library.definitions, library.pluginWorkflows), [library.definitions, library.pluginWorkflows]);
    const firstLoad = library.status === 'loading' && library.definitions.length === 0;
    const libraryFailed = library.status === 'failed' && library.definitions.length === 0;
    const offline = (socket.status === 'disconnected' || socket.status === 'error')
        && socket.lastConnectedAt !== null && library.status !== 'loading';
    return <>
        {offline ? <View style={styles.freshness}>
            <SurfaceFreshnessLine testID="workflows-column:offline" asOf={socket.lastConnectedAt}
                reason={t('workflows.destination.offline')} action={{ label: t('workflows.retry'), onPress: library.retry }} />
        </View> : null}
        <CollectionListGroupLabel testID="workflows-column:group:library" title={t('workflows.destination.sections.library')}
            {...(split.library.length > 0 ? { count: split.library.length } : {})} first />
        {firstLoad ? <ColumnSkeletonRows count={3} /> : null}
        {libraryFailed ? <ColumnStateLine testID="workflows-column:library:failed" text={t('workflows.destination.columnLoadFailed')}
            action={{ label: t('workflows.retry'), onPress: library.retry }} /> : null}
        {library.status === 'loaded' && split.library.length === 0 ? <EmptyState testID="workflows-column:library:empty"
            layout="line" title={t('workflows.destination.libraryEmpty')} lineDensity="compact" lineRowStyle={collectionListStyles.row} /> : null}
        {split.library.map((definition) => <CollectionNavigationRow key={definition.definitionId}
            href={`/workflows/${encodeURIComponent(definition.definitionId)}`} testID={`workflows-column:library:${definition.definitionId}`}
            title={formatWorkflowDefinitionLibraryTitle(definition)} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === definition.definitionId}
            {...(definition.contentStatus === 'unavailable' ? { subtitle: formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) } : {})}
            onPress={() => router.push(`/workflows/${encodeURIComponent(definition.definitionId)}` as never)} />)}
        <AccountTriggersSection />
        {split.sharedWithYou.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:sharedWithYou" title={t('workflows.destination.sections.sharedWithYou')}
                count={split.sharedWithYou.length} />
            {split.sharedWithYou.map((definition) => <CollectionNavigationRow key={definition.definitionId}
                href={`/workflows/${encodeURIComponent(definition.definitionId)}`} testID={`workflows-column:shared:${definition.definitionId}`}
                title={formatWorkflowDefinitionLibraryTitle(definition)} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === definition.definitionId}
                {...(definition.contentStatus === 'unavailable' ? { subtitle: formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) } : {})}
                onPress={() => router.push(`/workflows/${encodeURIComponent(definition.definitionId)}` as never)} />)}
        </> : null}
        <ColumnBuiltins selectedDefinitionId={selectedDefinitionId} />
        {split.fromPlugins.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:fromPlugins" title={t('workflows.plugins.fromPlugins')}
                count={split.fromPlugins.length} />
            {split.fromPlugins.map((workflow) => <CollectionNavigationRow key={workflow.workflow}
                href={`/workflows/${encodeURIComponent(workflow.workflow)}`} testID={`workflows-column:plugin:${workflow.workflow}`}
                title={workflow.title} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === workflow.workflow}
                onPress={() => router.push(`/workflows/${encodeURIComponent(workflow.workflow)}` as never)} />)}
        </> : null}
    </>;
});

/**
 * The column's Built-in group (07 S1, lab `convo-N7`): the same navigation row as Library, mark and name
 * only. Run now and Choose a session… stay on each built-in's page and on the library home, so the
 * column carries one row anatomy and never repeats the home's description.
 */
function ColumnBuiltins(props: Readonly<{ selectedDefinitionId: string | null }>) {
    const router = useRouter();
    const entries = getBuiltinWorkflowCatalogV1();
    return <>
        <CollectionListGroupLabel testID="workflows-column:group:builtin" title={t('workflows.page.blocks.builtin')} count={entries.length} />
        {entries.map((entry) => {
            const href = createWorkflowDefinitionRoute(entry.id);
            return <CollectionNavigationRow key={entry.id} href={href} testID={`workflows-column:builtin:${entry.id}`}
                title={tLoose(entry.titleKey)} icon={<Icon name="tree-structure" />} selected={props.selectedDefinitionId === entry.id}
                onPress={() => router.push(href as never)} />;
        })}
    </>;
}

function ColumnGroupLink(props: Readonly<{ testID: string; label: string; onPress: () => void }>) {
    const { theme } = useUnistyles();
    return <HappierPressable testID={props.testID} accessibilityRole="link" accessibilityLabel={props.label} onPress={props.onPress}
        style={(state) => [styles.groupLink, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
        <Text style={styles.groupLinkText}>{props.label}</Text>
    </HappierPressable>;
}

function ColumnStateLine(props: Readonly<{ testID: string; text: string; action: Readonly<{ label: string; onPress: () => void }> }>) {
    return <View testID={props.testID} style={styles.stateLine}>
        <Text style={styles.stateLineText}>{props.text}</Text>
        <ColumnGroupLink testID={`${props.testID}:retry`} label={props.action.label} onPress={props.action.onPress} />
    </View>;
}

function ColumnSkeletonRows(props: Readonly<{ count: number }>) {
    const { theme } = useUnistyles();
    return <>{Array.from({ length: props.count }, (_, index) => <View key={index} style={styles.skeletonRow} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <HappierSkeletonBlock color={theme.colors.surface.pressedOverlay} width={HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox} height={HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox - 4} radius={4} />
        <HappierSkeletonBlock color={theme.colors.surface.pressedOverlay} width={index % 2 === 0 ? '62%' : '48%'} height={10} radius={4} />
    </View>)}</>;
}

const styles = StyleSheet.create((theme) => ({
    column: { flex: 1, minHeight: 0 },
    views: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop },
    definitionsList: { backgroundColor: 'transparent' },
    freshness: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop },
    groupLink: { borderRadius: theme.borderRadius.sm, borderWidth: 1, borderColor: 'transparent',
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS), justifyContent: 'center', alignSelf: 'flex-start' },
    groupLinkText: { ...Typography.default(HAPPIER_COLLECTION_LIST_TEXT.groupCount.weight), fontSize: HAPPIER_COLLECTION_LIST_TEXT.groupCount.fontSize, lineHeight: HAPPIER_COLLECTION_LIST_TEXT.groupCount.lineHeight, color: theme.colors.text.secondary },
    stateLine: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset, paddingVertical: theme.margins.xs, gap: theme.margins.xs, alignItems: 'flex-start' },
    stateLineText: { ...Typography.default(HAPPIER_COLLECTION_LIST_TEXT.rowTitle.weight), fontSize: HAPPIER_COLLECTION_LIST_TEXT.rowTitle.fontSize, lineHeight: HAPPIER_COLLECTION_LIST_TEXT.rowTitle.lineHeight, color: theme.colors.text.secondary },
    skeletonRow: { minHeight: HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight, flexDirection: 'row', alignItems: 'center', gap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap, paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset },
}));
