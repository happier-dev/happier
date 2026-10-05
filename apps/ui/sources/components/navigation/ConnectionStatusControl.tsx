import * as React from 'react';
import { useUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';
import { Platform, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t, type TranslationKeyNoParams } from '@/text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Popover } from '@/components/ui/popover';
import { readPressFocusReturnTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useSocketStatus, useSyncError, useLastSyncAt } from '@/sync/domains/state/storage';
import { useHomeViewSelectionSettingsMutable } from '@/hooks/server/useHomeViewSelectionSettings';
import { useAuth } from '@/auth/context/AuthContext';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { usePathname, useRouter } from 'expo-router';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { offerThisComputerConnectionToHome } from '@/components/serverProfiles/offerThisComputerConnectionToHome';
import { Typography } from '@/constants/Typography';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { listServerSelectionTargets } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { normalizeStoredServerSelectionGroups } from '@/sync/domains/server/selection/serverSelectionMutations';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { Text } from '@/components/ui/text/Text';
import { useActiveHomeConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { resolveMachineConnectionSummary } from '@/components/navigation/connectionStatus/resolveMachineConnectionSummary';
import {
    getAppliedActiveServerId,
    retryActiveServerConnection,
    subscribeAppliedActiveServer,
} from '@/sync/runtime/orchestration/connectionManager';
import { resolveSocketErrorClassification } from '@/sync/runtime/connectivity/resolveSocketErrorClassification';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerHomeCarrier,
    getServerProfileById,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { AccountPopoverContent, type AccountPopoverStep } from '@/components/navigation/accountPopover/AccountPopoverContent';
import {
    useHomeAccountServiceSummary,
    type HomeAccountServiceSummary,
} from '@/components/account/auth/useHomeAccountServiceEntry';
import { ConnectionPopoverMachineGuidance } from '@/components/navigation/connectionStatus/ConnectionPopoverMachineGuidance';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import {
    readIrohHomeTransportDiagnostics,
    readIrohHomeTransportDiagnosticsRevision,
    subscribeIrohHomeTransportDiagnostics,
} from '@/sync/runtime/irohHomeTransportDiagnostics';
import { formatIrohRelayConfiguration } from '@/components/navigation/connectionStatus/formatIrohRelayConfiguration';
import {
    projectIrohHomeTransportPresentation,
    type IrohHomeTransportPresentation,
} from '@/components/navigation/connectionStatus/projectIrohHomeTransportPresentation';
import {
    resolveHomeConnectionSummary,
    type HomeConnectionStatusKey,
} from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { resolveMachineConnectionStatusKey } from '@/components/navigation/connectionStatus/connectionHealthPresentation';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import {
    sanitizeDoctorDiagnosticText,
    type DoctorSnapshotHomeTransportDiagnostics,
} from '@happier-dev/protocol';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { HOMES_ADD_ROUTE } from '@/components/settings/server/collection/homeCollectionModel';
import { buildHomeRecoveryHref } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

/**
 * `sidebar`: a host-placed trigger opens the account/Home popover. `header` (phones): the trigger opens
 * the Account & Homes page, which renders `page` (the same content, inline). `fullScreen`: the Home's
 * connection facts on the Homes page.
 */
type Variant = 'sidebar' | 'header' | 'page' | 'fullScreen';
const ACCOUNT_HOMES_ROUTE = '/homes';
const RELAY_SETTINGS_ROUTE = '/settings/server';
const DENSE_POINTER_TARGET_SIZE = 24;
const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
/** A1 · Identity & Homes is drawn 300 wide, and keeps that width on its steps (long values wrap). */
const ACCOUNT_POPOVER_WIDTH = 300;
/** The header status line's text line (its `statusText` line height). */
const HEADER_STATUS_LINE_HEIGHT = 16;

type ConnectionStatusKey = 'connected' | 'connecting' | 'disconnected' | 'error' | 'action_required' | 'unknown';

function resolveConnectionStatusPillVariant(status: ConnectionStatusKey): StatusPillVariant {
    switch (status) {
        case 'connected':
            return 'success';
        case 'connecting':
            return 'info';
        case 'action_required':
            return 'warning';
        case 'error':
            return 'danger';
        case 'disconnected':
        case 'unknown':
            return 'neutral';
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 2000,
        overflow: 'visible',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
        flexWrap: 'nowrap' as const,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'visible',
    },
    headerStatusContainer: {
        // A full 44px target, laid out as one 16px text line: the frame reaches into the header's
        // padding above and below so the tab title and this line fit the phone header together.
        minHeight: minimumInteractiveTargetSize,
        marginTop: -(minimumInteractiveTargetSize - HEADER_STATUS_LINE_HEIGHT) / 2,
        marginBottom: -(minimumInteractiveTargetSize - HEADER_STATUS_LINE_HEIGHT) / 2,
    },
    sidebarStatusContainer: {
        // Keep the 0.2 line-box geometry while giving React Native Web a real
        // pointer frame. Pressable does not implement hitSlop on web.
        minHeight: DENSE_POINTER_TARGET_SIZE,
        marginTop: -6,
        marginBottom: -4,
    },
    statusText: {
        lineHeight: 16,
        ...Typography.default(),
        flexGrow: 0,
        flexShrink: 1,
        minWidth: 0,
    },
    statusChevron: {
        marginLeft: 2,
        marginTop: 1,
        opacity: 0.9,
    },
    // The surface's share of the menu rhythm (`MENU_ROW_METRICS`): one inset above and below the
    // sections, which add their own; the full-screen surface keeps the same measure.
    popoverContent: {
        paddingVertical: MENU_ROW_METRICS.sectionPaddingVerticalPx,
    },
    popoverStatusList: {
        marginHorizontal: 12,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        overflow: 'hidden',
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 54,
        paddingVertical: 9,
        paddingHorizontal: 12,
        position: 'relative',
    },
    statusRowDivider: {
        position: 'absolute',
        top: 0,
        left: 44,
        right: 12,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border.default,
    },
    statusRowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flexShrink: 1,
        minWidth: 0,
    },
    statusRowIcon: {
        width: 22,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusRowText: {
        flexShrink: 1,
        minWidth: 0,
    },
    statusRowTitle: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        lineHeight: 17,
    },
    statusRowSubtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        lineHeight: 16,
        marginTop: 1,
    },
    statusRowRight: {
        marginLeft: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    statusRowRetryButton: {
        minWidth: minimumInteractiveTargetSize,
        minHeight: minimumInteractiveTargetSize,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    popoverStatusPill: {
        flexShrink: 0,
    },
    statusMeta: {
        paddingHorizontal: 16,
        paddingTop: 10,
        gap: 6,
    },
    statusMetaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
        alignItems: 'flex-start',
    },
    statusMetaLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    statusMetaValue: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    technicalDetails: {
        marginHorizontal: 12,
        marginTop: 4,
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 8,
    },
    technicalDetailsTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    technicalDetailsValue: {
        fontSize: 11,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        ...Typography.mono(),
    },
    popoverActionsRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    popoverActionButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: theme.colors.background.canvas,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        minHeight: minimumInteractiveTargetSize,
        justifyContent: 'center',
    },
    popoverActionButtonText: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    detailsDisclosure: {
        minHeight: minimumInteractiveTargetSize,
        marginHorizontal: 12,
        marginTop: 6,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    copyDiagnosticsButton: {
        minHeight: minimumInteractiveTargetSize,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    detailsDisclosureText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
}));

function formatTime(ts: number | null): string {
    if (!ts) return '—';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '—';
    }
}

type TransportDetailRow = Readonly<{ key: string; label: string; value: string }>;

/**
 * Advanced transport facts, presented as labeled rows rather than a raw JSON
 * dump so support and expert users can read, translate, and scan them. The
 * exact same rows compose the copyable report; there is no second formatter.
 */
function buildTransportDetailRows(params: Readonly<{
    homeServerIdentityId: string | null;
    canonicalServerUrl: string;
    publicServerUrl: string | null | undefined;
    runtimeOrigin: string | null;
    diagnostics: DoctorSnapshotHomeTransportDiagnostics | null;
    transportPresentation: IrohHomeTransportPresentation;
}>): readonly TransportDetailRow[] {
    const rows: TransportDetailRow[] = [];
    if (params.homeServerIdentityId) {
        rows.push({
            key: 'homeIdentity',
            label: t('connectionStatus.labels.homeIdentity'),
            value: params.homeServerIdentityId,
        });
    }
    if (params.canonicalServerUrl) {
        rows.push({
            key: 'canonicalAddress',
            label: t('connectionStatus.labels.canonicalAddress'),
            value: params.canonicalServerUrl,
        });
    }
    if (params.publicServerUrl !== undefined) {
        rows.push({
            key: 'publicIngress',
            label: t('connectionStatus.labels.publicIngress'),
            value: params.publicServerUrl === null
                ? t('connectionStatus.values.publicIngressAbsent')
                : params.publicServerUrl,
        });
    }
    if (params.runtimeOrigin && params.runtimeOrigin !== params.canonicalServerUrl) {
        rows.push({
            key: 'runtimeOrigin',
            label: t('connectionStatus.labels.runtimeOrigin'),
            value: params.runtimeOrigin,
        });
    }
    const diagnostics = params.diagnostics;
    if (diagnostics?.remoteEndpointId) {
        rows.push({
            key: 'endpointId',
            label: t('connectionStatus.labels.endpointId'),
            value: diagnostics.remoteEndpointId,
        });
    }
    if (params.transportPresentation.effectiveCarrier) {
        rows.push({
            key: 'effectiveCarrier',
            label: t('connectionStatus.labels.effectiveCarrier'),
            value: params.transportPresentation.effectiveCarrier === 'iroh' ? 'Iroh' : 'HTTPS',
        });
    }
    const appendPathRow = (
        key: 'currentPath' | 'lastKnownPath',
        observation: NonNullable<DoctorSnapshotHomeTransportDiagnostics['current']>,
    ) => {
        const pathLabel = observation.observedPath === 'direct'
            ? t('connectionStatus.values.pathDirect')
            : observation.observedPath === 'relay'
                ? t('connectionStatus.values.pathRelay')
                : t('status.unknown');
        rows.push({
            key,
            label: key === 'currentPath'
                ? t('connectionStatus.labels.currentPath')
                : t('connectionStatus.labels.lastKnownPath'),
            value: observation.carrier
                ? `${observation.carrier === 'iroh' ? 'Iroh' : 'HTTPS'} · ${pathLabel}`
                : pathLabel,
        });
    };
    for (const path of params.transportPresentation.detailPaths) {
        appendPathRow(path.role === 'current' ? 'currentPath' : 'lastKnownPath', path.observation);
    }
    const configuration = diagnostics?.effectiveConfiguration;
    if (configuration) {
        rows.push({
            key: 'relayConfiguration',
            label: t('connectionStatus.labels.relayConfiguration'),
            value: formatIrohRelayConfiguration(configuration),
        });
    }
    if (diagnostics?.diagnosticError) {
        const { code, message } = diagnostics.diagnosticError;
        rows.push({
            key: 'transportError',
            label: t('connectionStatus.labels.transportError'),
            value: message ? `${code}: ${message}` : code,
        });
    }
    if (diagnostics?.lastTransitionAtMs !== undefined) {
        rows.push({
            key: 'lastTransition',
            label: t('connectionStatus.labels.lastTransition'),
            value: formatTime(diagnostics.lastTransitionAtMs),
        });
    }
    // These rows are rendered and copied. Sanitize once at their shared owner
    // so neither surface can disclose bearer material, URL credentials, or
    // secret-shaped values emitted by a transport boundary.
    return rows.map((row) => ({
        ...row,
        value: sanitizeDoctorDiagnosticText(row.value),
    }));
}

function resolveStatusPresentation(
    theme: { colors: { status: Record<string, string> } },
    status: ConnectionStatusKey,
): { labelKey: TranslationKeyNoParams; color: string; dotColor: string; pillVariant: StatusPillVariant } {
    switch (status) {
        case 'connected':
            return { labelKey: 'status.connected', color: theme.colors.status.connected, dotColor: theme.colors.status.connected, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'connecting':
            return { labelKey: 'status.connecting', color: theme.colors.status.connecting, dotColor: theme.colors.status.connecting, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'action_required':
            return { labelKey: 'status.actionRequired', color: theme.colors.status.actionRequired, dotColor: theme.colors.status.actionRequired, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'error':
            return { labelKey: 'status.error', color: theme.colors.status.error, dotColor: theme.colors.status.error, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'disconnected':
            return { labelKey: 'status.disconnected', color: theme.colors.status.disconnected, dotColor: theme.colors.status.disconnected, pillVariant: resolveConnectionStatusPillVariant(status) };
        default:
            return { labelKey: 'status.unknown', color: theme.colors.status.default, dotColor: theme.colors.status.default, pillVariant: resolveConnectionStatusPillVariant(status) };
    }
}

/** Relay status without a known transport state: the endpoint, else the Home summary. */
function resolveRelayStatusKey(params: Readonly<{
    endpointStatus: unknown;
    homeSummaryStatusKey: HomeConnectionStatusKey;
}>): ConnectionStatusKey {
    switch (params.endpointStatus) {
        case 'online':
            return 'connected';
        case 'connecting':
            return 'connecting';
        case 'auth_failed':
            return 'action_required';
        case 'offline':
        case 'shutting_down':
            return 'disconnected';
        case 'idle':
            return params.homeSummaryStatusKey;
        default:
            return 'unknown';
    }
}

function resolveSocketStatusKey(socketStatus: unknown): 'connected' | 'connecting' | 'disconnected' | 'error' | 'unknown' {
    switch (socketStatus) {
        case 'connected':
            return 'connected';
        case 'connecting':
            return 'connecting';
        case 'error':
            return 'error';
        case 'disconnected':
            return 'disconnected';
        default:
            return 'unknown';
    }
}

const ConnectionPopoverStatusRow = React.memo(function ConnectionPopoverStatusRow(props: Readonly<{
    testID: string;
    icon: IconName;
    title: string;
    subtitle: string;
    statusLabel: string;
    statusColor: string;
    dotColor: string;
    statusVariant: StatusPillVariant;
    divided?: boolean;
    onRetry?: () => void;
}>) {
    const styles = stylesheet;
    return (
        <View style={styles.statusRow} testID={props.testID}>
            {props.divided ? <View pointerEvents="none" style={styles.statusRowDivider} /> : null}
            <View style={styles.statusRowLeft}>
                <View style={styles.statusRowIcon}>
                    <Icon name={props.icon} size={17} color={props.dotColor} />
                </View>
                <View style={styles.statusRowText}>
                    <Text style={styles.statusRowTitle} numberOfLines={1}>
                        {props.title}
                    </Text>
                    <Text style={styles.statusRowSubtitle} numberOfLines={1} ellipsizeMode="tail">
                        {props.subtitle}
                    </Text>
                </View>
            </View>
            <View style={{ flex: 1 }} />
            <View style={styles.statusRowRight}>
                {props.onRetry ? (
                    <Pressable
                        testID={`${props.testID}-retry`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        hitSlop={8}
                        onPress={props.onRetry}
                        style={styles.statusRowRetryButton}
                    >
                        <Icon name="arrow-clockwise" size={16} color={props.statusColor} />
                    </Pressable>
                ) : null}
                <StatusPill
                    variant={props.statusVariant}
                    label={props.statusLabel}
                    style={styles.popoverStatusPill}
                />
            </View>
        </View>
    );
});

/**
 * What a host-drawn trigger needs to present this Home's state. The control keeps the popover (and,
 * for `header`, the full-screen route); a host that places the trigger elsewhere — the sidebar's
 * account area — draws it from these facts and calls `activate`.
 */
export type ConnectionStatusTriggerState = Readonly<{
    open: boolean;
    /** Opens the popover (or, for `header`, the Home route). Pass the press event: focus returns there. */
    activate: (event?: unknown) => void;
    homeLabel: string;
    statusLabel: string;
    statusColor: string;
    /** The Home needs the person (sign-in, error): show a non-colour cue, not only a dot. */
    needsAttention: boolean;
    connecting: boolean;
    /** "<Home>, <status>": the trigger's accessible name, for the host to extend. */
    accessibilityLabel: string;
    /**
     * This Home's sign-in service, from the same owner the popover reads (local facts only), so a
     * trigger never names a service or offers a link the popover would contradict.
     */
    accountService: HomeAccountServiceSummary;
}>;

export const ConnectionStatusControl = React.memo(function ConnectionStatusControl(props: {
    variant: Variant;
    textSize?: number;
    dotSize?: number;
    chevronSize?: number;
    alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
    /**
     * Where the popover opens relative to its trigger: upwards from a sidebar footer, or to the right
     * of a rail avatar (bottom edges aligned). The content is the same wherever the trigger sits.
     */
    popoverPlacement?: 'top' | 'bottom' | 'right';
    /** Replaces the built-in status line with a host-drawn trigger (see `ConnectionStatusTriggerState`). */
    renderTrigger?: (state: ConnectionStatusTriggerState) => React.ReactNode;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const invokingPath = usePathname();
    const auth = useAuth();
    const socketStatus = useSocketStatus();
    const syncError = useSyncError();
    const lastSyncAt = useLastSyncAt();
    const connectionHealth = useActiveHomeConnectionHealth();
    const {
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    } = useHomeViewSelectionSettingsMutable();

    const [open, setOpen] = React.useState(false);
    const [detailsExpanded, setDetailsExpanded] = React.useState(false);
    const [popoverStep, setPopoverStep] = React.useState<AccountPopoverStep>('root');
    const [diagnosticsCopied, setDiagnosticsCopied] = React.useState(false);
    const [pendingServerId, setPendingServerId] = React.useState<string | null>(null);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const triggerRef = React.useRef<React.ElementRef<typeof Pressable> | null>(null);
    // A host-drawn trigger's own control, recorded from its press, is where focus returns.
    const hostTriggerFocusRef = React.useRef<FocusReturnTarget>(null);
    const serverProfilesGeneration = useServerProfilesGeneration();
    const activeServerSnapshot = useActiveServerSnapshot();
    const appliedServerId = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeAppliedActiveServer(() => listener()), []),
        getAppliedActiveServerId,
        getAppliedActiveServerId,
    );

    const textSize = props.textSize ?? (props.variant === 'sidebar' ? 11 : 12);
    const dotSize = props.dotSize ?? 6;
    const chevronSize = props.chevronSize ?? 8;

    const servers = React.useMemo(() => {
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [];
        }
    }, [serverProfilesGeneration]);
    const activeServerId = activeServerSnapshot.serverId;
    // Keep the trigger on the applied Home until the focus transaction commits.
    // The pending target row carries the connecting state, so cached/live facts
    // from the current Home are never presented under the requested Home's name.
    const displayServerId = appliedServerId || activeServerId;
    const displayUsesActiveSnapshot = areServerProfileIdentifiersEquivalent(displayServerId, activeServerId);
    const activeSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, displayServerId);
    }, [displayServerId, syncError]);
    const displayServerProfile = React.useMemo(() => {
        return servers.find((server) => server.id === displayServerId || resolveServerProfileScopeId(server) === displayServerId) ?? null;
    }, [displayServerId, servers]);
    const displayHomeCarrier = displayUsesActiveSnapshot ? getActiveServerHomeCarrier() : null;
    // Only a host-drawn trigger shows the service; the built-in status line never does.
    const accountServiceSummary = useHomeAccountServiceSummary(props.renderTrigger ? displayServerProfile : null);
    const displayServerUrl = displayServerProfile?.serverUrl
        ?? (displayUsesActiveSnapshot ? activeServerSnapshot.serverUrl : '');
    const diagnosticsHomeIdentity = displayServerProfile?.serverIdentityId ?? displayServerId;
    // The popover shows technical facts on its Connection details step; the full-screen surface
    // keeps its disclosure. Either way, transport facts are observed only while shown.
    const detailsVisible = props.variant === 'fullScreen'
        ? detailsExpanded
        : (open || props.variant === 'page') && popoverStep === 'details';
    const subscribeTransportDiagnostics = React.useCallback((listener: () => void) => (
        detailsVisible ? subscribeIrohHomeTransportDiagnostics(listener) : () => undefined
    ), [detailsVisible]);
    const readTransportDiagnosticsRevision = React.useCallback(
        () => detailsVisible ? readIrohHomeTransportDiagnosticsRevision() : 0,
        [detailsVisible],
    );
    // Only the open Advanced section observes transport facts. Routine health
    // remains owned by useConnectionHealth and path changes stay silent while
    // Details is collapsed.
    const transportDiagnosticsRevision = React.useSyncExternalStore(
        subscribeTransportDiagnostics,
        readTransportDiagnosticsRevision,
        readTransportDiagnosticsRevision,
    );
    const transportDiagnostics = React.useMemo(() => detailsVisible
        ? readIrohHomeTransportDiagnostics().find(
            (entry) => entry.homeServerIdentityId === diagnosticsHomeIdentity,
        ) ?? null
        : null, [detailsVisible, diagnosticsHomeIdentity, transportDiagnosticsRevision]);
    React.useEffect(() => {
        setDiagnosticsCopied(false);
    }, [activeServerSnapshot.generation, diagnosticsHomeIdentity]);
    const toggleDetails = React.useCallback(() => {
        setDiagnosticsCopied(false);
        setDetailsExpanded((expanded) => !expanded);
    }, []);
    // The Home label owner names the Home (an address-only name reads "Home on <host>").
    const activeServerLabel = React.useMemo(() => (
        displayServerProfile
            ? resolveHomeDisplayLabel(displayServerProfile, displayServerProfile.id)
            : toServerUrlDisplay(displayServerUrl) || t('status.connected')
    ), [displayServerProfile, displayServerUrl]);

    const switchServer = React.useCallback(async (
        serverId: string,
        scope: 'tab' | 'device',
        intent: 'direct' | 'group' = 'group',
    ) => {
        setPendingServerId(serverId);
        try {
            const result = await setActiveServerAndSwitch({ serverId, scope, refreshAuth: auth.refreshFromActiveServer });
            if (result !== 'blocked') {
                setOpen(false);
                setDetailsExpanded(false);
                setPopoverStep('root');
                if (intent === 'direct') {
                    const profile = getServerProfileById(serverId);
                    if (profile) await offerThisComputerConnectionToHome(profile);
                }
            }
            return result;
        } finally {
            setPendingServerId((current) => current === serverId ? null : current);
        }
    }, [auth]);

    const serverSelectionScopeSettings = React.useMemo(() => normalizeServerSelectionSettingsForProfileScopeIds({
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    }, servers), [
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        servers,
    ]);

    const usableServerIds = useUsableHomeServerIds();
    const serverTargets = React.useMemo(() => {
        return listServerSelectionTargets({
            serverProfiles: servers.map((profile) => ({
                id: resolveServerProfileScopeId(profile),
                name: profile.name,
                serverUrl: profile.serverUrl,
            })),
            groupProfiles: normalizeStoredServerSelectionGroups(serverSelectionScopeSettings.serverSelectionGroups),
            usableServerIds,
        });
    }, [usableServerIds, serverSelectionScopeSettings.serverSelectionGroups, servers]);

    const resolvedTarget = React.useMemo(() => {
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId,
            availableServerIds: listServerProfileScopeIds(servers),
            settings: serverSelectionScopeSettings,
            usableServerIds,
        });
    }, [
        usableServerIds,
        activeServerId,
        serverSelectionScopeSettings,
        servers,
    ]);

    const activeTargetKey = React.useMemo(() => {
        return `${resolvedTarget.activeTarget.kind}:${resolvedTarget.activeTarget.id}`;
    }, [resolvedTarget.activeTarget.id, resolvedTarget.activeTarget.kind]);

    const syncErrorPresentation = React.useMemo(() => {
        if (!activeSyncError) return null;
        const classified = resolveSocketErrorClassification(activeSyncError.message);
        return {
            ...classified,
            kind: activeSyncError.kind === 'auth' ? 'auth' : classified.kind,
            retryable: activeSyncError.retryable ?? classified.retryable,
            message: classified.message,
        };
    }, [activeSyncError]);

    // First layer: this Home's identity, reachable state, realtime connection,
    // and machine readiness. Raw transport diagnostics stay behind Details.
    const homeSummary = React.useMemo(() => resolveHomeConnectionSummary({
        healthKind: connectionHealth.kind,
        syncErrorKind: syncErrorPresentation?.kind ?? null,
        syncErrorRetryable: syncErrorPresentation?.retryable ?? null,
    }), [connectionHealth.kind, syncErrorPresentation]);

    const homeSummaryPresentation = resolveStatusPresentation(theme, homeSummary.statusKey);

    const machineSummary = React.useMemo(() => resolveMachineConnectionSummary({
        machineCount: connectionHealth.machineCount,
        onlineCount: connectionHealth.onlineCount,
        hasUnknownMachines: connectionHealth.hasUnknownMachines,
        primaryMachineLabel: connectionHealth.primaryMachineLabel,
    }), [
        connectionHealth.hasUnknownMachines,
        connectionHealth.machineCount,
        connectionHealth.onlineCount,
        connectionHealth.primaryMachineLabel,
    ]);
    const machineSubtitle = React.useMemo(() => {
        const summary = machineSummary;
        switch (summary.kind) {
            case 'unknown':
                return t('status.unknown');
            case 'none':
                return t('systemStatus.machines.none');
            case 'single':
                return summary.label;
            case 'multiple':
                return summary.offlineCount === 0
                    ? `${summary.onlineCount} ${t('status.online')}`
                    : `${summary.onlineCount} ${t('status.online')} · ${summary.offlineCount} ${t('status.offline')}`;
        }
    }, [machineSummary]);
    // "No machines" is explained in one sentence below the rows, so the pill stays a short state.
    // Only a Home that answers can say it has no machines: an unreachable one has loaded nothing.
    const showsMachineGuidance = machineSummary.kind === 'none'
        && displayUsesActiveSnapshot
        && homeSummary.kind === 'connected';

    const irohTransportPresentation = React.useMemo(() => projectIrohHomeTransportPresentation({
        effectiveCarrier: displayUsesActiveSnapshot ? activeServerSnapshot.carrier : null,
        diagnostics: transportDiagnostics,
    }), [activeServerSnapshot.carrier, displayUsesActiveSnapshot, transportDiagnostics]);
    const canonicalServerUrl = displayServerProfile?.canonicalServerUrl ?? displayServerUrl;
    const transportDetailRows = React.useMemo(() => buildTransportDetailRows({
        homeServerIdentityId: displayServerProfile?.serverIdentityId ?? (displayUsesActiveSnapshot ? activeServerSnapshot.serverId : null),
        canonicalServerUrl,
        publicServerUrl: displayServerProfile?.publicServerUrl,
        runtimeOrigin: displayUsesActiveSnapshot ? activeServerSnapshot.runtimeOrigin ?? null : null,
        diagnostics: transportDiagnostics,
        transportPresentation: irohTransportPresentation,
    }), [
        activeServerSnapshot.carrier,
        activeServerSnapshot.runtimeOrigin,
        canonicalServerUrl,
        displayUsesActiveSnapshot,
        displayServerProfile?.publicServerUrl,
        displayServerProfile?.serverIdentityId,
        activeServerSnapshot.serverId,
        irohTransportPresentation,
        transportDiagnostics,
    ]);

    const handleCopyDiagnostics = React.useCallback(() => {
        const report = [
            `${t('connectionStatus.title')}: ${activeServerLabel} — ${t(homeSummary.statusLabelKey)}`,
            ...transportDetailRows.map((row) => `${row.label}: ${row.value}`),
            `${t('systemStatus.ui.socket')}: ${socketStatus.status}`,
            `${t('settings.machines')}: ${machineSubtitle}`,
            `${t('connectionStatus.labels.lastSync')}: ${formatTime(lastSyncAt)}`,
            ...(syncErrorPresentation ? [`${t('connectionStatus.labels.lastError')}: ${syncErrorPresentation.message}`] : []),
        ].join('\n');
        fireAndForget(setClipboardStringSafe(sanitizeDoctorDiagnosticText(report)).then((copied) => {
            if (copied) setDiagnosticsCopied(true);
        }), { tag: 'ConnectionStatusControl.copyDiagnostics' });
    }, [
        activeServerLabel,
        homeSummary.statusLabelKey,
        lastSyncAt,
        machineSubtitle,
        socketStatus.status,
        syncErrorPresentation,
        transportDetailRows,
    ]);

    const closePopover = React.useCallback(() => {
        setOpen(false);
        setDetailsExpanded(false);
        setDiagnosticsCopied(false);
        setPopoverStep('root');
    }, []);

    /**
     * The popover's one dismiss rule. An action declares its effect: one that takes the person
     * somewhere (a route, a sheet, another Home) closes the popover; one that works in place (a
     * retry) keeps it open, and its row reports progress and the outcome.
     */
    const runPopoverAction = React.useCallback(<T,>(effect: 'navigates' | 'in_place', run: () => T): T => {
        if (effect === 'navigates') closePopover();
        return run();
    }, [closePopover]);

    const handleRestoreAccount = React.useCallback(() => {
        if (!displayServerProfile) return;
        runPopoverAction('navigates', () => {
            const result = runGuardedNavigation(() => router.push(buildHomeRecoveryHref({
                profileRef: displayServerProfile.id,
                returnTo: invokingPath,
            })));
            if (result !== true) {
                fireAndForget(result, { tag: 'ConnectionStatusControl.nav.restore' });
            }
        });
    }, [displayServerProfile, invokingPath, router, runPopoverAction]);

    // Returns the reconnect's promise so the Retry control shows it pending until it settles.
    const handleRetry = React.useCallback(() => runPopoverAction('in_place', () => (
        retryActiveServerConnection().catch(() => undefined)
    )), [runPopoverAction]);

    const handleManageRelay = React.useCallback(() => {
        runPopoverAction('navigates', () => {
            const result = runGuardedNavigation(() => router.push(RELAY_SETTINGS_ROUTE));
            if (result !== true) {
                fireAndForget(result, { tag: 'ConnectionStatusControl.nav.manageRelay' });
            }
        });
    }, [router, runPopoverAction]);
    // Add a Home is Settings → Homes' draft: the same form everywhere, pushed on a phone.
    const handleOpenAddHome = React.useCallback(() => {
        runPopoverAction('navigates', () => {
            const result = runGuardedNavigation(() => router.push(HOMES_ADD_ROUTE as never));
            if (result !== true) fireAndForget(result, { tag: 'ConnectionStatusControl.nav.addHome' });
        });
    }, [router, runPopoverAction]);
    const handleActivate = React.useCallback(() => {
        if (props.variant === 'header') {
            const result = runGuardedNavigation(() => router.push(ACCOUNT_HOMES_ROUTE));
            if (result !== true) {
                fireAndForget(result, { tag: 'ConnectionStatusControl.nav.fullScreenHomes' });
            }
            return;
        }
        setOpen((currentOpen) => {
            if (currentOpen) {
                setDetailsExpanded(false);
                setDiagnosticsCopied(false);
                setPopoverStep('root');
            }
            return !currentOpen;
        });
    }, [props.variant, router]);
    const collapsedStatusLabel = t(homeSummary.statusLabelKey);
    const collapsedStatusColor = homeSummaryPresentation.color;
    // DESIGN.md forbids color as the only carrier of meaning. For states that
    // truly need attention (the canonical Home summary), the collapsed trigger swaps
    // its bare dot for a warning glyph carrying the same status color — one
    // quiet non-color cue. Routine connected/connecting stays dot-only and
    // transport-neutral; detail remains inside the popover.
    const collapsedShowsAttentionCue =
        homeSummary.statusKey === 'action_required' || homeSummary.statusKey === 'error';
    const collapsedStatusIsPulsing = homeSummary.statusKey === 'connecting';
    const socketPresentation = resolveStatusPresentation(
        theme,
        resolveSocketStatusKey(socketStatus.status),
    );
    const machineStatusKey = resolveMachineConnectionStatusKey(connectionHealth.machineLabelKey);
    const machinesPresentation = resolveStatusPresentation(theme, machineStatusKey);
    const relayStatusKey = irohTransportPresentation.transportStatus?.statusKey
        ?? resolveRelayStatusKey({
            endpointStatus: connectionHealth.endpointStatus,
            homeSummaryStatusKey: homeSummary.statusKey,
        });
    const relayPresentation = resolveStatusPresentation(theme, relayStatusKey);
    const canRetryRelayConnection = irohTransportPresentation.permitsRetry && (
        relayStatusKey === 'connecting'
        || relayStatusKey === 'disconnected'
        || relayStatusKey === 'error'
    );
    const hasIrohTransportDetails = transportDiagnostics !== null
        || irohTransportPresentation.isEffectiveIroh;
    const irohTransportTitleKey: TranslationKeyNoParams = irohTransportPresentation.heading === 'current'
        ? 'systemStatus.transport.irohCurrent'
        : 'systemStatus.transport.irohHistory';
    const primaryActionLabel = homeSummary.action === 'restore'
        ? t('connect.restoreAccount')
        : t('common.retry');
    // The Home's live facts: on the Homes page's Connection details, and on the popover's
    // Connection details step (the popover's first layer already names each Home's health).
    const homeStatusList = (
            <View style={styles.popoverStatusList}>
                <ConnectionPopoverStatusRow
                    testID="connection-popover-home"
                    icon="house"
                    title={activeServerLabel}
                    subtitle={toServerUrlDisplay(displayServerUrl)}
                    statusLabel={t(homeSummary.statusLabelKey)}
                    statusColor={homeSummaryPresentation.color}
                    dotColor={homeSummaryPresentation.dotColor}
                    statusVariant={homeSummaryPresentation.pillVariant}
                />
                <ConnectionPopoverStatusRow
                    testID="connection-popover-realtime"
                    icon="pulse"
                    title={t('systemStatus.ui.realtime')}
                    subtitle={t('systemStatus.ui.socket')}
                    statusLabel={t(socketPresentation.labelKey)}
                    statusColor={socketPresentation.color}
                    dotColor={socketPresentation.dotColor}
                    statusVariant={socketPresentation.pillVariant}
                    divided
                />
                <ConnectionPopoverStatusRow
                    testID="connection-popover-machines"
                    icon="laptop"
                    title={t('settings.machines')}
                    subtitle={machineSubtitle}
                    statusLabel={showsMachineGuidance ? t('status.actionRequired') : t(connectionHealth.machineLabelKey)}
                    statusColor={machinesPresentation.color}
                    dotColor={machinesPresentation.dotColor}
                    statusVariant={machinesPresentation.pillVariant}
                    divided
                />
            </View>
    );
    const homeConnectionSummaryContent = (
        <>
            {homeStatusList}

            {showsMachineGuidance ? (
                <ConnectionPopoverMachineGuidance
                    homeLabel={activeServerLabel}
                    onClose={closePopover}
                />
            ) : null}

            {homeSummary.action !== 'none' ? (
                <View style={styles.popoverActionsRow}>
                    <Pressable
                        testID="connection-popover-primary-action"
                        onPress={homeSummary.action === 'restore' ? handleRestoreAccount : handleRetry}
                        style={styles.popoverActionButton}
                        accessibilityRole="button"
                        accessibilityLabel={primaryActionLabel}
                    >
                        <Text style={styles.popoverActionButtonText}>{primaryActionLabel}</Text>
                    </Pressable>
                    <CopiedPill
                        visible={diagnosticsCopied}
                        testID="connection-copy-diagnostics-feedback"
                    />
                </View>
            ) : null}
        </>
    );
    const detailsBody = (
        <>
            {hasIrohTransportDetails ? (
                <View style={styles.popoverStatusList}>
                    <ConnectionPopoverStatusRow
                        testID="connection-popover-relay"
                        icon="hard-drives"
                        title={t(irohTransportTitleKey)}
                        subtitle={toServerUrlDisplay(displayServerUrl)}
                        statusLabel={t(relayPresentation.labelKey)}
                        statusColor={relayPresentation.color}
                        dotColor={relayPresentation.dotColor}
                        statusVariant={relayPresentation.pillVariant}
                        onRetry={canRetryRelayConnection ? handleRetry : undefined}
                    />
                </View>
            ) : null}

            <View style={styles.statusMeta}>
                <View style={styles.statusMetaRow}>
                    <Text style={styles.statusMetaLabel}>
                        {t('connectionStatus.labels.lastSync')}
                    </Text>
                    <Text style={styles.statusMetaValue}>
                        {formatTime(lastSyncAt)}
                    </Text>
                </View>
                {syncErrorPresentation ? (
                    <View style={styles.statusMetaRow}>
                        <Text style={styles.statusMetaLabel}>
                            {t('connectionStatus.labels.lastError')}
                        </Text>
                        <Text style={[styles.statusMetaValue, { flexShrink: 1, textAlign: 'right' }]} numberOfLines={2}>
                            {syncErrorPresentation.message}
                        </Text>
                    </View>
                ) : null}
            </View>

            {transportDetailRows.length > 0 ? (
                <View style={styles.technicalDetails} testID="connection-transport-diagnostics">
                    <Text style={styles.technicalDetailsTitle}>
                        {t('terminal.connectionDetails')}
                    </Text>
                    {transportDetailRows.map((row) => (
                        <View key={row.key} style={styles.statusMetaRow}>
                            <Text style={styles.statusMetaLabel}>{row.label}</Text>
                            <Text
                                style={[styles.technicalDetailsValue, { flexShrink: 1, textAlign: 'right' }]}
                                selectable
                            >
                                {row.value}
                            </Text>
                        </View>
                    ))}
                    <Pressable
                        testID="connection-copy-diagnostics"
                        accessibilityRole="button"
                        accessibilityLabel={diagnosticsCopied
                            ? t('connectionStatus.diagnosticsCopied')
                            : t('connectionStatus.copyDiagnostics')}
                        onPress={handleCopyDiagnostics}
                        style={styles.copyDiagnosticsButton}
                    >
                        <Icon
                            name={diagnosticsCopied ? 'check' : 'copy'}
                            size={14}
                            color={theme.colors.text.secondary}
                        />
                        <Text style={styles.detailsDisclosureText}>
                            {diagnosticsCopied
                                ? t('connectionStatus.diagnosticsCopied')
                                : t('connectionStatus.copyDiagnostics')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
        </>
    );
    const homeConnectionDetailsContent = (
        <>
            <Pressable
                testID="connection-details-disclosure"
                accessibilityRole="button"
                accessibilityLabel={t('common.details')}
                accessibilityState={{ expanded: detailsExpanded }}
                onPress={toggleDetails}
                style={styles.detailsDisclosure}
            >
                <Text style={styles.detailsDisclosureText}>{t('common.details')}</Text>
                <Icon
                    name={detailsExpanded ? 'caret-up' : 'caret-down'}
                    size={14}
                    color={theme.colors.text.secondary}
                />
            </Pressable>

            {detailsExpanded ? detailsBody : null}
        </>
    );

    // A1 · Identity & Homes: the popover's content, and the phone page's.
    const accountContent = (
        <AccountPopoverContent
            step={popoverStep}
            onStepChange={setPopoverStep}
            servers={servers}
            targets={serverTargets}
            activeTargetKey={activeTargetKey}
            activeServerId={activeServerId}
            displayServerId={displayServerId}
            displayServerProfile={displayServerProfile}
            displayHomeLabel={activeServerLabel}
            pendingServerId={pendingServerId}
            homeSummary={homeSummary}
            machineSummary={machineSummary}
            showsMachineGuidance={showsMachineGuidance}
            runtimeOrigin={displayUsesActiveSnapshot && !displayHomeCarrier ? activeServerSnapshot.runtimeOrigin ?? null : null}
            homeCarrier={displayHomeCarrier}
            switchServer={switchServer}
            onRetry={handleRetry}
            onRestore={handleRestoreAccount}
            onAddHome={handleOpenAddHome}
            onManageHomes={handleManageRelay}
            onClose={closePopover}
            renderDetails={() => (
                <>
                    {homeStatusList}
                    {detailsBody}
                </>
            )}
        />
    );

    if (props.variant === 'page') {
        return (
            <View testID="account-homes-page-content">
                {/* The popover's surface, unbounded: the page scrolls, not the sheet. */}
                <FloatingOverlay scrollEnabled={false} maxHeight={Number.POSITIVE_INFINITY}>
                    <View style={styles.popoverContent}>{accountContent}</View>
                </FloatingOverlay>
            </View>
        );
    }

    if (props.variant === 'fullScreen') {
        return <View testID="connection-status-full-screen" style={styles.popoverContent}>
            {homeConnectionSummaryContent}
            {homeConnectionDetailsContent}
        </View>;
    }

    return (
        <>
            {/* Use a View wrapper for the anchor ref (stable, measurable). */}
            <View
                style={[styles.container, props.alignSelf ? { alignSelf: props.alignSelf } : null]}
                ref={anchorRef}
                collapsable={false}
            >
                {props.renderTrigger ? props.renderTrigger({
                    open,
                    activate: (event?: unknown) => {
                        hostTriggerFocusRef.current = readPressFocusReturnTarget(event);
                        handleActivate();
                    },
                    homeLabel: activeServerLabel,
                    statusLabel: collapsedStatusLabel,
                    statusColor: collapsedStatusColor,
                    needsAttention: collapsedShowsAttentionCue,
                    connecting: collapsedStatusIsPulsing,
                    accessibilityLabel: `${activeServerLabel}, ${collapsedStatusLabel}`,
                    accountService: accountServiceSummary,
                }) : (
                <Pressable
                    ref={triggerRef}
                    style={[
                        styles.statusContainer,
                        props.variant === 'header'
                            ? styles.headerStatusContainer
                            : styles.sidebarStatusContainer,
                    ]}
                    onPress={handleActivate}
                    accessibilityRole="button"
                    accessibilityLabel={`${activeServerLabel}, ${collapsedStatusLabel}`}
                    accessibilityState={props.variant === 'sidebar' ? { expanded: open } : undefined}
                >
                    {collapsedShowsAttentionCue ? (
                        <Icon
                            name="warning"
                            size={dotSize + 4}
                            color={collapsedStatusColor}
                            style={{ marginRight: 4 }}
                        />
                    ) : (
                        <StatusDot
                            color={collapsedStatusColor}
                            isPulsing={collapsedStatusIsPulsing}
                            size={dotSize}
                            style={{ marginRight: 4 }}
                        />
                    )}
                    <Text
                        style={[styles.statusText, { color: collapsedStatusColor, fontSize: textSize }]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                    >
                        {activeServerLabel}
                    </Text>
                    <Icon
                        name={props.variant === 'header' ? 'caret-right' : open ? 'caret-up' : 'caret-down'}
                        size={chevronSize}
                        color={collapsedStatusColor}
                        style={styles.statusChevron}
                    />
                </Pressable>
                )}
                {props.variant === 'sidebar' && open ? (
                    <Popover
                        open={open}
                        anchorRef={anchorRef}
                        focusReturnRef={props.renderTrigger ? hostTriggerFocusRef : triggerRef}
                        autoFocusOnOpen
                        placement={props.popoverPlacement ?? 'bottom'}
                        edgePadding={{ horizontal: 12, vertical: 12 }}
                        portal={{
                            web: true,
                            native: true,
                            matchAnchorWidth: false,
                            // The content sets the width (A1 · Identity & Homes), within the shared bounds.
                            sizeToContent: true,
                            anchorAlign: 'start',
                            anchorAlignVertical: 'end',
                        }}
                        maxHeightCap={520}
                        minWidth={ACCOUNT_POPOVER_WIDTH}
                        maxWidthCap={ACCOUNT_POPOVER_WIDTH}
                        onRequestClose={closePopover}
                    >
                    {({ maxHeight }) => (
                        <FloatingOverlay
                            maxHeight={Math.max(220, Math.min(maxHeight, 520))}
                            keyboardShouldPersistTaps="always"
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                            edgeIndicators={true}
                        >
                            <View style={styles.popoverContent} testID="connection-popover-content">
                                {accountContent}
                            </View>
                        </FloatingOverlay>
                    )}
                    </Popover>
                ) : null}
            </View>

        </>
    );
});
