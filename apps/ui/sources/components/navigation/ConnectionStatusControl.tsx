import * as React from 'react';
import { useUsableHomeServerIds } from '@/sync/domains/scope/usableHomeServerIds';
import { Platform, View } from 'react-native';
import { HappierPressable, type HappierFocusable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t, type TranslationKeyNoParams } from '@/text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Popover } from '@/components/ui/popover';
import { readPressFocusReturnTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { storage, useSocketStatus, useSyncError, useLastSyncAt } from '@/sync/domains/state/storage';
import { useHomeViewSelectionSettingsMutable } from '@/hooks/server/useHomeViewSelectionSettings';
import { useAuth } from '@/auth/context/AuthContext';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
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
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { useRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
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
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import {
    sanitizeDoctorDiagnosticText,
    type DoctorSnapshotHomeTransportDiagnostics,
} from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { openAddHome } from '@/components/homes/add/openAddHome';
import { buildHomeRecoveryHref } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';

/**
 * `sidebar` and `header` (a phone tab's head): the trigger opens the account/Home popover in place, beside or
 * below it (owner R3/R4, 2026-11-09). `page`: the same content inline on the Account & Homes page.
 * `fullScreen`: the Home's connection facts on the Homes page.
 */
type Variant = 'sidebar' | 'header' | 'page' | 'fullScreen';
const RELAY_SETTINGS_ROUTE = '/settings/server';
const SETTINGS_ROUTE = '/settings';
const DENSE_POINTER_TARGET_SIZE = 24;
/** A1 · Identity & Homes is drawn 300 wide, and keeps that width on its steps (long values wrap). */
const ACCOUNT_POPOVER_WIDTH = 300;

type ConnectionStatusKey = 'connected' | 'connecting' | 'disconnected' | 'error' | 'action_required' | 'unknown';

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
        marginLeft: theme.space.s2,
        marginTop: 1,
        opacity: 0.9,
    },
    // The surface's share of the menu rhythm (`MENU_ROW_METRICS`): one inset above and below the
    // sections, which add their own; the full-screen surface keeps the same measure.
    popoverContent: {
        paddingVertical: MENU_ROW_METRICS.sectionPaddingVerticalPx,
    },
    popoverActionsRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s12,
    },
    // A live fact's state in its row's trailing column: a small dot and one quiet word.
    statusTrailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    statusWordText: {
        color: theme.colors.text.secondary,
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
): { labelKey: TranslationKeyNoParams; color: string } {
    switch (status) {
        case 'connected':
            return { labelKey: 'status.connected', color: theme.colors.status.connected };
        case 'connecting':
            return { labelKey: 'status.connecting', color: theme.colors.status.connecting };
        case 'action_required':
            return { labelKey: 'status.actionRequired', color: theme.colors.status.actionRequired };
        case 'error':
            return { labelKey: 'status.error', color: theme.colors.status.error };
        case 'disconnected':
            return { labelKey: 'status.disconnected', color: theme.colors.status.disconnected };
        default:
            return { labelKey: 'status.unknown', color: theme.colors.status.default };
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
        // An intentional pause reconnects on resume; it is never presented as a loss.
        case 'paused':
            return 'connecting';
        case 'error':
            return 'error';
        case 'disconnected':
            return 'disconnected';
        default:
            return 'unknown';
    }
}

/** A live fact's state: a small dot in its colour and the word that names it. */
function ConnectionStatusWord(props: Readonly<{ label: string; color: string }>) {
    return (
        <View style={stylesheet.statusTrailing}>
            <StatusDot color={props.color} size={6} />
            <Text variant="meta" style={stylesheet.statusWordText} numberOfLines={1}>{props.label}</Text>
        </View>
    );
}

/** One live fact of the Home (this Home, realtime, machines, the relay): what it is, then its state. */
const ConnectionPopoverStatusRow = React.memo(function ConnectionPopoverStatusRow(props: Readonly<{
    testID: string;
    icon: IconName;
    title: string;
    subtitle: string;
    statusLabel: string;
    statusColor: string;
    onRetry?: () => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <Item
            testID={props.testID}
            mode="info"
            icon={<Icon name={props.icon} size={16} color={theme.colors.text.secondary} />}
            title={props.title}
            subtitle={props.subtitle}
            subtitleLines={1}
            rightElementYields={!props.onRetry}
            rightElement={(
                <View style={stylesheet.statusTrailing}>
                    {props.onRetry ? (
                        <IconButton
                            testID={`${props.testID}-retry`}
                            iconName="arrow-clockwise"
                            variant="plain"
                            size={DENSE_POINTER_TARGET_SIZE}
                            iconSize={16}
                            accessibilityLabel={t('common.retry')}
                            onPress={props.onRetry}
                        />
                    ) : null}
                    <ConnectionStatusWord label={props.statusLabel} color={props.statusColor} />
                </View>
            )}
        />
    );
});

/**
 * One group of the Connection details rows. On the popover (and the Account & Homes page, which draws
 * the popover's surface) it is a menu section; under the Homes page's own disclosure the rows stand bare
 * in that row's body, so the page never draws a card inside its sheet.
 */
function ConnectionDetailsSection(props: Readonly<{ menuSection: boolean; children: React.ReactNode }>) {
    return props.menuSection ? <ItemGroup>{props.children}</ItemGroup> : <>{props.children}</>;
}

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

/** The last sync moves on every sync: only the shown details read it, never the closed trigger. */
function LastSyncRow() {
    const lastSyncAt = useLastSyncAt();
    return lastSyncAt ? <SyncedAgoRow atMs={lastSyncAt} /> : (
        <Item testID="connection-popover-last-sync" mode="info" title={t('connectionStatus.labels.lastSync')} detail="—" />
    );
}

const IS_WEB = Platform.OS === 'web';

/**
 * "Synced just now": the age, kept current by the shared relative clock. The exact time is the row's
 * tooltip on the web and its long-press on a phone, and always part of its accessible name.
 */
function SyncedAgoRow(props: Readonly<{ atMs: number }>) {
    const when = useRelativeTime(props.atMs);
    const [exactShown, setExactShown] = React.useState(false);
    const relative = t('connectionStatus.syncedAgo', { when });
    const exact = formatTime(props.atMs);
    const accessibilityLabel = `${relative}, ${exact}`;
    if (IS_WEB) {
        return (
            <Tooltip testID="connection-popover-last-sync" label={exact} accessibilityLabel={accessibilityLabel}>
                <Item mode="info" title={relative} />
            </Tooltip>
        );
    }
    return (
        <Item
            testID="connection-popover-last-sync"
            title={exactShown ? exact : relative}
            accessibilityLabel={accessibilityLabel}
            showChevron={false}
            onLongPress={() => setExactShown((shown) => !shown)}
        />
    );
}

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
    const triggerRef = React.useRef<HappierFocusable | null>(null);
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
    const writeClipboard = useClipboardWrite(displayServerId, { enabled: open || props.variant === 'fullScreen' || props.variant === 'page' });
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
    // The Homes page mounts the full-screen surface only while its own Connection details row is open.
    const detailsVisible = props.variant === 'fullScreen'
        || ((open || props.variant === 'page') && popoverStep === 'details');
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
    // The Home label owner keeps titles human even while the profile is unavailable.
    const activeServerLabel = React.useMemo(() => (
        resolveHomeDisplayLabel(displayServerProfile, displayServerId)
    ), [displayServerProfile, displayServerId]);

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
            currentServerId: activeServerId,
            serverProfiles: servers.map((profile) => ({
                ...profile,
                id: resolveServerProfileScopeId(profile),
            })),
            groupProfiles: normalizeStoredServerSelectionGroups(serverSelectionScopeSettings.serverSelectionGroups),
            usableServerIds,
        });
    }, [activeServerId, usableServerIds, serverSelectionScopeSettings.serverSelectionGroups, servers]);

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

    const activeGroupId = React.useMemo(() => {
        return resolvedTarget.activeTarget.kind === 'group' ? resolvedTarget.activeTarget.id : null;
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
            `${t('connectionStatus.labels.lastSync')}: ${formatTime(storage.getState().lastSyncAt)}`,
            ...(syncErrorPresentation ? [`${t('connectionStatus.labels.lastError')}: ${syncErrorPresentation.message}`] : []),
        ].join('\n');
        fireAndForget(writeClipboard(sanitizeDoctorDiagnosticText(report)).then((copied) => {
            if (copied) setDiagnosticsCopied(true);
        }), { tag: 'ConnectionStatusControl.copyDiagnostics' });
    }, [
        activeServerLabel,
        writeClipboard,
        homeSummary.statusLabelKey,
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

    // The shared control covers preparation; the connection owner reports the subsequent probe/transport progress.
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
            const result = runGuardedNavigation(() => openAddHome(router));
            if (result !== true) fireAndForget(result, { tag: 'ConnectionStatusControl.nav.addHome' });
        });
    }, [router, runPopoverAction]);
    const handleOpenSettings = React.useCallback(() => {
        runPopoverAction('navigates', () => {
            const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTE));
            if (result !== true) fireAndForget(result, { tag: 'ConnectionStatusControl.nav.settings' });
        });
    }, [router, runPopoverAction]);
    const handleActivate = React.useCallback(() => {
        setOpen((currentOpen) => {
            if (currentOpen) {
                setDetailsExpanded(false);
                setDiagnosticsCopied(false);
                setPopoverStep('root');
            }
            return !currentOpen;
        });
    }, []);
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
    const isRetrying = connectionHealth.endpointStatus === 'connecting' || socketStatus.status === 'connecting'
        || socketStatus.status === 'paused';
    const nextRetryAt = connectionHealth.nextRetryAt ?? activeSyncError?.nextRetryAt;
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
    const menuSections = props.variant !== 'fullScreen';
    // The Home's live facts: on the Homes page's Connection details, and on the popover's
    // Connection details step (the popover's first layer already names each Home's health).
    const homeStatusList = (
        <ConnectionDetailsSection menuSection={menuSections}>
            <ConnectionPopoverStatusRow
                testID="connection-popover-home"
                icon="house"
                title={activeServerLabel}
                subtitle={toServerUrlDisplay(displayServerUrl)}
                statusLabel={t(homeSummary.statusLabelKey)}
                statusColor={homeSummaryPresentation.color}
            />
            <ConnectionPopoverStatusRow
                testID="connection-popover-realtime"
                icon="pulse"
                title={t('systemStatus.ui.realtime')}
                subtitle={t('systemStatus.ui.socket')}
                statusLabel={t(socketPresentation.labelKey)}
                statusColor={socketPresentation.color}
            />
            <ConnectionPopoverStatusRow
                testID="connection-popover-machines"
                icon="laptop"
                title={t('settings.machines')}
                subtitle={machineSubtitle}
                statusLabel={showsMachineGuidance ? t('status.actionRequired') : t(connectionHealth.machineLabelKey)}
                statusColor={machinesPresentation.color}
            />
            {hasIrohTransportDetails ? (
                <ConnectionPopoverStatusRow
                    testID="connection-popover-relay"
                    icon="hard-drives"
                    title={t(irohTransportTitleKey)}
                    subtitle={toServerUrlDisplay(displayServerUrl)}
                    statusLabel={t(relayPresentation.labelKey)}
                    statusColor={relayPresentation.color}
                    onRetry={canRetryRelayConnection ? handleRetry : undefined}
                />
            ) : null}
        </ConnectionDetailsSection>
    );
    // The Homes page's Connection details lead with the Home's live facts and the one repair that applies.
    const homeConnectionSummaryContent = (
        <>
            {homeStatusList}

            {showsMachineGuidance ? (
                <ConnectionPopoverMachineGuidance
                    homeLabel={activeServerLabel}
                    onClose={closePopover}
                />
            ) : null}

            {homeSummary.action !== 'none' || isRetrying ? (
                <View style={styles.popoverActionsRow}>
                    <RoundButton
                        testID="connection-popover-primary-action"
                        title={primaryActionLabel}
                        size="mini"
                        display="secondary"
                        onPress={homeSummary.action === 'restore' ? handleRestoreAccount : handleRetry}
                        accessibilityLabel={primaryActionLabel}
                    />
                </View>
            ) : null}
        </>
    );
    const copyDiagnosticsLabel = diagnosticsCopied
        ? t('connectionStatus.diagnosticsCopied')
        : t('connectionStatus.copyDiagnostics');
    // When it last synced and when it tries again, then the technical facts behind one quiet
    // disclosure (one line each, copied on tap), and Copy diagnostics as the step's last row.
    const detailsBody = (
        <>
            <ConnectionDetailsSection menuSection={menuSections}>
                <LastSyncRow />
                {nextRetryAt ? (
                    <Item
                        testID="connection-popover-next-retry"
                        mode="info"
                        title={t('connectionStatus.labels.nextRetry')}
                        detail={formatTime(nextRetryAt)}
                    />
                ) : null}
                {syncErrorPresentation ? (
                    <Item
                        testID="connection-popover-last-error"
                        mode="info"
                        title={t('connectionStatus.labels.lastError')}
                        subtitle={syncErrorPresentation.message}
                        subtitleLines={2}
                    />
                ) : null}
            </ConnectionDetailsSection>
            <ConnectionDetailsSection menuSection={menuSections}>
                {transportDetailRows.length > 0 ? (
                    <Item
                        testID="connection-details-disclosure"
                        title={t('approvals.technicalDetails')}
                        accessibilityState={{ expanded: detailsExpanded }}
                        onPress={toggleDetails}
                    />
                ) : null}
                {transportDetailRows.length > 0 && detailsExpanded ? transportDetailRows.map((row) => (
                    <Item
                        key={row.key}
                        testID={`connection-transport-${row.key}`}
                        title={row.label}
                        subtitle={row.value}
                        subtitleLines={1}
                        subtitleEllipsizeMode="middle"
                        copy={row.value}
                        showChevron={false}
                    />
                )) : null}
                <Item
                    testID="connection-copy-diagnostics"
                    icon={<Icon name={diagnosticsCopied ? 'check' : 'copy'} size={16} color={theme.colors.text.secondary} />}
                    title={copyDiagnosticsLabel}
                    accessibilityLabel={copyDiagnosticsLabel}
                    onPress={handleCopyDiagnostics}
                    showChevron={false}
                />
            </ConnectionDetailsSection>
        </>
    );

    // A1 · Identity & Homes: the popover's content, and the phone page's.
    const accountContent = (
        <AccountPopoverContent
            step={popoverStep}
            onStepChange={setPopoverStep}
            servers={servers}
            targets={serverTargets}
            activeGroupId={activeGroupId}
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
            retryBusy={isRetrying}
            onRestore={handleRestoreAccount}
            onAddHome={handleOpenAddHome}
            onManageHomes={handleManageRelay}
            onOpenSettings={handleOpenSettings}
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
            {detailsBody}
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
                <HappierPressable
                    controlRef={(node) => { triggerRef.current = node; }}
                    style={[
                        styles.statusContainer,
                        props.variant === 'header' ? null : styles.sidebarStatusContainer,
                    ]}
                    onPress={handleActivate}
                    accessibilityRole="button"
                    accessibilityLabel={`${activeServerLabel}, ${collapsedStatusLabel}`}
                    expanded={open}
                >
                    {collapsedShowsAttentionCue ? (
                        <Icon
                            name="warning"
                            size={dotSize + 4}
                            color={collapsedStatusColor}
                            style={{ marginRight: theme.space.s4 }}
                        />
                    ) : (
                        <StatusDot
                            color={collapsedStatusColor}
                            isPulsing={collapsedStatusIsPulsing}
                            size={dotSize}
                            style={{ marginRight: theme.space.s4 }}
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
                        name={open ? 'caret-up' : 'caret-down'}
                        size={chevronSize}
                        color={collapsedStatusColor}
                        style={styles.statusChevron}
                    />
                </HappierPressable>
                )}
                {open ? (
                    <Popover
                        open={open}
                        anchorRef={anchorRef}
                        focusReturnRef={props.renderTrigger ? hostTriggerFocusRef : triggerRef}
                        autoFocusOnOpen
                        placement={props.popoverPlacement ?? 'bottom'}
                        // On a phone it spans the screen below the head's trigger (owner R2).
                        phonePresentation="panel"
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
