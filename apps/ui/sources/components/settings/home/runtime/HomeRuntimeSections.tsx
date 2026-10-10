import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { HomeAdministrationContext } from '@/components/settings/home/governance/homeAdministrationContext';
import { homeAdministrationRuntimePath } from '@/components/settings/home/governance/homeAdministrationRoutes';
import { PersonalHomeRuntimeControlSection } from '@/components/settings/server/localControl/PersonalHomeRuntimeControlSection';
import { usePersonalHomeRuntimeOperations } from '@/components/settings/server/localControl/usePersonalHomeRuntimeOperations';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { useSocketStatus } from '@/sync/domains/state/storage';
import { getAppliedActiveServerId } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';

import {
    homeRuntimeExecutorCanAct,
    restartHomeRuntime,
    useHomeRuntimeExecutor,
    type HomeRuntimeExecutor,
} from './homeRuntimeExecutor';

/** The running server's version and flavour, as the Home itself publishes them (`capabilities.server`). */
export type HomeServerRelease = Readonly<{ version: string | null; flavor: 'light' | 'full' | null }>;

export function useHomeServerRelease(serverId: string, enabled: boolean): HomeServerRelease {
    const snapshot = useServerFeaturesSnapshotForServerId(serverId, { enabled });
    const server = snapshot.status === 'ready' ? snapshot.features.capabilities.serverRelease : null;
    return React.useMemo(
        () => ({ version: server?.version ?? null, flavor: server?.flavor ?? null }),
        [server?.version, server?.flavor],
    );
}

/** Stored restart values the running server has not applied yet (from the startup snapshot only). */
export function countPendingRestartChanges(settings: HomeSettingsProjectionV1 | null): number {
    return settings?.entries.filter((entry) => entry.applied?.pending === true).length ?? 0;
}

function managedElsewhereCopy(executor: HomeRuntimeExecutor): Readonly<{ title: string; body: string }> {
    switch (executor.kind) {
        case 'deployment':
            return { title: t('homeGovernance.runtime.deploymentTitle'), body: t('homeGovernance.runtime.deploymentBody') };
        case 'elsewhere':
        case 'connected_machine':
        case 'remote_host':
            return executor.hostName
                ? { title: t('homeGovernance.runtime.managedFrom', { host: executor.hostName }), body: t('homeGovernance.runtime.managedFromBody') }
                : { title: t('homeGovernance.runtime.managedElsewhere'), body: t('homeGovernance.runtime.managedFromBody') };
        case 'hosting_desktop':
            return { title: '', body: '' };
    }
}

type RestartObservation = {
    waiting: boolean;
    connected: boolean;
    refreshStarted: boolean;
    finished: boolean;
    refresh: () => void;
    reload?: () => void | Promise<void>;
};

/**
 * Every restart control consumes the executor and the existing exact-Home connection wake: the
 * Runtime pair, the restart banner of a settings page, and Overview's attention row.
 */
export function useHomeRuntimeRestart(
    context: HomeAdministrationContext,
    executor: HomeRuntimeExecutor,
    onRestarted?: () => void | Promise<void>,
) {
    const secretMaterialAllowed = useFeatureEnabled('remoteHosts.secretMaterial');
    const socket = useSocketStatus();
    const [restarting, setRestarting] = React.useState(false);
    const [waitingForHome, setWaitingForHome] = React.useState(false);
    const current = React.useRef<RestartObservation | null>(null);
    const previousSocket = React.useRef(socket);
    const serverId = context.scope.serverId;
    const accountId = context.scope.accountId;

    React.useEffect(() => {
        current.current = null;
        setRestarting(false);
        setWaitingForHome(false);
        return () => { current.current = null; };
    }, [serverId, accountId]);

    const refreshOnce = React.useCallback(async (observation: RestartObservation) => {
        if (current.current !== observation || observation.refreshStarted) return;
        observation.refreshStarted = true;
        try {
            observation.refresh();
            await observation.reload?.();
        } finally {
            if (current.current === observation) {
                observation.finished = true;
                setWaitingForHome(false);
                setRestarting(false);
            }
        }
    }, []);

    const connected = React.useCallback(() => {
        const observation = current.current;
        if (!observation || observation.finished) return;
        observation.connected = true;
        if (observation.waiting) void refreshOnce(observation);
    }, [refreshOnce]);

    React.useEffect(() => {
        const previous = previousSocket.current;
        previousSocket.current = socket;
        if (socket.status === 'connected'
            && (previous.status !== 'connected' || previous.lastConnectedAt !== socket.lastConnectedAt)
            && getAppliedActiveServerId() === serverId) connected();
    }, [socket, serverId, connected]);

    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (event.serverId === serverId && event.source === 'connected') connected();
    }), [serverId, connected]);

    const restart = React.useCallback(async () => {
        if (current.current && !current.current.finished) return;
        const observation: RestartObservation = {
            waiting: false, connected: false, refreshStarted: false, finished: false,
            refresh: context.refresh, reload: onRestarted,
        };
        current.current = observation;
        setRestarting(true);
        const waitForHome = () => {
            if (current.current !== observation || observation.finished) return;
            observation.waiting = true;
            setWaitingForHome(true);
            // The connection may have returned before the initial admission ACK was lost.
            if (observation.connected) void refreshOnce(observation);
        };
        const outcome = await restartHomeRuntime(executor, {
            serverId, secretMaterialAllowed, onApprovalPending: context.requestApproval,
            onAdmitted: waitForHome,
        });
        if (current.current !== observation) return;
        if (outcome.kind === 'restarted') {
            await refreshOnce(observation);
        } else if (outcome.kind === 'outcome_unknown') {
            waitForHome();
        } else {
            observation.finished = true;
            setWaitingForHome(false);
            setRestarting(false);
            if (outcome.kind === 'failed') {
                await Modal.alertAsync(t('homeGovernance.runtime.restartFailed'), outcome.message ?? t('errors.operationFailed'));
            }
        }
    }, [serverId, context.refresh, context.requestApproval, executor, onRestarted, secretMaterialAllowed, refreshOnce]);

    return { restart, restarting, waitingForHome };
}

export type HomeRuntimeRestartState = ReturnType<typeof useHomeRuntimeRestart>;

/**
 * "Restart now" as every surface offers it: only to an owner whose device has an executor for the
 * runtime, busy for as long as the one restart operation runs. `null` where this device cannot act.
 */
export function restartNowAction(
    context: HomeAdministrationContext,
    executor: HomeRuntimeExecutor,
    state: HomeRuntimeRestartState,
): Readonly<{ label: string; onPress: () => void; loading: boolean; disabled: boolean }> | null {
    if (!homeRuntimeExecutorCanAct(executor) || !context.projection.capabilities.manageHomeSettings) return null;
    return {
        label: t('homeGovernance.runtime.restartNow'),
        onPress: () => { void state.restart(); },
        loading: state.restarting,
        disabled: state.restarting || !context.mutationsAvailable,
    };
}

/**
 * "n changes apply after restart" with Restart now (plan §3.14): offered only when changes are
 * pending AND this device has an executor for the runtime; otherwise the banner says where the
 * restart happens. The one restart path is `restartHomeRuntime`. Server settings mounts it too.
 */
type HomeRestartNowBannerProps = Readonly<{
    context: HomeAdministrationContext;
    executor: HomeRuntimeExecutor;
    pendingCount: number;
    /** The pending settings by name, said before where the restart happens (Server settings). */
    pendingSummary?: string;
    /**
     * Discard (§3.14 r3): offered beside Restart now, or as the banner's own action when this device
     * cannot restart the runtime. Owners only.
     */
    discard?: Readonly<{ onPress: () => void; loading: boolean }>;
    onRestarted?: () => void | Promise<void>;
}>;

export const HomeRestartNowBanner = React.memo(function HomeRestartNowBanner(props: HomeRestartNowBannerProps) {
    const restartState = useHomeRuntimeRestart(props.context, props.executor, props.onRestarted);
    return <HomeRestartNowBannerContent {...props} restartState={restartState} />;
});

function HomeRestartNowBannerContent(props: HomeRestartNowBannerProps & Readonly<{
    restartState: HomeRuntimeRestartState;
}>) {
    const { context, executor, pendingCount, discard } = props;
    const { restarting, waitingForHome } = props.restartState;
    if (pendingCount === 0 && !restarting) return null;
    const where = executor.kind === 'deployment'
        ? t('homeGovernance.runtime.restartFromDeployment')
        : executor.kind === 'hosting_desktop' || executor.kind === 'remote_host' || executor.kind === 'connected_machine'
            ? t('homeGovernance.runtime.restartToApply')
            : executor.hostName
                ? t('homeGovernance.runtime.restartFromHost', { host: executor.hostName })
                : t('homeGovernance.runtime.restartFromHostingComputer');
    const canDiscard = discard !== undefined && context.projection.capabilities.manageHomeSettings;
    const discardAction = canDiscard
        ? {
            label: t('homeSettings.banner.discard'),
            testID: 'home-runtime-pending-restart.discard',
            onPress: discard.onPress,
            loading: discard.loading,
            disabled: restarting || !context.mutationsAvailable,
        }
        : null;
    // Restart now is the banner's action with Discard beside it (lab `hcSignin-RS`); a device that
    // cannot restart the runtime offers Discard alone.
    const restartAction = restartNowAction(context, executor, props.restartState);
    return (
        <AttentionBanner
            testID="home-runtime-pending-restart"
            title={t('homeGovernance.runtime.pendingRestart', { count: pendingCount })}
            description={waitingForHome ? t('homeGovernance.runtime.waitingForHome') : props.pendingSummary ? `${props.pendingSummary} ${where}` : where}
            tone={restarting ? 'neutral' : 'warning'}
            accessibilityLiveRegion="polite"
            action={restartAction ?? discardAction}
            secondaryAction={restartAction ? discardAction : null}
        />
    );
}

/**
 * Overview's "n changes apply after restart" row (lab `hcOverview-R`): amber, naming what waits, with
 * Restart now where this device can restart the runtime — the same `useHomeRuntimeRestart` operation
 * the banner and Runtime run — and the way to Runtime, which says where, everywhere else.
 */
export const HomePendingRestartAttentionRow = React.memo(function HomePendingRestartAttentionRow(props: Readonly<{
    testID: string;
    context: HomeAdministrationContext;
    executor: HomeRuntimeExecutor;
    pendingCount: number;
    pendingSummary: string;
    onRestarted?: () => void | Promise<void>;
    /** Opens Runtime, for a viewer or device that cannot restart from here. */
    onReview: () => void;
}>) {
    const { theme } = useUnistyles();
    const restartState = useHomeRuntimeRestart(props.context, props.executor, props.onRestarted);
    const restartAction = restartNowAction(props.context, props.executor, restartState);
    return (
        <Item
            testID={props.testID}
            icon={<Icon name="arrow-clockwise" color={theme.colors.state.warning.foreground} />}
            title={t('homeGovernance.runtime.pendingRestart', { count: props.pendingCount })}
            titleLines={0}
            subtitle={restartState.waitingForHome ? t('homeGovernance.runtime.waitingForHome') : props.pendingSummary}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={(
                <RoundButton
                    testID={`${props.testID}.action`}
                    size="small"
                    display="secondary"
                    title={restartAction?.label ?? t('homeGovernance.overviewPage.review')}
                    loading={restartAction?.loading}
                    disabled={restartAction?.disabled}
                    onPress={restartAction?.onPress ?? props.onReview}
                />
            )}
        />
    );
});

/** The server that runs this Home: its release, and the controls of whoever can act on it. */
type HomeRuntimeSectionProps = Readonly<{
    context: HomeAdministrationContext;
    release: HomeServerRelease;
    executor: HomeRuntimeExecutor;
    onRestarted?: () => void | Promise<void>;
}>;

export const HomeRuntimeSection = React.memo(function HomeRuntimeSection(props: HomeRuntimeSectionProps) {
    const restartState = useHomeRuntimeRestart(props.context, props.executor, props.onRestarted);
    return <HomeRuntimeSectionContent {...props} restartState={restartState} />;
});

function HomeRuntimeSectionContent(props: HomeRuntimeSectionProps & Readonly<{
    restartState: HomeRuntimeRestartState;
}>) {
    const { context, release, executor } = props;
    const { restart, restarting, waitingForHome } = props.restartState;
    const canAct = homeRuntimeExecutorCanAct(executor) && context.projection.capabilities.manageHomeSettings;
    const flavorLabel = release.flavor === 'full'
        ? t('homeGovernance.runtime.flavorFull')
        : release.flavor === 'light'
            ? t('homeGovernance.runtime.flavorLight')
            : null;
    const elsewhere = managedElsewhereCopy(executor);
    return (
        <>
            <ItemGroup title={t('homeGovernance.runtime.version')}>
                <Item
                    testID="home-runtime-version"
                    title={release.version ? t('homeGovernance.runtime.versionValue', { version: release.version }) : t('homeGovernance.runtime.versionUnknown')}
                    subtitle={flavorLabel ?? undefined}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
            {executor.kind === 'hosting_desktop' ? null : (
                <ItemGroup title={t('homeGovernance.runtime.server')}>
                    <Item
                        testID={`home-runtime-managed:${executor.kind}`}
                        title={elsewhere.title}
                        subtitle={waitingForHome ? t('homeGovernance.runtime.waitingForHome') : elsewhere.body}
                        subtitleLines={0}
                        mode={canAct ? undefined : 'info'}
                        showChevron={false}
                        rightElement={canAct ? (
                            <RoundButton
                                testID="home-runtime-restart"
                                size="small"
                                display="inverted"
                                title={t('homeGovernance.runtime.restart')}
                                loading={restarting}
                                disabled={restarting || !context.mutationsAvailable}
                                onPress={() => { void restart(); }}
                            />
                        ) : undefined}
                    />
                </ItemGroup>
            )}
        </>
    );
}

/** The Runtime page's two controls share one restart operation and reconnect observation. */
export const HomeRuntimeRestartSections = React.memo(function HomeRuntimeRestartSections(
    props: HomeRuntimeSectionProps & Readonly<{ pendingCount: number }>,
) {
    const restartState = useHomeRuntimeRestart(props.context, props.executor, props.onRestarted);
    return (
        <>
            <HomeRestartNowBannerContent {...props} restartState={restartState} />
            <HomeRuntimeSectionContent {...props} restartState={restartState} />
        </>
    );
});

/**
 * The hosting desktop's own controls for its Personal Home — status, backups, restore, move,
 * search repair, logs, uninstall and erase — rendered once, with the same hook and operations the
 * Homes page used to host (Lane 07 §15.3 placement, AM-3).
 */
export const HostedPersonalHomeRuntimeSection = React.memo(function HostedPersonalHomeRuntimeSection() {
    const { personalHomeProfile, operations } = usePersonalHomeRuntimeOperations();
    return (
        <PersonalHomeRuntimeControlSection
            operations={operations}
            {...(personalHomeProfile ? { homeLabel: resolveHomeDisplayLabel(personalHomeProfile, personalHomeProfile.id) } : {})}
        />
    );
});

/**
 * Backups on the Data page (lab `hcData-*`), executor-selected: the hosting desktop runs them from
 * the runtime controls; elsewhere the section names where backups are made; a full-flavour Home's
 * backups belong to its deployment.
 */
export const HomeBackupsSection = React.memo(function HomeBackupsSection(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const router = useRouter();
    const release = useHomeServerRelease(context.scope.serverId, context.projection.capabilities.viewAdministration);
    const executor = useHomeRuntimeExecutor(context.scope.serverId, release.flavor);
    const subtitle = executor.kind === 'deployment'
        ? t('homeGovernance.runtime.backupsDeployment')
        : executor.kind === 'hosting_desktop'
            ? t('homeGovernance.runtime.backupsHere')
            : executor.hostName
                ? t('homeGovernance.runtime.backupsFromHost', { host: executor.hostName })
                : t('homeGovernance.runtime.backupsFromHostingComputer');
    return (
        <ItemGroup title={t('homeGovernance.runtime.backups')}>
            <Item
                testID={`home-data-backups:${executor.kind}`}
                icon={executor.kind === 'hosting_desktop' ? <Icon name="hard-drives" /> : undefined}
                title={t('homeGovernance.runtime.backups')}
                subtitle={subtitle}
                subtitleLines={0}
                mode={executor.kind === 'hosting_desktop' ? undefined : 'info'}
                showChevron={executor.kind === 'hosting_desktop'}
                {...(executor.kind === 'hosting_desktop'
                    ? { onPress: () => router.push(homeAdministrationRuntimePath(context.scope.serverId)) }
                    : {})}
            />
        </ItemGroup>
    );
});
