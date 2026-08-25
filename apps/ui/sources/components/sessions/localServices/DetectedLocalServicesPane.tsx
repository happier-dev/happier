import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalServiceInventory } from '@/sync/domains/local/services/inventory/useLocalServiceInventory';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import {
    createLocalServiceLauncherState,
    selectLocalServiceLaunchTargets,
    type LocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import {
    readLocalServiceDiagnostics,
    selectLocalServiceServiceCounts,
} from '@/sync/domains/local/services/presentation';
import { buildLocalServiceRows, type ServiceRow, type ServiceRowScope } from '@/sync/domains/local/services/serviceRow';
import type { LocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import type { TranslationKey } from '@/text/i18n';

import { LocalServicePublicPreviewControls } from './LocalServicePublicPreviewControls';
import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import type { LocalServiceCapabilityDisabledReasons } from './useLocalServicePublicPreviewFeature';
import {
    ServiceRowView,
    type ServiceRowCopyUrlHandler,
    type ServiceRowForgetHandler,
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
    scopeToggle: {
        marginHorizontal: 16,
        marginBottom: 8,
    },
    banner: {
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    bannerText: {
        color: theme.colors.text.secondary,
    },
    countBadge: {
        marginHorizontal: 16,
        marginTop: 12,
        marginBottom: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    countBadgeSpacer: {
        flex: 1,
    },
    countBadgeText: {
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
}));

const BAND_TITLE_KEYS: Readonly<Record<ServiceRowScope, TranslationKey>> = {
    thisSession: 'localServices.session.thisSessionTitle',
    workspace: 'localServices.session.workspaceTitle',
    machine: 'localServices.band.machine',
    suggestion: 'localServices.band.suggestions',
};

const BAND_ORDER: readonly ServiceRowScope[] = ['thisSession', 'workspace', 'machine', 'suggestion'];

function ServiceCountBadge(props: Readonly<{
    total: number;
    running: number;
    isRefreshing: boolean;
    onRefresh?: (() => void) | undefined;
    animationEnabled?: boolean;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View testID={props.testID} style={styles.countBadge}>
            <Text style={styles.countBadgeText}>
                {t('localServices.inventory.countBadge', { total: String(props.total), running: String(props.running) })}
            </Text>
            {props.onRefresh ? (
                <>
                    <View style={styles.countBadgeSpacer} />
                    <IconButton
                        testID={`${props.testID}-refresh`}
                        iconName="arrow-clockwise"
                        accessibilityLabel={t('common.refresh')}
                        tooltip={t('common.refresh')}
                        size={28}
                        iconSize={14}
                        variant="plain"
                        // The drawn 28px square stays — it is the right visual weight beside a
                        // count label — while the press box grows to the platform floor. The
                        // primitive owns the frame as real box model; never `hitSlop`, which
                        // react-native-web ignores and the desktop app IS the web bundle.
                        minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                        disabled={props.isRefreshing}
                        animationEnabled={props.animationEnabled}
                        onPress={props.onRefresh}
                    />
                </>
            ) : null}
        </View>
    );
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
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const tabs = React.useMemo(() => ([
        { id: 'workspace' as const, label: t('localServices.scope.workspace') },
        { id: 'machine' as const, label: t('localServices.scope.machine') },
    ]), []);
    return (
        <View style={styles.scopeToggle}>
            <SegmentedTabBar
                tabs={tabs}
                activeTabId={props.scope}
                onSelectTab={props.onChangeScope}
                accessibilityLabel={t('localServices.scope.toggleA11y')}
                testIDPrefix={props.testID}
                segmentSizing="content"
                slidingThumb
                compact
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
        <View testID={props.testID} style={styles.banner}>
            {diagnostics.map((diagnostic) => {
                // Scan diagnostics are scan-level facts, not per-service failures: render the ONE
                // neutral product line via the OWNER-COPY mapper and keep the raw scan code on the
                // diagnostics-only testID + accessibility hint — never in visible text.
                const copy = resolveReasonCopy({ reasonCode: diagnostic.code, kind: 'localServiceInventory' });
                return (
                    <Text
                        key={diagnostic.code}
                        testID={`${props.testID}-code-${diagnostic.code}`}
                        accessibilityHint={copy.diagnosticCode ?? undefined}
                        style={styles.bannerText}
                    >
                        {copy.body}
                    </Text>
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
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onForgetDetectedService?: ServiceRowForgetHandler;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    publicPreviewActions?: LocalServicePublicPreviewActions;
    publicPreviewCapabilityDisabledReasons?: LocalServiceCapabilityDisabledReasons;
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

    const counts = React.useMemo(
        () => selectLocalServiceServiceCounts({ inventoryRows: viewModel.rows }),
        [viewModel.rows],
    );

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

    const bands = React.useMemo(() => {
        const grouped = new Map<ServiceRowScope, ServiceRow[]>();
        for (const row of rows) {
            const band = grouped.get(row.scope) ?? [];
            band.push(row);
            grouped.set(row.scope, band);
        }
        return BAND_ORDER
            .map((band) => ({ band, rows: grouped.get(band) ?? [] }))
            .filter((entry) => entry.rows.length > 0);
    }, [rows]);

    const renderRow = React.useCallback((row: ServiceRow) => (
        <ServiceRowView
            key={row.id}
            row={row}
            onOpenServiceInBrowser={props.onOpenServiceInBrowser}
            onStartLauncherTarget={props.onStartLauncherTarget}
            onTerminateDetectedService={props.onTerminateDetectedService}
            onForgetDetectedService={props.onForgetDetectedService}
            onCopyServiceUrl={props.onCopyServiceUrl}
            animationEnabled={animationEnabled}
            testID={`${testID}-row:${row.id}`}
        />
    ), [
        animationEnabled,
        props.onCopyServiceUrl,
        props.onForgetDetectedService,
        props.onOpenServiceInBrowser,
        props.onStartLauncherTarget,
        props.onTerminateDetectedService,
        testID,
    ]);

    const hasRows = rows.length > 0;

    if (viewModel.status === 'loading' && !hasLauncherTargets) {
        return (
            <SurfaceStateCard
                testID={`${testID}-loading`}
                kind="loading"
                title={t('localServices.inventory.loadingTitle')}
                animationEnabled={animationEnabled}
            />
        );
    }

    if (viewModel.status === 'empty' && !hasLauncherTargets) {
        return (
            <SurfaceStateCard
                testID={`${testID}-empty`}
                kind="empty"
                title={t('localServices.inventory.emptyTitle')}
                {...(props.onRefresh
                    ? { action: { label: t('common.refresh'), onPress: props.onRefresh } }
                    : {})}
            />
        );
    }

    if (viewModel.status === 'error' && !hasLauncherTargets) {
        const diagnosticCopy = firstInventoryDiagnosticCopy(viewModel.diagnostics);
        // G16: a failed first read used to be terminal. The card's own primary-action slot is the
        // retry, so the failure recovers through the same invalidation the refresh control uses.
        return (
            <SurfaceStateCard
                testID={`${testID}-error`}
                kind="error"
                title={t('localServices.inventory.errorTitle')}
                diagnosticCode={diagnosticCopy?.diagnosticCode}
                {...(props.onRefresh
                    ? { action: { label: t('common.retry'), onPress: props.onRefresh } }
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
                <DiagnosticsBanner diagnostics={viewModel.diagnostics} testID={`${testID}-error`} />
                {counts.total > 0 ? (
                    <ServiceCountBadge
                        total={counts.total}
                        running={counts.running}
                        isRefreshing={viewModel.isRefreshing}
                        onRefresh={props.onRefresh}
                        animationEnabled={animationEnabled}
                        testID={`${testID}-count-badge`}
                    />
                ) : null}
                {props.onChangeScope ? (
                    <ServicesScopeBar
                        scope={scope}
                        onChangeScope={props.onChangeScope}
                        testID={`${testID}-scope-toggle`}
                    />
                ) : null}
                {hasRows
                    ? bands.map((entry) => (
                        <View key={entry.band} testID={`${testID}-band-${entry.band}`}>
                            <ItemGroup
                                title={t(BAND_TITLE_KEYS[entry.band])}
                                selectableItemCountOverride={entry.rows.length}
                            >
                                {entry.rows.map(renderRow)}
                            </ItemGroup>
                        </View>
                    ))
                    : (
                        <SurfaceStateCard
                            testID={`${testID}-launcher-unavailable`}
                            kind="unavailable"
                            title={t('common.unavailable')}
                            reason={t('localServices.launcher.status.unavailableGeneric')}
                        />
                    )}
                {/*
                  * ONE public-preview group for the whole pane (U-10). It used to be mounted inside
                  * every qualifying service row, which repeated the group heading down the list,
                  * nested a group inside a band group, and made `activeExposureCount` rescan the
                  * entire exposure set once per row. Exposure is a pane-level concern — the user
                  * asks "what of mine is public right now", not "is this row public".
                  */}
                <LocalServicePublicPreviewControls
                    launchTargets={launcherTargets}
                    state={props.publicPreviewState}
                    actions={props.publicPreviewActions}
                    capabilityDisabledReasons={props.publicPreviewCapabilityDisabledReasons}
                    testID={`${testID}-public-preview`}
                />
            </ConstrainedScreenContent>
        </ScrollView>
    );
}
