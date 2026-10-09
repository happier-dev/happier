import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HappierPageHeader } from '@happier-dev/plugin-ui/presentation';

import { usePaneHeaderSlotContent, type PaneHeaderLine } from '@/components/appShell/panes/paneHeaderSlot';
import type { MachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { useDeviceType } from '@/utils/platform/responsive';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalServiceInventory } from '@/sync/domains/local/services/inventory/useLocalServiceInventory';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import {
    createLocalServiceLauncherState,
    selectLocalServiceLaunchTargets,
    type LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import { readLocalServiceDiagnostics } from '@/sync/domains/local/services/presentation';
import {
    buildLocalServiceRows,
    groupLocalServiceRowsBySection,
    selectLocalServiceRunningCount,
    type ServiceRow,
    type ServiceRowSection,
} from '@/sync/domains/local/services/serviceRow';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import { ServiceStatusDot } from './ServiceStatusDot';
import type { LocalServiceCapabilityDisabledReasons } from './useLocalServicePublicPreviewFeature';
import {
    ServiceRowView,
    type ServiceRowCopyUrlHandler,
    type ServiceRowForgetHandler,
    type ServiceRowManagedControlHandler,
    type ServiceRowOpenHandler,
    type ServiceRowStartHandler,
    type ServiceRowTerminateHandler,
} from './ServiceRowView';

/**
 * Which services the surface is asking for. Owned here because the pane is the only component that
 * both renders the choice and passes it to the row model — the hand-rolled `ServicesScopeToggle`
 * that used to own this type has been replaced by the canonical `SegmentedTabBar` (U-6).
 */
export type ServicesScope = 'workspace' | 'machine';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    /**
     * The pane's own scroll. It had none: the bands, the suggestion band and the public-preview
     * group were stacked in a `flex: 1` View inside an absolutely positioned panel, so on a short
     * viewport — or simply with enough services — everything below the fold was unreachable, and
     * the public-preview group is the LAST thing in the stack. No ancestor scrolls this axis
     * (`SessionRightPanel` mounts it inside a `RetainedPanelSurface` overlay), so this is the owner.
     */
    scrollContent: {
        paddingBottom: 24,
    },
    /** A whole-pane state that still has plugin surfaces below it: the state keeps the pane's height. */
    stateScrollContent: {
        flexGrow: 1,
        paddingBottom: 24,
    },
    scopeToggle: {
        marginHorizontal: 16,
        marginBottom: 8,
    },
    /** On the Services page the scope sits under the purpose at its own width, not across the column. */
    scopeTogglePage: {
        alignSelf: 'flex-start',
    },
    offlineLine: {
        marginTop: 4,
    },
}));

function sectionTitle(section: ServiceRowSection, machineName: string | null): string {
    switch (section) {
        case 'running':
            return t('localServices.pane.sectionRunning');
        case 'ready':
            return t('localServices.pane.sectionReady');
        case 'elsewhere':
            return machineName
                ? t('localServices.pane.sectionElsewhereOn', { machine: machineName })
                : t('localServices.pane.sectionElsewhere');
        case 'happier':
            return '';
    }
}

/**
 * The pane header's live line (session-tabs lab S/ST): what runs here, on which machine — or that the
 * machine is offline. The leading marks are module constants so the published line stays
 * referentially stable between renders.
 */
function buildHeaderLine(input: Readonly<{
    offline: boolean;
    runningCount: number;
    machineName: string | null;
    runningMark: React.ReactNode;
    idleMark: React.ReactNode;
    offlineMark: React.ReactNode;
}>): PaneHeaderLine {
    const machine = input.machineName;
    if (input.offline) {
        return {
            leading: input.offlineMark,
            segments: [machine ? t('localServices.pane.offlineOn', { machine }) : t('localServices.pane.offline')],
        };
    }
    if (input.runningCount > 0) {
        return {
            leading: input.runningMark,
            segments: [machine
                ? t('localServices.pane.runningOn', { count: input.runningCount, machine })
                : t('localServices.pane.running', { count: input.runningCount })],
        };
    }
    return {
        leading: input.idleMark,
        segments: [machine ? t('localServices.pane.nothingRunningOn', { machine }) : t('localServices.pane.nothingRunning')],
    };
}

/**
 * The this-workspace ⇄ this-machine scope control.
 *
 * `ServicesScopeToggle` was a hand-rolled pair of `Pressable`s that painted the SELECTED segment
 * with `surface.pressed` — the same token a press uses — so selected and pressed were the same
 * pixel, and there was no press feedback at all because the `Pressable` had no interaction-state
 * style. It also put `accessibilityRole="button"` children inside an `accessibilityRole="tablist"`
 * parent, which announces a tab list containing no tabs. Every one of those is already solved by
 * the canonical bar: a distinct `segmentedControl.activeBackground` with elevation, the spring
 * thumb gated at the motion chokepoint, roving focus, real `tab` roles and WCAG 2.5.8 sizing.
 */
function ServicesScopeBar(props: Readonly<{
    scope: ServicesScope;
    onChangeScope: (scope: ServicesScope) => void;
    page: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const tabs = React.useMemo(() => ([
        { id: 'workspace' as const, label: t('localServices.scope.workspace') },
        { id: 'machine' as const, label: t('localServices.scope.machine') },
    ]), []);
    return (
        <View style={[styles.scopeToggle, props.page ? styles.scopeTogglePage : null]}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={props.scope}
                onSelectTab={props.onChangeScope}
                accessibilityLabel={t('localServices.scope.toggleA11y')}
                testIDPrefix={props.testID}
                slidingThumb
            />
        </View>
    );
}

function DiagnosticsBanner(props: Readonly<{
    diagnostics: readonly unknown[];
    testID: string;
}>): React.ReactElement | null {
    const diagnostics = readLocalServiceDiagnostics(props.diagnostics);
    const styles = stylesheet;
    if (diagnostics.length === 0) {
        return null;
    }

    return (
        <View testID={props.testID} style={styles.offlineLine}>
            {diagnostics.map((diagnostic) => {
                // Scan diagnostics are scan-level facts, not per-service failures: the rows stay at
                // full strength under the canonical quiet line (the offline line's own primitive),
                // in the OWNER-COPY mapper's neutral words; the raw scan code stays on the
                // diagnostics-only testID — never in visible text.
                const copy = resolveReasonCopy({ reasonCode: diagnostic.code, kind: 'localServiceInventory' });
                return (
                    <SurfaceFreshnessLine
                        key={diagnostic.code}
                        testID={`${props.testID}-code-${diagnostic.code}`}
                        tone="warning"
                        reason={copy.body}
                    />
                );
            })}
        </View>
    );
}

function firstInventoryDiagnosticCopy(diagnostics: readonly unknown[]): ReturnType<typeof resolveReasonCopy> | null {
    const [diagnostic] = readLocalServiceDiagnostics(diagnostics);
    return diagnostic ? resolveReasonCopy({ reasonCode: diagnostic.code, kind: 'localServiceInventory' }) : null;
}

export function DetectedLocalServicesPane(props: Readonly<{
    inventoryState: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    sessionId?: string | null;
    scope?: ServicesScope;
    onChangeScope?: (scope: ServicesScope) => void;
    onStartLauncherTarget?: ServiceRowStartHandler;
    onClearLauncherHistory?: () => Promise<unknown>;
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onForgetDetectedService?: ServiceRowForgetHandler;
    onStopManagedService?: ServiceRowManagedControlHandler;
    onRestartManagedService?: ServiceRowManagedControlHandler;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    publicPreviewActions?: LocalServicePublicPreviewActions;
    /**
     * `page`: the Project Services page leads with its purpose in the reading column (lab s-services
     * PAGE). `pane` (default): the rail and Session panel, whose header slot carries the live line.
     * One body either way; only the chrome around it differs.
     */
    presentation?: 'pane' | 'page';
    /** The placement owner's per-row "Runs on" control, hosted in the row's expansion (plan 32). */
    renderServicePlacement?: (row: ServiceRow) => React.ReactNode;
    publicPreviewCapabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
    /** The machine these services run on: its name for the header and sections, and whether it answers. */
    machine?: MachinePresenceSummary | null;
    /**
     * Plugin surfaces placed in the Services panel. They scroll with the list: stacked beside the
     * pane's own scroll they took the whole height and squeezed the services out of view.
     */
    footer?: React.ReactNode;
    /**
     * User-initiated re-read. Freshness is normally pushed by the daemon inventory watch; this is
     * the explicit control and the recovery path when that watch is unavailable.
     */
    onRefresh?: () => void;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'detected-local-services-pane';
    const reducedMotion = useReducedMotionPreference();
    const animationEnabled = !reducedMotion;
    const scope: ServicesScope = props.scope ?? 'workspace';
    const viewModel = useLocalServiceInventory({ inventoryState: props.inventoryState });
    const styles = stylesheet;

    // The pane is ALWAYS driven by the controller's launcherState (the live host supplies
    // it). No inventory-derived fallback builder — that dead, churning path is removed.
    const launcherState = props.launcherState ?? createLocalServiceLauncherState();
    const launcherTargets = React.useMemo(
        () => selectLocalServiceLaunchTargets(launcherState),
        [launcherState],
    );
    const hasLauncherTargets = launcherTargets.length > 0;

    // Active session for D1 grouping: explicit prop wins, else the launcher feed's session.
    const activeSessionId = props.sessionId ?? launcherState.sessionId ?? null;

    // ONE ranked row model (keep-last-good: memoized on structural inputs only — never
    // folds nowMs/updatedAt into row identity, so unchanged rows keep referential identity).
    const rows = React.useMemo(
        () => buildLocalServiceRows({
            inventoryRows: viewModel.rows,
            launchTargets: launcherTargets,
            sessionId: activeSessionId,
            scope,
        }),
        [activeSessionId, launcherTargets, scope, viewModel.rows],
    );

    const sections = React.useMemo(() => groupLocalServiceRowsBySection(rows), [rows]);
    const runningCount = React.useMemo(() => selectLocalServiceRunningCount(rows), [rows]);
    const machineName = props.machine?.name ?? null;
    // Only a machine we know about and cannot reach is offline; an unknown one (a shared Session)
    // keeps today's behaviour rather than claiming an outage.
    const offline = props.machine?.reachability === 'unreachable';

    // One expanded row at a time (lab S signature). A row that leaves the list takes its expansion.
    const [expandedRowId, setExpandedRowId] = React.useState<string | null>(null);
    // Happier's own listeners: one quiet group, closed until the person asks.
    const [happierOpen, setHappierOpen] = React.useState(false);
    const expandedId = expandedRowId && rows.some((row) => row.id === expandedRowId) ? expandedRowId : null;

    const { theme } = useUnistyles();
    const runningMark = React.useMemo(() => (
        <ServiceStatusDot status="running" animationEnabled={false} testID={`${testID}-header-dot`} />
    ), [testID]);
    const idleMark = React.useMemo(() => (
        <Icon name="laptop" size={13} color={theme.colors.text.tertiary} />
    ), [theme.colors.text.tertiary]);
    const offlineMark = React.useMemo(() => (
        <ServiceStatusDot status="unavailable" animationEnabled={false} testID={`${testID}-header-offline-dot`} />
    ), [testID]);
    const headerLine = React.useMemo(() => buildHeaderLine({
        offline,
        runningCount,
        machineName,
        runningMark,
        idleMark,
        offlineMark,
    }), [idleMark, machineName, offline, offlineMark, runningCount, runningMark]);
    const onRefresh = props.onRefresh;
    const isRefreshing = viewModel.isRefreshing;
    const headerAction = React.useMemo(() => (onRefresh ? (
        <IconButton
            testID={`${testID}-refresh`}
            iconName="arrow-clockwise"
            accessibilityLabel={t('common.refresh')}
            tooltip={t('common.refresh')}
            variant="plain"
            minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
            disabled={isRefreshing}
            animationEnabled={animationEnabled}
            onPress={onRefresh}
        />
    ) : null), [animationEnabled, isRefreshing, onRefresh, testID]);
    usePaneHeaderSlotContent(React.useMemo(
        () => ({ line: headerLine, action: headerAction }),
        [headerAction, headerLine],
    ));

    const renderRow = React.useCallback((row: ServiceRow) => (
        <ServiceRowView
            key={row.id}
            row={row}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            onStartLauncherTarget={props.onStartLauncherTarget}
            onTerminateDetectedService={props.onTerminateDetectedService}
            onForgetDetectedService={props.onForgetDetectedService}
            onStopManagedService={props.onStopManagedService}
            onRestartManagedService={props.onRestartManagedService}
            onCopyServiceUrl={props.onCopyServiceUrl}
            machineName={machineName}
            offline={offline}
            placement={props.renderServicePlacement?.(row)}
            publicPreviewState={props.publicPreviewState}
            publicPreviewActions={props.publicPreviewActions}
            publicPreviewCapabilityDisabledReasons={props.publicPreviewCapabilityDisabledReasons}
            expanded={expandedId === row.id}
            onExpandedChange={(next) => setExpandedRowId(next ? row.id : null)}
            animationEnabled={animationEnabled}
            testID={`${testID}-row:${row.id}`}
        />
    ), [
        animationEnabled,
        expandedId,
        machineName,
        offline,
        props.onCopyServiceUrl,
        props.onForgetDetectedService,
        props.onRestartManagedService,
        props.onStopManagedService,
        props.renderServicePlacement,
        props.onOpenServiceInBrowser,
        props.onStartLauncherTarget,
        props.onTerminateDetectedService,
        props.publicPreviewActions,
        props.publicPreviewCapabilityDisabledReasons,
        props.publicPreviewState,
        testID,
    ]);

    const page = props.presentation === 'page';
    const deviceType = useDeviceType();
    const columnMaxWidth = useLayoutMaxWidth();
    // The phone page is titled by its cockpit header and leads straight into the list (lab PAGEp).
    const pageHeader = page && deviceType !== 'phone' ? (
        <HappierPageHeader
            title=""
            showTitle={false}
            columnMaxWidthPx={columnMaxWidth}
            renderText={renderPageHeaderText}
            description={t('localServices.pane.purpose')}
            testID={`${testID}-header`}
        />
    ) : null;

    // What the person can see or do: rows that are neither running nor startable are not shown.
    const hasRows = sections.length > 0;
    const checkAgain = onRefresh ? { label: t('localServices.pane.checkAgain'), onPress: onRefresh } : undefined;

    // A whole-pane state keeps the Services panel's plugin surfaces reachable below it.
    const withFooter = (state: React.ReactElement): React.ReactElement => (props.footer ? (
        <ScrollView style={styles.root} contentContainerStyle={styles.stateScrollContent}>
            {state}
            {props.footer}
        </ScrollView>
    ) : state);

    if (offline && !hasRows) {
        return withFooter(
            <SurfaceStateCard
                testID={`${testID}-offline`}
                kind="unavailable"
                iconName="cloud-slash"
                title={machineName ? t('localServices.pane.offlineOn', { machine: machineName }) : t('localServices.pane.offline')}
                reason={t('localServices.pane.offlineReason')}
                {...(checkAgain ? { action: checkAgain } : {})}
            />
        );
    }

    if (viewModel.status === 'loading' && !hasLauncherTargets) {
        return withFooter(
            <SurfaceStateCard
                testID={`${testID}-loading`}
                kind="loading"
                title={t('localServices.inventory.loadingTitle')}
                animationEnabled={animationEnabled}
            />
        );
    }

    if (viewModel.status === 'empty' && !hasLauncherTargets) {
        // Pane-states E: an empty pane that invites — what shows up here and why it is worth it.
        return withFooter(
            <SurfaceStateCard
                testID={`${testID}-empty`}
                kind="empty"
                iconName="globe"
                scene="nothingListening"
                title={t('localServices.pane.emptyTitle')}
                reason={t('localServices.pane.emptyReason')}
                {...(checkAgain ? { action: checkAgain } : {})}
            />
        );
    }

    if (viewModel.status === 'error' && !hasLauncherTargets) {
        const diagnosticCopy = firstInventoryDiagnosticCopy(viewModel.diagnostics);
        // G16: a failed first read used to be terminal. The card's own primary-action slot is the
        // retry, so the failure recovers through the same invalidation the refresh control uses.
        return withFooter(
            <SurfaceStateCard
                testID={`${testID}-error`}
                kind="error"
                title={t('localServices.inventory.errorTitle')}
                diagnosticCode={diagnosticCopy?.diagnosticCode}
                {...(onRefresh
                    ? { action: { label: t('common.retry'), onPress: onRefresh } }
                    : {})}
            />
        );
    }

    return (
        <ScrollView
            testID={testID}
            style={styles.root}
            contentContainerStyle={styles.scrollContent}
        >
            <ConstrainedScreenContent>
                {pageHeader}
                {offline ? (
                    <View style={styles.offlineLine}>
                        <SurfaceFreshnessLine
                            testID={`${testID}-offline-line`}
                            tone="warning"
                            reason={machineName ? t('localServices.pane.offlineOn', { machine: machineName }) : t('localServices.pane.offline')}
                            {...(checkAgain ? { action: checkAgain } : {})}
                        />
                    </View>
                ) : null}
                <DiagnosticsBanner diagnostics={viewModel.diagnostics} testID={`${testID}-error`} />
                {props.onChangeScope ? (
                    <ServicesScopeBar
                        scope={scope}
                        onChangeScope={props.onChangeScope}
                        page={page}
                        testID={`${testID}-scope-toggle`}
                    />
                ) : null}
                {hasRows
                    ? sections.map((entry) => (
                        <View key={entry.section} testID={`${testID}-section-${entry.section}`}>
                            {entry.section === 'happier' ? (
                                <ItemGroup selectableItemCountOverride={1}>
                                    <ExpandableItem
                                        expanded={happierOpen}
                                        onExpandedChange={setHappierOpen}
                                        header={({ headerProps }) => (
                                            <Item
                                                {...headerProps}
                                                testID={`${testID}-happier-item`}
                                                title={t('localServices.pane.happierServices', { count: entry.rows.length })}
                                            />
                                        )}
                                    >
                                        {entry.rows.map(renderRow)}
                                    </ExpandableItem>
                                </ItemGroup>
                            ) : (
                                <ItemGroup
                                    title={`${sectionTitle(entry.section, machineName)} ${entry.rows.length}`}
                                    surface="none"
                                    selectableItemCountOverride={entry.rows.length}
                                >
                                    {entry.rows.map(renderRow)}
                                </ItemGroup>
                            )}
                        </View>
                    ))
                    : rows.length > 0 ? (
                        // Only services with nothing to offer were found: the pane is empty (pane-states E).
                        <SurfaceStateCard
                            testID={`${testID}-empty`}
                            kind="empty"
                            iconName="globe"
                            scene="nothingListening"
                            title={t('localServices.pane.emptyTitle')}
                            reason={t('localServices.pane.emptyReason')}
                            {...(checkAgain ? { action: checkAgain } : {})}
                        />
                    ) : (
                        <SurfaceStateCard
                            testID={`${testID}-launcher-unavailable`}
                            kind="unavailable"
                            title={t('common.unavailable')}
                            reason={t('localServices.launcher.status.unavailableGeneric')}
                        />
                    )}
                {props.footer}
            </ConstrainedScreenContent>
        </ScrollView>
    );
}
