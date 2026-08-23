import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalServiceInventory } from '@/sync/domains/local/services/inventory/useLocalServiceInventory';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { ManagedLocalServicesState } from '@/sync/domains/local/services/managed/store';
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

import type { LocalServicePublicPreviewActions } from './publicPreviewActions';
import type {
    ManagedLocalServiceRestartHandler,
    ManagedLocalServiceStopHandler,
} from './ManagedLocalServiceRow';
import {
    ServiceRowView,
    type ServiceRowCopyUrlHandler,
    type ServiceRowForgetHandler,
    type ServiceRowOpenHandler,
    type ServiceRowStartHandler,
    type ServiceRowTerminateHandler,
} from './ServiceRowView';
import { ServicesScopeToggle, type ServicesScope } from './ServicesScopeToggle';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
        paddingBottom: 16,
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
                        disabled={props.isRefreshing}
                        animationEnabled={props.animationEnabled}
                        onPress={props.onRefresh}
                    />
                </>
            ) : null}
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
    managedState?: ManagedLocalServicesState | null;
    launcherState?: LocalServiceLauncherState | null;
    publicPreviewState?: LocalServicePublicPreviewState | null;
    sessionId?: string | null;
    scope?: ServicesScope;
    onChangeScope?: (scope: ServicesScope) => void;
    onStopManagedService?: ManagedLocalServiceStopHandler;
    onRestartManagedService?: ManagedLocalServiceRestartHandler;
    onStartLauncherTarget?: ServiceRowStartHandler;
    onTerminateDetectedService?: ServiceRowTerminateHandler;
    onForgetDetectedService?: ServiceRowForgetHandler;
    onCopyServiceUrl?: ServiceRowCopyUrlHandler;
    onOpenServiceInBrowser?: ServiceRowOpenHandler;
    publicPreviewActions?: LocalServicePublicPreviewActions;
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
    const viewModel = useLocalServiceInventory({
        inventoryState: props.inventoryState,
        managedState: props.managedState ?? null,
    });
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
        () => selectLocalServiceServiceCounts({ inventoryRows: viewModel.rows, managedRows: viewModel.managedRows }),
        [viewModel.managedRows, viewModel.rows],
    );

    // ONE ranked row model (keep-last-good: memoized on structural inputs only — never
    // folds nowMs/updatedAt into row identity, so unchanged rows keep referential identity).
    const rows = React.useMemo(
        () => buildLocalServiceRows({
            inventoryRows: viewModel.rows,
            managedRows: viewModel.managedRows,
            launchTargets: launcherTargets,
            sessionId: activeSessionId,
            scope,
        }),
        [activeSessionId, launcherTargets, scope, viewModel.managedRows, viewModel.rows],
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
            onStopManagedService={props.onStopManagedService}
            onRestartManagedService={props.onRestartManagedService}
            publicPreviewState={props.publicPreviewState}
            publicPreviewActions={props.publicPreviewActions}
            animationEnabled={animationEnabled}
            testID={`${testID}-row:${row.id}`}
        />
    ), [
        animationEnabled,
        props.onCopyServiceUrl,
        props.onForgetDetectedService,
        props.onOpenServiceInBrowser,
        props.onRestartManagedService,
        props.onStartLauncherTarget,
        props.onStopManagedService,
        props.onTerminateDetectedService,
        props.publicPreviewActions,
        props.publicPreviewState,
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
        <View testID={testID} style={styles.root}>
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
                <ServicesScopeToggle
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
        </View>
    );
}
