import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { HappierPageHeader } from '@happier-dev/plugin-ui/presentation';

import { usePaneHeaderSlotBinding, usePaneHeaderSlotContent, type PaneHeaderLine } from '@/components/appShell/panes/paneHeaderSlot';
import { useMachinePresenceSummary, type MachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { CheckoutUnreachableState, useCheckoutReachabilityPresentation, retryMachineReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { useRestoreFocusToTrigger, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { useProjectPageBack } from '@/components/projects/detail/projectPageBack';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { useDeviceType } from '@/utils/platform/responsive';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine, type SurfaceFreshnessAction } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { FeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { retryServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useLocalServiceInventory } from '@/sync/domains/local/services/inventory/useLocalServiceInventory';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import { createLocalServiceLauncherState, selectLocalServiceLaunchTargets } from '@/sync/domains/local/services/launch/store';
import type { LocalServiceLaunchTarget, LocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import { readLocalServiceDiagnostics } from '@/sync/domains/local/services/presentation';
import {
    buildLocalServiceRows,
    groupLocalServiceRowsBySection,
    type DescribeServiceDeclaration,
    selectRunningOpenTargetOnPort,
    type ServiceRow,
    type ServiceRowSection,
} from '@/sync/domains/local/services/serviceRow';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useLocalServicePublicPreviewStateController, type LocalServicePublicPreviewStatusClient } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { getStorage } from '@/sync/domains/state/storageStore';
import { ServerCredentialAccountScopeBindingProvider, useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
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

/** Each occurrence reads its actual Machine through the existing qualified owners. */
function TargetServiceRow(props: React.ComponentProps<typeof ServiceRowView> & Readonly<{
    sourceMachineId?: string | null;
    serverId?: string | null;
    sourceMachine?: MachinePresenceSummary | null;
    publicPreviewEnabled?: boolean;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
    /** A host that already holds the preview-access snapshot supplies it; rows otherwise read the shared store. */
    previewState?: LocalServicePreviewState;
}>): React.ReactElement {
    const { sourceMachineId, serverId, sourceMachine, publicPreviewEnabled, publicPreviewStatusClient, previewState, ...rowProps } = props;
    const target = props.row.target;
    const sourceRow = !sourceMachineId || target.machineId === sourceMachineId;
    const observedMachine = useMachinePresenceSummary(serverId, sourceRow ? null : target.machineId);
    const machine = sourceRow ? sourceMachine : observedMachine;
    const unavailableMachine = useMachinePresenceSummary(serverId, target.unavailableMachineId);
    // Explicit snapshots are scoped to their Machine; a Source snapshot never supplies worker policy.
    const suppliedState = props.publicPreviewState;
    const hasSuppliedState = suppliedState !== undefined && (suppliedState === null
        ? sourceRow : suppliedState.machineId === target.machineId);
    const preview = useLocalServicePublicPreviewStateController({
        machineId: target.machineId, serverId, sessionId: target.sessionId,
        enabled: publicPreviewEnabled === true && !hasSuppliedState,
        statusClient: publicPreviewStatusClient,
    });
    // The same keyed preview-access store the opener reads (one fetch per Machine, shared by every
    // reader): whether this device can open the row's private preview is that owner's answer.
    // Only a row that offers a private-preview Open needs that answer.
    const primary = props.row.primaryAction;
    const opensPreview = primary?.kind === 'open' && primary.openTarget.browserTarget?.kind === 'localServicePreview';
    const livePreviews = useLocalServicePreviewState({ machineId: target.machineId, serverId,
        enabled: opensPreview && previewState === undefined });
    const previews = previewState ?? livePreviews;
    return <ServiceRowView {...rowProps} previews={previews} machineName={machine?.name ?? null}
        unavailableMachineName={unavailableMachine.name}
        offline={machine?.reachability === 'unreachable'}
        publicPreviewState={hasSuppliedState ? suppliedState : publicPreviewEnabled ? preview.state : null} />;
}

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
    },
    /**
     * The pane's own scroll. It had none: the bands, the suggestion band and the public-preview
     * group were stacked in a `flex: 1` View inside an absolutely positioned panel, so on a short
     * viewport — or simply with enough services — everything below the fold was unreachable, and
     * the public-preview group is the LAST thing in the stack. No ancestor scrolls this axis
     * (`SessionRightPanel` mounts it inside a `RetainedPanelSurface` overlay), so this is the owner.
     */
    scrollContent: {
        paddingBottom: theme.space.s24,
    },
    /** A whole-pane state that still has plugin surfaces below it: the state keeps the pane's height. */
    stateScrollContent: {
        flexGrow: 1,
        paddingBottom: theme.space.s24,
    },
    scopeToggle: {
        marginHorizontal: theme.space.s16,
        marginBottom: theme.space.s8,
    },
    /** On the Services page the scope sits under the purpose at its own width, not across the column. */
    scopeTogglePage: {
        alignSelf: 'flex-start',
    },
    /** The phone page has no purpose line: the scope sits under the cockpit's checkout selector, with air of its own. */
    scopeTogglePhone: {
        marginTop: theme.space.s16,
    },
    offlineLine: {
        marginTop: theme.space.s4,
        // The scope toggle under the line keeps the air it keeps above the rows, so the band never touches it.
        marginBottom: theme.space.s8,
    },
    /** The list stays mounted under a pushed detail, so Back returns to the same scroll position. */
    listHidden: {
        display: 'none',
    },
    detailBar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s4,
    },
    /** A pending effect review discloses above what it decides (lab s-scripts Approval motion). */
    effectReview: {
        marginHorizontal: theme.space.s16,
        marginBottom: theme.space.s12,
    },
}));

/**
 * Who started each listed service, named by the account name owner from the profiles this client
 * already holds. The viewer's own services carry no byline, and an Account whose profile is not
 * known here gets none either: a name is never made from a bare id (R2a-F13).
 */
function useServiceStarterNames(rows: readonly ServiceRow[], viewerAccountId: string | null): Readonly<Record<string, string | null>> {
    const ids = React.useMemo(() => [...new Set(rows
        .map((row) => row.target.startedByAccountId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== viewerAccountId))].sort(),
    [rows, viewerAccountId]);
    return getStorage()(useShallow(React.useCallback((state: ReturnType<ReturnType<typeof getStorage>['getState']>) => {
        const names: Record<string, string | null> = {};
        for (const id of ids) {
            const user = state.users[id];
            names[id] = user ? formatAccountDisplayName(user) : null;
        }
        return names;
    }, [ids])));
}

function sectionTitle(section: ServiceRowSection, machineName: string | null): string {
    switch (section) {
        case 'running':
            return t('localServices.pane.sectionRunning');
        case 'failed':
            return t('localServices.pane.sectionFailed');
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
    /** The first scan is still running or failed: nothing is known about what runs, so the line says none of it. */
    scanUnknown: boolean;
    /** The rows' scope. An empty workspace says nothing about the rest of the machine. */
    scope: ServicesScope;
    runningCount: number;
    machineName: string | null;
    runningMark: React.ReactNode;
    idleMark: React.ReactNode;
    offlineMark: React.ReactNode;
    /** The Home offers Local services (`availability === 'available'`). */
    offered: boolean;
}>): PaneHeaderLine {
    const machine = input.machineName;
    // A Home that does not offer Local services lists nothing: the line keeps identity only, never a count.
    if (!input.offered) return { leading: input.idleMark, segments: machine ? [machine] : [] };
    if (input.offline) {
        return {
            leading: input.offlineMark,
            // The checkout owner or the pane body says the current state once; this line keeps identity only.
            segments: machine ? [machine] : [],
        };
    }
    if (input.runningCount > 0) {
        return {
            leading: input.runningMark,
            // A workspace view counts the workspace and says so; the Machine-wide count is the Machine's.
            segments: [input.scope === 'workspace'
                ? t('localServices.pane.runningInWorkspace', { count: input.runningCount })
                : machine
                    ? t('localServices.pane.runningOn', { count: input.runningCount, machine })
                    : t('localServices.pane.running', { count: input.runningCount })],
        };
    }
    if (input.scanUnknown) {
        return { leading: input.idleMark, segments: machine ? [machine] : [] };
    }
    return {
        leading: input.idleMark,
        segments: [input.scope === 'workspace'
            ? t('localServices.pane.nothingRunningInWorkspace')
            : machine ? t('localServices.pane.nothingRunningOn', { machine }) : t('localServices.pane.nothingRunning')],
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
    phone: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const tabs = React.useMemo(() => ([
        { id: 'workspace' as const, label: t('localServices.scope.workspace') },
        { id: 'machine' as const, label: t('localServices.scope.machine') },
    ]), []);
    return (
        <View style={[styles.scopeToggle, props.page ? styles.scopeTogglePage : null, props.page && props.phone ? styles.scopeTogglePhone : null]}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={props.scope}
                onSelectTab={props.onChangeScope}
                segmentSizing={props.page ? 'content' : 'equal'}
                accessibilityLabel={t('localServices.scope.toggleA11y')}
                testIDPrefix={props.testID}
            />
        </View>
    );
}

/** The one scan cause the pane names: a failed scan outranks a partial one; the rest stay on the marker. */
function leadInventoryDiagnostic(diagnostics: readonly unknown[]) {
    const read = readLocalServiceDiagnostics(diagnostics);
    return read.find((diagnostic) => diagnostic.severity === 'error') ?? read[0] ?? null;
}

function DiagnosticsBanner(props: Readonly<{
    diagnostics: readonly unknown[];
    homeDir?: string | null;
    testID: string;
    checkAgain?: SurfaceFreshnessAction;
}>): React.ReactElement | null {
    const copy = firstInventoryDiagnosticCopy(props.diagnostics, props.homeDir);
    if (!copy) return null;
    // A scan diagnostic is a scan-level fact, not a per-service failure: the rows stay at full strength
    // under one quiet line in the OWNER-COPY mapper's words, with the existing refresh as its recovery.
    // The raw code stays on the diagnostics-only testID, never in visible text.
    return (
        <View testID={props.testID} style={stylesheet.offlineLine}>
            <SurfaceFreshnessLine
                testID={`${props.testID}-code-${copy.diagnosticCode}`}
                tone="warning"
                reason={copy.body}
                {...(props.checkAgain ? { action: { ...props.checkAgain, testID: `${props.testID}-check-again` } } : {})}
            />
        </View>
    );
}

function firstInventoryDiagnosticCopy(diagnostics: readonly unknown[], homeDir?: string | null): ReturnType<typeof resolveReasonCopy> | null {
    const diagnostic = leadInventoryDiagnostic(diagnostics);
    return diagnostic ? resolveReasonCopy({
        reasonCode: diagnostic.code, kind: 'localServiceInventory',
        inventoryObservation: diagnostic.observation ? {
            ...diagnostic.observation,
            root: diagnostic.observation.root ? formatPathRelativeToHome(diagnostic.observation.root, homeDir) : null,
        } : undefined,
    }) : null;
}

type DetectedLocalServicesPaneProps = Readonly<{
    inventoryState: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    /** One line under the scope bar about the selected workspace (its own ports), from the host that knows it. */
    scopeNote?: React.ReactNode;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    /** The preview-access snapshot, when the host already holds it (a specimen); rows read the shared store otherwise. */
    previewState?: LocalServicePreviewState;
    sourceMachineId?: string | null;
    serverId?: string | null;
    publicPreviewEnabled?: boolean;
    publicPreviewStatusClient?: LocalServicePublicPreviewStatusClient;
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
    onShowServiceTerminal?: (target: LocalServiceLaunchTarget) => Promise<unknown>;
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
    /** The Project definition's command and source file for a declared service (the feed carries only a literal command). */
    describeDeclaration?: DescribeServiceDeclaration;
    /** A Start/Restart waiting on the person's review of its current effect, drawn by the host. */
    effectReview?: React.ReactNode;
    /** The Account viewing the surface: its own services carry no "Started by". */
    viewerAccountId?: string | null;
    publicPreviewCapabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
    /**
     * The Home's Local services availability (`useLocalServicePresentationFeatures().localServicesArm`).
     * Anything but `available` replaces the list with its own state: off, not offered, or not yet known.
     */
    availability?: FeatureAvailabilityArm;
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
    /**
     * Where a service is declared (the Project's Scripts page). Only surfaces that have one pass it;
     * the empty state then offers it next to the re-read instead of leaving Retry as the only move.
     */
    onAddService?: () => void;
    testID?: string;
}>;

/**
 * The pane resolves its Home's credential once and lends it to every Service row below, so a row's
 * Machine presence and preview reads never resolve the same Home again (a Project page has no
 * destination scope above the pane; a Session's scope is inherited unchanged).
 */
export function DetectedLocalServicesPane(props: DetectedLocalServicesPaneProps): React.ReactElement {
    const credentialScope = useServerCredentialAccountScopeBinding(props.serverId);
    return (
        <ServerCredentialAccountScopeBindingProvider serverId={props.serverId ?? null} state={credentialScope}>
            <DetectedLocalServicesPaneBody {...props} />
        </ServerCredentialAccountScopeBindingProvider>
    );
}

function DetectedLocalServicesPaneBody(props: DetectedLocalServicesPaneProps): React.ReactElement {
    const testID = props.testID ?? 'detected-local-services-pane';
    const preferredLanguage = usePreferredLanguage();
    const reducedMotion = useReducedMotionPreference();
    const animationEnabled = !reducedMotion;
    const scope: ServicesScope = props.scope ?? 'workspace';
    const viewModel = useLocalServiceInventory({ inventoryState: props.inventoryState });
    const styles = stylesheet;

    // The pane is ALWAYS driven by the controller's launcherState (the live host supplies
    // it). No inventory-derived fallback builder — that dead, churning path is removed.
    const launcherState = props.launcherState ?? createLocalServiceLauncherState();
    const launcherTargets = selectLocalServiceLaunchTargets(launcherState);
    const hasLauncherTargets = launcherTargets.length > 0;

    // Active session for D1 grouping: explicit prop wins, else the launcher feed's session.
    const activeSessionId = props.sessionId ?? launcherState.sessionId ?? null;

    // ONE ranked row model (keep-last-good: memoized on structural inputs only — never
    // folds nowMs/updatedAt into row identity, so unchanged rows keep referential identity).
    const rows = React.useMemo(
        () => buildLocalServiceRows({
            inventoryRows: viewModel.rows,
            launchTargets: launcherTargets,
            rowIdsByTargetId: launcherState.rowIdsByTargetId,
            sessionId: activeSessionId,
            scope,
            describeDeclaration: props.describeDeclaration,
        }),
        [activeSessionId, launcherTargets, launcherState.rowIdsByTargetId, scope, viewModel.rows, props.describeDeclaration],
    );

    const sections = React.useMemo(() => groupLocalServiceRowsBySection(rows), [rows]);
    const findRunningOpenTarget = React.useCallback(
        (port: number, failedTarget: LocalServiceLaunchTarget) => selectRunningOpenTargetOnPort(rows, port, failedTarget),
        [rows],
    );
    // The header counts what the groups below list as live (Running, and Elsewhere on a machine view), so the
    // line never says "nothing running" over a Running group, nor "1 running" over a row that is still starting.
    const runningCount = React.useMemo(() => sections
        .filter((entry) => entry.section === 'running' || entry.section === 'elsewhere')
        .reduce((count, entry) => count + entry.rows.length, 0), [sections]);
    const machineName = props.machine?.name ?? null;
    // Only a machine we know about and cannot reach is offline; an unknown one (a shared Session)
    // keeps today's behaviour rather than claiming an outage.
    const machineScope = props.serverId && props.sourceMachineId ? { serverId: props.serverId, machineId: props.sourceMachineId } : null;
    const reachability = useCheckoutReachabilityPresentation(machineScope,
        props.machine ?? { name: null, homeDir: null, reachability: 'unknown' });
    const offline = reachability.unreachable;

    // One selected Service, presented inline on wide layouts or as a pushed detail on phones.
    // Responsive changes and native placement handoffs do not change the person's selection.
    const [expandedRowId, setExpandedRowId] = React.useState<string | null>(null);
    const phone = useDeviceType() === 'phone';
    const detailRow = phone && expandedRowId ? rows.find((row) => row.id === expandedRowId) ?? null : null;
    const rowFocusTargets = React.useRef(new Map<string, FocusReturnTarget>());
    const returnFocusTarget = React.useRef<FocusReturnTarget>(null);
    const focusReturnPending = React.useRef(false);
    const restoreFocus = useRestoreFocusToTrigger(returnFocusTarget);
    const closeDetail = React.useCallback(() => {
        focusReturnPending.current = true;
        setExpandedRowId(null);
    }, []);
    React.useLayoutEffect(() => {
        if (!detailRow && focusReturnPending.current) {
            focusReturnPending.current = false;
            restoreFocus();
            returnFocusTarget.current = null;
        }
    }, [detailRow, restoreFocus]);
    useNativeBackLayerBackHandler(Boolean(detailRow), React.useCallback(() => { closeDetail(); return true; }, [closeDetail]));
    // Inside a Project the phone bar's own Back closes the detail; a pane with no such host draws its own arrow.
    const backHostedByBar = useProjectPageBack(Boolean(detailRow), closeDetail);
    // Under a pane header (the Session cockpit) the header's line is the way back, so no arrow row of its own.
    const underPaneHeader = usePaneHeaderSlotBinding() !== null;
    const backOnHeader = Boolean(detailRow) && !backHostedByBar && underPaneHeader;
    const starterNames = useServiceStarterNames(rows, props.viewerAccountId ?? null);
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
    // Inventory completion does not settle the launcher projection that owns these rows.
    // Its initial idle frame is unknown too; only an admitted snapshot proves emptiness.
    // One decision for the header and the body: neither says "nothing running" while the other still scans.
    const launcherPending = props.launcherState != null && launcherState.updatedAt === null
        && launcherState.refreshStatus !== 'error';
    const scanPending = (viewModel.status === 'loading' || launcherPending) && !hasLauncherTargets;
    const availability = props.availability ?? 'available';
    const offered = availability === 'available';
    const scanUnknown = scanPending || ((viewModel.status === 'error' || launcherState.refreshStatus === 'error') && !hasLauncherTargets);
    const headerLine = React.useMemo(() => buildHeaderLine({
        offered,
        offline,
        scanUnknown,
        scope,
        runningCount,
        machineName,
        runningMark,
        idleMark,
        offlineMark,
    }), [idleMark, machineName, offered, offline, offlineMark, runningCount, runningMark, scanUnknown, scope]);
    // Nothing to re-read while the Home does not offer Local services.
    const onRefresh = offered ? props.onRefresh : undefined;
    const isRefreshing = viewModel.isRefreshing;
    const headerAction = React.useMemo(() => (onRefresh ? (
        <IconButton
            testID={`${testID}-refresh`}
            iconName="arrow-clockwise"
            accessibilityLabel={t('common.refresh')}
            tooltip={t('common.refresh')}
            variant="plain"
            disabled={isRefreshing}
            animationEnabled={animationEnabled}
            onPress={onRefresh}
        />
    ) : null), [animationEnabled, isRefreshing, onRefresh, testID]);
    const backLine = React.useMemo((): PaneHeaderLine => ({
        segments: [{
            text: t('localServices.pane.backToServices'),
            icon: 'arrow-left',
            onPress: closeDetail,
            testID: `${testID}-header-back`,
        }],
    }), [closeDetail, testID]);
    usePaneHeaderSlotContent(React.useMemo(
        () => ({ line: backOnHeader ? backLine : headerLine, action: headerAction }),
        [backLine, backOnHeader, headerAction, headerLine],
    ));

    // The ports owner's answer for this checkout: its services take their ports when they start.
    const portsAssignedAtStart = launcherState.worktreePorts?.result.kind === 'ready';
    const renderRow = React.useCallback((row: ServiceRow) => (
        <TargetServiceRow
            key={row.id}
            row={row}
            portsAssignedAtStart={portsAssignedAtStart}
            // Rows breathe on their own padding, as the lab draws them: no hairline between or after them.
            showDivider={false}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            onStartLauncherTarget={props.onStartLauncherTarget}
            findRunningOpenTarget={findRunningOpenTarget}
            onTerminateDetectedService={props.onTerminateDetectedService}
            onForgetDetectedService={props.onForgetDetectedService}
            onStopManagedService={props.onStopManagedService}
            onRestartManagedService={props.onRestartManagedService}
            onCopyServiceUrl={props.onCopyServiceUrl}
            onShowServiceTerminal={props.onShowServiceTerminal}
            sourceMachineId={props.sourceMachineId}
            serverId={props.serverId}
            sourceMachine={props.machine}
            publicPreviewEnabled={props.publicPreviewEnabled}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            pressableRef={(target) => {
                if (target) rowFocusTargets.current.set(row.id, target);
                else rowFocusTargets.current.delete(row.id);
            }}
            startedByName={row.target.startedByAccountId ? starterNames[row.target.startedByAccountId] ?? null : null}
            placement={props.renderServicePlacement?.(row)}
            publicPreviewState={props.publicPreviewState}
            previewState={props.previewState}
            publicPreviewActions={props.publicPreviewActions}
            publicPreviewCapabilityDisabledReasons={props.publicPreviewCapabilityDisabledReasons}
            expanded={!phone && expandedId === row.id}
            onExpandedChange={(next) => setExpandedRowId(next ? row.id : null)}
            onOpenDetail={phone ? () => {
                returnFocusTarget.current = rowFocusTargets.current.get(row.id) ?? null;
                setExpandedRowId(row.id);
            } : undefined}
            animationEnabled={animationEnabled}
            testID={`${testID}-row:${row.id}`}
        />
    ), [
        animationEnabled,
        expandedId,
        findRunningOpenTarget,
        portsAssignedAtStart,
        props.sourceMachineId,
        props.serverId,
        props.machine,
        props.publicPreviewEnabled,
        props.publicPreviewStatusClient,
        phone,
        starterNames,
        props.onCopyServiceUrl,
        props.onShowServiceTerminal,
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
        props.previewState,
        testID,
    ]);

    // The inventory still publishes its scan cursor. Its material row projection is stable,
    // so that observation must not re-enter every Service row (including expanded controls).
    const renderedRowsBySection = React.useMemo(() => sections.map(entry => entry.rows.map(renderRow)), [sections, renderRow, preferredLanguage]);
    // The pushed detail owns its scroll (its primary can pin below it); the back bar and a pending
    // review lead its page.
    const detailEffectReview = props.effectReview;
    const detailOpen = detailRow !== null;
    const detailLead = React.useMemo(() => detailOpen ? (
        <>
            {backHostedByBar || backOnHeader ? null : (
                <View style={styles.detailBar}>
                    <IconButton
                        testID={`${testID}-detail-back`}
                        iconName="arrow-left"
                        variant="plain"
                        accessibilityLabel={t('localServices.pane.backToServices')}
                        tooltip={t('localServices.pane.backToServices')}
                        animationEnabled={animationEnabled}
                        onPress={closeDetail}
                    />
                </View>
            )}
            {detailEffectReview ? <View style={styles.effectReview}>{detailEffectReview}</View> : null}
        </>
    ) : null, [animationEnabled, backHostedByBar, backOnHeader, closeDetail, detailEffectReview, detailOpen, testID]);
    const renderedDetailRow = React.useMemo(() => detailRow ? (
        <TargetServiceRow
            row={detailRow}
            presentation="detail"
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            onStartLauncherTarget={props.onStartLauncherTarget}
            findRunningOpenTarget={findRunningOpenTarget}
            onTerminateDetectedService={props.onTerminateDetectedService}
            onForgetDetectedService={props.onForgetDetectedService}
            onStopManagedService={props.onStopManagedService}
            onRestartManagedService={props.onRestartManagedService}
            onCopyServiceUrl={props.onCopyServiceUrl}
            onShowServiceTerminal={props.onShowServiceTerminal}
            sourceMachineId={props.sourceMachineId}
            serverId={props.serverId}
            sourceMachine={props.machine}
            publicPreviewEnabled={props.publicPreviewEnabled}
            publicPreviewStatusClient={props.publicPreviewStatusClient}
            startedByName={detailRow.target.startedByAccountId ? starterNames[detailRow.target.startedByAccountId] ?? null : null}
            placement={props.renderServicePlacement?.(detailRow)}
            publicPreviewState={props.publicPreviewState}
            previewState={props.previewState}
            publicPreviewActions={props.publicPreviewActions}
            publicPreviewCapabilityDisabledReasons={props.publicPreviewCapabilityDisabledReasons}
            animationEnabled={animationEnabled}
            detailLead={detailLead}
            testID={`${testID}-detail-row`}
        />
    ) : null, [detailRow, detailLead, animationEnabled, findRunningOpenTarget, starterNames, testID, preferredLanguage,
        props.onOpenServiceInBrowser, props.onStartLauncherTarget, props.onTerminateDetectedService,
        props.onForgetDetectedService, props.onStopManagedService, props.onRestartManagedService,
        props.onCopyServiceUrl, props.onShowServiceTerminal, props.sourceMachineId, props.serverId, props.machine,
        props.publicPreviewEnabled, props.publicPreviewStatusClient, props.renderServicePlacement,
        props.publicPreviewState, props.previewState, props.publicPreviewActions, props.publicPreviewCapabilityDisabledReasons]);

    const page = props.presentation === 'page';
    const columnMaxWidth = useLayoutMaxWidth();
    // The phone page is titled by its cockpit header and leads straight into the list (lab PAGEp).
    const pageHeader = page && !phone ? (
        <HappierPageHeader
            title=""
            showTitle={false}
            columnMaxWidthPx={columnMaxWidth}
            renderText={renderPageHeaderText}
            description={scope === 'machine' ? t('localServices.pane.purposeMachine') : t('localServices.pane.purpose')}
            testID={`${testID}-header`}
        />
    ) : null;

    // What the person can see or do: rows that are neither running nor startable are not shown.
    const hasRows = sections.length > 0;
    const checkAgain = onRefresh ? { label: t('localServices.pane.checkAgain'), onPress: onRefresh } : undefined;
    // One empty state for "nothing to show" however it is reached. Adding a service leads; re-reading is the quiet second move.
    const addService = props.onAddService ? { label: t('localServices.pane.addService'), onPress: props.onAddService } : undefined;
    const emptyCard = (
        <SurfaceStateCard
            testID={`${testID}-empty`}
            kind="empty"
            iconName="globe"
            scene="nothingListening"
            title={t('localServices.pane.emptyTitle')}
            reason={scope === 'machine' ? t('localServices.pane.emptyReasonMachine') : t('localServices.pane.emptyReason')}
            {...(addService
                ? { action: addService, ...(checkAgain ? { secondaryAction: checkAgain } : {}) }
                : checkAgain ? { action: checkAgain } : {})}
        />
    );

    const scopeBar = props.onChangeScope ? (
        <ServicesScopeBar
            scope={scope}
            onChangeScope={props.onChangeScope}
            page={page}
            phone={phone}
            testID={`${testID}-scope-toggle`}
        />
    ) : null;
    // A whole-pane state stands in for the rows only: the page's purpose and the scope stay above it
    // (a Machine-scope scan can take minutes, and the person must be able to switch back), and the
    // Services panel's plugin surfaces stay reachable below it.
    // A Machine out of reach is the exception: nothing below can run or load until Try again succeeds, and the
    // card already names the Machine, so the plugin surfaces stay out rather than repeat "offline" in their words.
    const withFooter = (state: React.ReactElement, footer: React.ReactNode = props.footer): React.ReactElement => (footer || pageHeader || scopeBar ? (
        <ScrollView style={styles.root} contentContainerStyle={styles.stateScrollContent}>
            {pageHeader || scopeBar ? (
                <ConstrainedScreenContent>
                    {pageHeader}
                    {scopeBar}
                </ConstrainedScreenContent>
            ) : null}
            {state}
            {footer}
        </ScrollView>
    ) : state);

    if (availability !== 'available') {
        // Nothing is scanned while the Home does not offer Local services: the state says why, never an
        // empty list. The scope switch has nothing to switch. A Home that turned them off leaves the Services
        // panel's plugin surfaces nothing to run on or read, so they stay out; while the decision is still
        // being checked (or could not be), they stay below the state as on any other whole-pane state.
        const state = <LocalServicesAvailabilityState availability={availability} serverId={props.serverId ?? null}
            animationEnabled={animationEnabled} testID={testID} />;
        const footer = availability === 'checking' || availability === 'unknown' ? props.footer : null;
        return footer || pageHeader ? (
            <ScrollView style={styles.root} contentContainerStyle={styles.stateScrollContent}>
                {pageHeader ? <ConstrainedScreenContent>{pageHeader}</ConstrainedScreenContent> : null}
                {state}
                {footer}
            </ScrollView>
        ) : state;
    }

    if (offline && !hasRows) {
        return withFooter(
            <ConstrainedScreenContent>
                <CheckoutUnreachableState reachability={reachability}
                    testID={`${testID}-${reachability.announced ? 'waiting' : 'offline'}`} />
            </ConstrainedScreenContent>,
            null,
        );
    }

    if (scanPending) {
        return withFooter(
            <SurfaceStateCard
                testID={`${testID}-loading`}
                kind="loading"
                title={t('localServices.inventory.loadingTitle')}
                animationEnabled={animationEnabled}
            />
        );
    }

    if ((viewModel.status === 'empty' || viewModel.status === 'unavailable'
        && launcherState.updatedAt !== null && launcherState.refreshStatus === 'idle')
        && launcherState.refreshStatus !== 'error' && !hasLauncherTargets) {
        // Pane-states E: an empty pane that invites — what shows up here and why it is worth it.
        return withFooter(emptyCard);
    }

    if ((viewModel.status === 'error' || viewModel.status === 'unavailable' || launcherState.refreshStatus === 'error') && !hasLauncherTargets) {
        const diagnosticCopy = launcherState.refreshError
            ? resolveReasonCopy({ reasonCode: launcherState.refreshError, kind: 'localServiceLauncher' })
            : firstInventoryDiagnosticCopy(viewModel.diagnostics, props.machine?.homeDir);
        // G16: a failed first read used to be terminal. The card's own primary-action slot is the
        // retry, so the failure recovers through the same invalidation the refresh control uses.
        return withFooter(
            <SurfaceStateCard
                testID={`${testID}-error`}
                kind="error"
                title={t('localServices.inventory.errorTitle')}
                {...(diagnosticCopy && diagnosticCopy.body !== diagnosticCopy.title ? { reason: diagnosticCopy.body } : {})}
                diagnosticCode={diagnosticCopy?.diagnosticCode}
                {...(onRefresh
                    ? { action: { label: t('common.retry'), onPress: onRefresh } }
                    : {})}
            />
        );
    }

    const effectReview = props.effectReview ? <View style={styles.effectReview}>{props.effectReview}</View> : null;
    return (
        <View style={styles.root}>
            <View
                testID={`${testID}-list`}
                accessibilityElementsHidden={detailRow !== null}
                importantForAccessibility={detailRow ? 'no-hide-descendants' : 'auto'}
                style={[styles.root, detailRow ? styles.listHidden : null]}
            >
                <ScrollView
                    testID={testID}
                    style={styles.root}
                    contentContainerStyle={styles.scrollContent}
                >
                    <ConstrainedScreenContent>
                        {pageHeader}
                        {offline && !reachability.announced ? (
                            <View style={styles.offlineLine}>
                                <SurfaceFreshnessLine
                                    testID={`${testID}-offline-line`}
                                    tone="warning"
                                    reason={reachability.runtime.label}
                                    action={reachability.runtime.nextAction === 'retry'
                                        ? { label: t('common.retry'), onPress: retryMachineReachability } : undefined}
                                />
                            </View>
                        ) : null}
                        {/* The scope control stays put when switching: a scan diagnostic belongs to the selected scope, so it sits under it. */}
                        {scopeBar}
                        {scope === 'workspace' ? props.scopeNote : null}
                        <DiagnosticsBanner diagnostics={viewModel.diagnostics} homeDir={props.machine?.homeDir} testID={`${testID}-error`} checkAgain={checkAgain} />
                        {detailRow ? null : effectReview}
                        {hasRows
                            ? sections.map((entry, index) => (
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
                                                {renderedRowsBySection[index]}
                                            </ExpandableItem>
                                        </ItemGroup>
                                    ) : (
                                        <>
                                            {/* What the rows share and how many: the list's quiet group label
                                                (lab s-services), not a page section title. */}
                                            <CollectionListGroupLabel
                                                testID={`${testID}-section-${entry.section}-label`}
                                                title={sectionTitle(entry.section, machineName)}
                                                count={entry.rows.length}
                                                first={index === 0}
                                            />
                                            <ItemGroup
                                                header="none"
                                                accessibilityLabel={sectionTitle(entry.section, machineName)}
                                                surface="none"
                                                selectableItemCountOverride={entry.rows.length}
                                            >
                                                {renderedRowsBySection[index]}
                                            </ItemGroup>
                                        </>
                                    )}
                                </View>
                            ))
                            : emptyCard}
                        {props.footer}
                    </ConstrainedScreenContent>
                </ScrollView>
            </View>
            {detailRow ? (
                <View testID={`${testID}-detail`} style={styles.root}>
                    {renderedDetailRow}
                </View>
            ) : null}
        </View>
    );
}

/**
 * Why a Home's Local services cannot be listed, from the canonical availability arm (the Automations
 * gate's pattern). A Home that turned them off says who can change it and offers nothing that cannot
 * work; a Home that could not be checked asks its feature probe again and claims nothing about why.
 */
function LocalServicesAvailabilityState(props: Readonly<{
    availability: Exclude<FeatureAvailabilityArm, 'available'>;
    serverId: string | null;
    animationEnabled: boolean;
    testID: string;
}>): React.ReactElement {
    const serverId = props.serverId;
    const checkAgain = React.useCallback(async () => {
        if (serverId) await retryServerFeaturesSnapshot({ serverId });
    }, [serverId]);
    switch (props.availability) {
        case 'checking':
            return (
                <SurfaceStateCard testID={`${props.testID}-loading`} kind="loading"
                    title={t('localServices.inventory.loadingTitle')} animationEnabled={props.animationEnabled} />
            );
        case 'unknown':
            return (
                <SurfaceStateCard testID={`${props.testID}-availability-unknown`} kind="error" iconName="hard-drives"
                    title={t('localServices.pane.availabilityUnknownTitle')}
                    reason={t('localServices.pane.availabilityUnknownReason')}
                    {...(serverId ? { action: { label: t('localServices.pane.checkAgain'), onPress: checkAgain } } : {})}
                    accessibilitySemantics="status" />
            );
        case 'server_disabled':
            return (
                <SurfaceStateCard testID={`${props.testID}-off`} kind="unavailable" iconName="hard-drives"
                    title={t('localServices.pane.offTitle')} reason={t('localServices.pane.offReason')}
                    accessibilitySemantics="status" />
            );
        default:
            return (
                <SurfaceStateCard testID={`${props.testID}-not-offered`} kind="unavailable" iconName="hard-drives"
                    title={t('localServices.pane.notOfferedTitle')} reason={t('localServices.pane.notOfferedReason')}
                    accessibilitySemantics="status" />
            );
    }
}
