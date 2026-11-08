import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { BrowserLaunchpadRow, BrowserLaunchpadSection } from '@/sync/domains/browser/targets';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { selectBrowserTargetAdapter } from '@/sync/domains/browser/adapters/selection';
import { resolveExternalUrlTargetFromInput } from '@/sync/domains/browser/shell';
import type {
    BrowserPlatformV1,
    BrowserProfileV1,
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
    FeatureDecision,
} from '@happier-dev/protocol';
import {
    evaluateBrowserTargetPolicy,
    resolveBrowserTargetProfileUnavailableReason,
} from '@/sync/domains/browser/policy/evaluate';
import { t } from '@/text';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { ServiceRowView } from '@/components/sessions/localServices/ServiceRowView';
import { useLocalServiceEntryActions } from '@/components/sessions/localServices/useLocalServiceEntryActions';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { useUnistyles } from 'react-native-unistyles';

import { BrowserUrlField } from '../BrowserUrlField';
import { useBrowserSessionAgentIdentity, type BrowserShellAgentPresence } from '../copresence/BrowserShellPresence';
import type { BrowserStreamedSurfaceRuntime } from '../adapters/BrowserStreamedTarget';
import type { BrowserSandboxInstallOutcome } from '@/sync/domains/browser/firstUse/browserFirstUse';
import { bindServicesOpenInBrowser, type OpenBrowserViewTarget } from '../surfaces/openBrowserTargetInWorkspace';
import { describeBrowserSandboxAllowance, useBrowserSandboxAllowance } from '../streamed/useBrowserSandboxAllowance';

export type BrowserLaunchpadOpenTargetOptions = Readonly<{
    engineOverride?: import('@/sync/domains/browser/adapters/selection').BrowserOpenEngineOverride;
    platform: BrowserPlatformV1;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>;

/**
 * A running Service preview row opens through the Services preview route (registration, access and
 * the in-place open), the same for a pressed row and for a typed `localhost:PORT` that names it.
 */
export function openLaunchpadServicePreview(
    row: Pick<BrowserLaunchpadRow, 'title'> & Readonly<{ target: Extract<BrowserViewTargetV1, { kind: 'localServicePreview' }> }>,
    deps: Parameters<typeof bindServicesOpenInBrowser>[0],
) {
    return bindServicesOpenInBrowser(deps)({
        id: row.target.targetId,
        source: 'registered_preview',
        machineId: row.target.machineId,
        ...(row.target.sessionId ? { sessionId: row.target.sessionId } : {}),
        title: row.title,
        confidence: 'high',
        state: 'available',
        actions: ['open_preview'],
        browserTarget: row.target,
    });
}

type ResolvedBrowserLaunchpadRow = BrowserLaunchpadRow & Readonly<{
    targetPolicyDecision?: BrowserTargetPolicyDecisionV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
}>;

/**
 * What keeps the agent's own browser from opening, as a typed prerequisite of its Machine. The
 * in-app browser below still works, so this explains the agent's side and never blocks the page.
 */
export type BrowserLaunchpadAgentBrowser = Readonly<{
    reasonCode: 'managed_package_missing' | 'browser_runtime_provisioning_failed' | 'sandbox_unavailable';
    agent: BrowserShellAgentPresence | null;
    onRetry?: () => void;
    /** Allow the sandbox on the Machine; resolves to its outcome, or null when the person declined. */
    onAllowSandbox?: () => Promise<BrowserSandboxInstallOutcome | null>;
}>;

/** The first-use state wins over the discovery prerequisite: it is the more specific, newer fact. */
export function resolveAgentBrowserPrerequisite(
    runtime: Pick<BrowserStreamedSurfaceRuntime, 'firstUse' | 'unavailableReason' | 'onRetry'> | null | undefined,
    agent: BrowserShellAgentPresence | null,
    onAllowSandbox: BrowserLaunchpadAgentBrowser['onAllowSandbox'],
): BrowserLaunchpadAgentBrowser | undefined {
    if (!runtime) return undefined;
    if (runtime.firstUse === 'installFailed') return { reasonCode: 'browser_runtime_provisioning_failed', agent };
    if (runtime.firstUse === 'sandboxUnavailable') return { reasonCode: 'sandbox_unavailable', agent, onAllowSandbox, onRetry: runtime.onRetry };
    return runtime.unavailableReason === 'managed_package_missing'
        ? { reasonCode: runtime.unavailableReason, agent, onRetry: runtime.onRetry }
        : undefined;
}

const SECTION_ORDER: readonly BrowserLaunchpadSection[] = [
    'running',
    'failed',
    'ready',
    'plugin',
    'recent',
    'unavailable',
];

const stylesheet = StyleSheet.create((theme) => ({
    list: {
        backgroundColor: theme.colors.surface.base,
    },
    listContent: {
        paddingBottom: theme.space.s16,
    },
    urlEntry: {
        marginHorizontal: theme.space.s16,
        marginTop: theme.space.s12,
    },
    banner: {
        marginHorizontal: theme.space.s16,
        marginTop: theme.space.s12,
    },
    monoSubtitle: {
        ...Typography.mono(),
    },
    terminalState: {
        // The card owns its own centring; this only gives it something to centre inside when the
        // list is otherwise empty.
        minHeight: 240,
    },
}));

function titleForSection(section: BrowserLaunchpadSection): string {
    switch (section) {
        case 'running':
            return t('browserLaunchpad.sections.running');
        // The workspace's declared Services that are not running: Local services' own section names.
        case 'failed':
            return t('localServices.pane.sectionFailed');
        case 'ready':
            return t('localServices.pane.sectionReady');
        case 'plugin':
            return t('browserLaunchpad.sections.plugin');
        case 'recent':
            return t('browserLaunchpad.sections.recent');
        case 'unavailable':
            return t('browserLaunchpad.sections.unavailable');
    }
}

/**
 * A launchpad row's quiet fact: only a reason when it cannot be opened. An openable row says nothing
 * extra; its section already says what it is (no "Ready to open" repeated down the list, H-UX F-11).
 */
function reasonForRow(row: BrowserLaunchpadRow, openDisabled: boolean): string | undefined {
    if (row.disabledReason) {
        return resolveReasonCopy({ reasonCode: row.disabledReason, kind: 'browserLaunchpad' }).message;
    }
    return openDisabled ? t('browserLaunchpad.status.openUnavailable') : undefined;
}

function rowsBySection(rows: readonly ResolvedBrowserLaunchpadRow[]): ReadonlyMap<BrowserLaunchpadSection, readonly ResolvedBrowserLaunchpadRow[]> {
    const grouped = new Map<BrowserLaunchpadSection, ResolvedBrowserLaunchpadRow[]>();
    for (const row of rows) {
        const group = grouped.get(row.section) ?? [];
        group.push(row);
        grouped.set(row.section, group);
    }
    return grouped;
}

function resolveLaunchpadRow(
    row: BrowserLaunchpadRow,
    platform: BrowserPlatformV1,
    browserProfile: BrowserProfileV1 | null | undefined,
    browserFeatureDecision: FeatureDecision | null | undefined,
    desktopWebViewAvailability: DesktopWebViewNativeAvailability | null | undefined,
    allowExternalUrlBrowsing: boolean,
): ResolvedBrowserLaunchpadRow {
    if (!row.target || row.disabledReason || row.serviceRow) {
        return row;
    }
    if (row.profileMode && browserProfile?.storageMode !== row.profileMode) {
        return {
            ...row,
            disabledReason: 'plugin_browser_profile_mode_unavailable',
        };
    }
    if (row.target.kind === 'externalUrl') {
        const targetPolicyDecision = evaluateBrowserTargetPolicy({
            target: row.target,
            profile: browserProfile,
            browserFeatureDecision,
            allowExternalUrlBrowsing,
        });
        if (targetPolicyDecision.state !== 'allowed') {
            return {
                ...row,
                targetPolicyDecision,
                disabledReason: targetPolicyDecision.reasonCode ?? 'external_url_policy_denied',
            };
        }
        const adapter = selectBrowserTargetAdapter({
            target: row.target,
            platform,
            targetPolicyDecision,
            desktopWebViewAvailability,
        });
        return adapter.ok
            ? {
                ...row,
                targetPolicyDecision,
                desktopWebViewAvailability,
            }
            : {
                ...row,
                targetPolicyDecision,
                desktopWebViewAvailability,
                disabledReason: adapter.reasonCode,
            };
    }
    const policyUnavailableReason = row.target.kind === 'hostedPluginWeb' ? resolveBrowserTargetProfileUnavailableReason({
        target: row.target,
        profile: browserProfile,
    }) : null;
    if (policyUnavailableReason) {
        return {
            ...row,
            disabledReason: policyUnavailableReason,
        };
    }
    const adapter = selectBrowserTargetAdapter({
        target: row.target,
        platform,
    });
    return adapter.ok
        ? row
        : {
            ...row,
            disabledReason: adapter.reasonCode,
        };
}

export function BrowserLaunchpad(props: Readonly<{
    rows: readonly BrowserLaunchpadRow[];
    platform: BrowserPlatformV1;
    browserProfile?: BrowserProfileV1 | null;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    refreshStatus: 'idle' | 'refreshing' | 'error';
    refreshError?: string | null;
    onRefresh?: () => void;
    localServicePreviewServerId?: string | null;
    /**
     * The agent's own browser cannot open yet because its machine lacks the managed Chromium. The
     * in-app browser below still works, so this explains the agent's side and never blocks the page.
     */
    agentBrowser?: BrowserLaunchpadAgentBrowser;
    onOpenTarget?: OpenBrowserViewTarget;
    previewAccountLifetime?: ServerAccountScopeLifetime | null;
    previewCredentialKey?: string;
    /**
     * OWNER-NAV (DV-NAV): the current-tab in-place navigation seam used by the URL entry box. A
     * launchpad/new-tab URL submit turns THIS tab into the page in place instead of spawning a
     * sibling tab. `onOpenTarget` (new tab) stays reserved for external-surface opens.
     */
    onNavigateInPlace?: OpenBrowserViewTarget;
    /**
     * Whether the launchpad draws its own address entry. A host whose chrome already shows an address
     * bar turns it off, so a page never offers two address fields (DA3 D13); the launchpad keeps it
     * where it stands alone (the phone page, the Session viewer).
     */
    urlEntry?: boolean;
    /** The shell's address decision: opens the running Service preview a typed localhost port names. */
    openServicePreviewForAddress?: (url: string) => boolean;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'browser-launchpad';
    const resolvedRows = React.useMemo(
        () => props.rows.map((row) => resolveLaunchpadRow(
            row,
            props.platform,
            props.browserProfile,
            props.browserFeatureDecision,
            props.desktopWebViewAvailability,
            props.allowExternalUrlBrowsing ?? true,
        )),
        [
            props.allowExternalUrlBrowsing,
            props.browserFeatureDecision,
            props.browserProfile,
            props.desktopWebViewAvailability,
            props.platform,
            props.rows,
        ],
    );
    const grouped = React.useMemo(() => rowsBySection(resolvedRows), [resolvedRows]);
    const firstSection = SECTION_ORDER.find((section) => (grouped.get(section)?.length ?? 0) > 0);
    const handleOpenTarget = React.useCallback(async (row: ResolvedBrowserLaunchpadRow) => {
        if (!row.target || row.disabledReason) {
            return;
        }
        const open = row.launchMode === 'currentView'
            ? props.onNavigateInPlace
            : props.onOpenTarget;
        if (row.target.kind === 'localServicePreview') {
            if (!open) return;
            await openLaunchpadServicePreview({ title: row.title, target: row.target }, {
                onOpenTarget: open,
                platform: props.platform,
                serverId: props.localServicePreviewServerId,
                accountLifetime: props.previewAccountLifetime, credentialKey: props.previewCredentialKey,
            });
            return;
        }
        open?.(row.target, {
            platform: props.platform,
            ...(row.currentUrl ? { currentUrl: row.currentUrl } : {}),
            ...(typeof row.currentUrlExpiresAt === 'number' ? { currentUrlExpiresAt: row.currentUrlExpiresAt } : {}),
            ...(row.targetPolicyDecision ? { targetPolicyDecision: row.targetPolicyDecision } : {}),
            ...(row.desktopWebViewAvailability ? { desktopWebViewAvailability: row.desktopWebViewAvailability } : {}),
        });
    }, [props.onNavigateInPlace, props.onOpenTarget, props.platform, props.localServicePreviewServerId,
        props.previewAccountLifetime, props.previewCredentialKey]);

    // Running previews are the Local services rows: they open through the same one-tap Open, which
    // reaches this launchpad's own open seam (a new tab beside this one) with a typed outcome.
    const onOpenTarget = props.onOpenTarget;
    const platform = props.platform;
    const openService = React.useMemo(() => (onOpenTarget
        ? bindServicesOpenInBrowser({ onOpenTarget, platform, serverId: props.localServicePreviewServerId,
            accountLifetime: props.previewAccountLifetime, credentialKey: props.previewCredentialKey })
        : undefined), [onOpenTarget, platform, props.localServicePreviewServerId, props.previewAccountLifetime, props.previewCredentialKey]);
    // One expanded row at a time, as in Local services.
    const [expandedServiceId, setExpandedServiceId] = React.useState<string | null>(null);
    // The Services rows act through the same admission as Local services (Start, Stop, Restart and
    // their reviews), so a declared Service starts from here exactly as it does there.
    const serviceTarget = resolvedRows.find((row) => row.serviceRow)?.serviceRow?.target ?? null;
    const onRefresh = props.onRefresh;
    const refreshServices = React.useMemo(() => onRefresh ? async () => { onRefresh(); } : undefined, [onRefresh]);
    const serviceActions = useLocalServiceEntryActions({
        machineId: serviceTarget?.machineId ?? null,
        serverId: props.localServicePreviewServerId ?? null,
        sessionId: serviceTarget?.sessionId ?? undefined,
        scope: 'workspace',
        onRefresh: refreshServices,
        testID: `${testID}-services`,
    });
    // The same rows as Local services read the same preview-access answer: a service this device
    // can't open privately offers Share a link, not an Open that fails (services lab R).
    const serviceMachineId = serviceTarget?.machineId ?? null;
    const opensPreview = resolvedRows.some((row) => row.serviceRow?.primaryAction?.kind === 'open'
        && row.serviceRow.primaryAction.openTarget.browserTarget?.kind === 'localServicePreview');
    const servicePreviews = useLocalServicePreviewState({ machineId: serviceMachineId, serverId: props.localServicePreviewServerId, enabled: opensPreview });
    const serviceMachineName = useMachinePresenceSummary(props.localServicePreviewServerId ?? null, serviceMachineId).name;
    const { theme } = useUnistyles();
    const recentMark = React.useMemo(
        () => <Icon name="clock-counter-clockwise" size={18} color={theme.colors.text.secondary} />,
        [theme.colors.text.secondary],
    );

    // The URL entry submits a normalized http(s) URL; turning it into a target is the launchpad's
    // job because the seam it delegates to is target-shaped. One normalizer, one target builder.
    const handleSubmitUrl = React.useCallback((url: string) => {
        // The page's one address decision: a running Service preview of a typed localhost port first.
        if (props.openServicePreviewForAddress?.(url) === true) return;
        const target = resolveExternalUrlTargetFromInput(url);
        if (!target) return;
        // Navigate the CURRENT tab in place (turn the new-tab page INTO the page) — never a sibling tab.
        props.onNavigateInPlace?.(target, { platform: props.platform });
    }, [props.openServicePreviewForAddress, props.onNavigateInPlace, props.platform]);

    const hasRows = resolvedRows.length > 0;
    const refreshReason = props.refreshStatus === 'error'
        ? resolveReasonCopy({ reasonCode: props.refreshError, kind: 'browserLaunchpad' })
        : null;

    return (
        <ItemList presentation="grouped"
            testID={testID}
            style={stylesheet.list}
            containerStyle={stylesheet.listContent}
            keyboardShouldPersistTaps="handled"
        >
            {/*
              * The launchpad is a READING surface — a list of names and ports — not a rendered page,
              * so it takes the app's content width instead of the pane's. At 2560px the rows and the
              * URL entry used to stretch edge to edge, which is the widest-viewport defect the
              * capture brief's C1/C4 target. `ConstrainedScreenContent` is the canonical owner and it
              * reads the user's own `uiContentWidthMode`, so this is a preference, not a magic number.
              * The page frame is deliberately NOT constrained: a webview must fill its pane.
              */}
            <ConstrainedScreenContent>
                {props.urlEntry === false ? null : <View style={stylesheet.urlEntry}>
                    <BrowserUrlField
                        testID={`${testID}-url-entry`}
                        density="panel"
                        trailingAction="go"
                        clearOnSubmit
                        value=""
                        disabled={!props.onNavigateInPlace}
                        // No eyebrow above the field (lab W, F-17): the field itself says what it is for.
                        leading={<Icon name="globe" size={17} color={theme.colors.text.tertiary} />}
                        // One placeholder for every address field: the toolbar's (BrowserUrlField's default).
                        accessibilityLabel={t('browserLaunchpad.urlEntry.label')}
                        onSubmitUrl={handleSubmitUrl}
                    />
                </View>}

                {props.agentBrowser && hasRows ? (
                    <AgentBrowserPrerequisite testID={`${testID}-agent-browser`} {...props.agentBrowser} />
                ) : null}

                {!hasRows ? (
                    <View style={stylesheet.terminalState}>
                        {props.agentBrowser ? (
                            <AgentBrowserPrerequisite testID={`${testID}-agent-browser`} {...props.agentBrowser} />
                        ) : props.refreshStatus === 'refreshing' ? (
                            <SurfaceStateCard
                                testID={`${testID}-refreshing`}
                                kind="loading"
                                title={t('browserLaunchpad.refreshing')}
                                accessibilitySemantics="status"
                            />
                        ) : props.refreshStatus === 'error' ? (
                            <SurfaceStateCard
                                testID={`${testID}-error`}
                                kind="error"
                                title={t('browserLaunchpad.error.title')}
                                reason={refreshReason?.body}
                                action={props.onRefresh ? { label: t('common.retry'), onPress: props.onRefresh } : undefined}
                                // The refresh code is a diagnostic, never product copy: it stays behind Details.
                                {...(props.refreshError ? { diagnosticCode: props.refreshError } : {})}
                                accessibilitySemantics="alert"
                            />
                        ) : (
                            <SurfaceStateCard
                                testID={`${testID}-guidance`}
                                kind="empty"
                                iconName="globe"
                                title={t('browserLaunchpad.guidance.title')}
                                reason={t('browserLaunchpad.guidance.body')}
                            />
                        )}
                    </View>
                ) : (
                    <>
                        {props.refreshStatus !== 'idle' ? (
                            <View style={stylesheet.banner}>
                                <ItemGroup>
                                    <BrowserLaunchpadRefreshBanner
                                        testID={testID}
                                        status={props.refreshStatus}
                                        reason={refreshReason?.body}
                                        onRefresh={props.onRefresh}
                                    />
                                </ItemGroup>
                            </View>
                        ) : null}
                        {SECTION_ORDER.map((section) => {
                            const rows = grouped.get(section) ?? [];
                            if (rows.length === 0) {
                                return null;
                            }
                            return (
                                <React.Fragment key={section}>
                                {/* The same group label as Local services (lab Lp): what the rows share, and how many. */}
                                <CollectionListGroupLabel
                                    testID={`${testID}-section-${section}-label`}
                                    title={titleForSection(section)}
                                    count={rows.length}
                                    countPlacement="title"
                                    first={section === firstSection && props.refreshStatus === 'idle'}
                                />
                                <ItemGroup
                                    header="none"
                                    accessibilityLabel={titleForSection(section)}
                                    selectableItemCountOverride={rows.length}
                                >
                                    {rows.map((row) => {
                                        if (row.serviceRow) {
                                            const serviceRowId = row.serviceRow.id;
                                            return (
                                                <ServiceRowView
                                                    key={row.id}
                                                    row={row.serviceRow}
                                                    {...serviceActions.handlers}
                                                    onOpenServiceInBrowser={openService}
                                                    previews={row.serviceRow.target.machineId === serviceMachineId ? servicePreviews : null}
                                                    machineName={row.serviceRow.target.machineId === serviceMachineId ? serviceMachineName : null}
                                                    expanded={expandedServiceId === serviceRowId}
                                                    onExpandedChange={(next) => setExpandedServiceId(next ? serviceRowId : null)}
                                                    testID={`${testID}-service:${serviceRowId}`}
                                                />
                                            );
                                        }
                                        const openDisabled = row.launchMode === 'currentView'
                                            ? !props.onNavigateInPlace
                                            : !props.onOpenTarget;
                                        const disabled = Boolean(openDisabled || row.disabledReason || !row.target);
                                        return (
                                            <Item
                                                key={row.id}
                                                testID={`${testID}-card:${row.id}`}
                                                title={row.title}
                                                subtitle={row.subtitle}
                                                subtitleStyle={row.sourceKind === 'recent' ? stylesheet.monoSubtitle : undefined}
                                                icon={row.sourceKind === 'recent' ? recentMark : undefined}
                                                detail={reasonForRow(row, openDisabled)}
                                                detailTestID={disabled ? `${testID}-card:${row.id}-disabled` : `${testID}-card:${row.id}-available`}
                                                disabled={disabled}
                                                mode="interactive"
                                                showChevron={!disabled}
                                                onPress={() => {
                                                    if (!disabled) return handleOpenTarget(row);
                                                }}
                                            />
                                        );
                                    })}
                                </ItemGroup>
                                </React.Fragment>
                            );
                        })}
                    </>
                )}
            </ConstrainedScreenContent>
            {serviceActions.review}
        </ItemList>
    );
}

/**
 * Why the agent's browser has nothing to show: a prerequisite state, in the same card anatomy as the
 * other unavailable browser states. The cause is the shared reason copy; the code stays behind Details.
 */
function AgentBrowserPrerequisite(props: BrowserLaunchpadAgentBrowser & Readonly<{ testID: string }>): React.ReactElement {
    const identity = useBrowserSessionAgentIdentity(props.agent);
    const reason = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'browserLaunchpad' });
    if (props.reasonCode === 'sandbox_unavailable') {
        return (
            <BrowserSandboxPrerequisite
                testID={props.testID}
                agentName={identity.name}
                reason={reason}
                onAllowSandbox={props.onAllowSandbox}
            />
        );
    }
    // A failed install is not a prerequisite to re-check: the retry is a new explicit open. A missing
    // Chromium downloads on the first open too, so opening an address is its one action: a re-check
    // button beside that sentence would not say what it does.
    const installFailed = props.reasonCode === 'browser_runtime_provisioning_failed';
    const offersRecheck = !installFailed && props.reasonCode !== 'managed_package_missing';
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind={installFailed ? 'error' : 'unavailable'}
            iconName={installFailed ? undefined : 'browsers'}
            title={installFailed ? t('browserPresence.stream.installFailedTitle') : t('browserPresence.stream.setupTitle', { agent: identity.name })}
            reason={reason.body}
            diagnosticCode={reason.diagnosticCode}
            action={offersRecheck && props.onRetry ? { label: t('browserPresence.stream.tryAgain'), onPress: props.onRetry } : undefined}
            accessibilitySemantics={installFailed ? 'alert' : 'status'}
        />
    );
}

/**
 * The managed Chromium is installed but this Machine's security policy blocks its sandbox. One primary
 * action asks the Machine to allow it (never to run without one); the card then tells what happened.
 */
function BrowserSandboxPrerequisite(props: Readonly<{
    testID: string;
    agentName: string;
    reason: ReturnType<typeof resolveReasonCopy>;
    onAllowSandbox?: () => Promise<BrowserSandboxInstallOutcome | null>;
}>): React.ReactElement {
    const { allowance, allow } = useBrowserSandboxAllowance(props.onAllowSandbox);
    const action = allow
        ? { label: t('browserPresence.stream.sandboxAllow'), onPress: allow, busy: allowance.kind === 'working',
            testID: `${props.testID}-allow-sandbox` }
        : undefined;
    if (allowance.kind === 'settled') {
        const settled = describeBrowserSandboxAllowance(allowance.outcome, props.agentName);
        return (
            <SurfaceStateCard
                testID={props.testID}
                kind={settled.kind}
                title={settled.title}
                reason={settled.reason}
                diagnosticCode={settled.code || undefined}
                action={settled.kind === 'success' ? undefined : action}
                accessibilitySemantics={settled.kind === 'success' ? 'status' : 'alert'}
            />
        );
    }
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind="unavailable"
            iconName="shield"
            title={t('browserPresence.stream.setupTitle', { agent: props.agentName })}
            reason={props.reason.body}
            diagnosticCode={props.reason.diagnosticCode}
            action={action}
            accessibilitySemantics="status"
        />
    );
}

/**
 * The refresh state WHILE rows are already on screen. It is an informational banner rather than a
 * {@link SurfaceStateCard} on purpose: the pane is not in a terminal state, and replacing live rows
 * with a card would flash away hydrated content the user is reading (`apps/ui/AGENTS.md`
 * "Preserve last-known-good UI during refresh").
 */
function BrowserLaunchpadRefreshBanner(props: Readonly<{
    testID: string;
    status: 'refreshing' | 'error';
    reason?: string;
    onRefresh?: () => void;
}>): React.ReactElement {
    if (props.status === 'refreshing') {
        return (
            <Item
                testID={`${props.testID}-refreshing`}
                title={t('browserLaunchpad.refreshing')}
                mode="info"
                showChevron={false}
            />
        );
    }
    return (
        <Item
            testID={`${props.testID}-error`}
            title={t('browserLaunchpad.error.title')}
            subtitle={props.reason}
            rightElement={props.onRefresh ? <RoundButton
                testID={`${props.testID}-error-action`}
                title={t('common.retry')}
                onPress={props.onRefresh}
                size="small"
                display="secondary"
            /> : undefined}
            mode="info"
            showChevron={false}
        />
    );
}
