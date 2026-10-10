import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { ConnectionPopoverMachineGuidance } from '@/components/navigation/connectionStatus/ConnectionPopoverMachineGuidance';
import {
    resolveHomeTargetSummary,
    type HomeConnectionSummary,
} from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import type { MachineConnectionSummary } from '@/components/navigation/connectionStatus/resolveMachineConnectionSummary';
import { AccountServiceMark } from '@/components/settings/account/AccountServiceMark';
import { ThisComputerServersMenuSection } from '@/components/settings/machines/localControl/ThisComputerServersMenuSection';
import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Icon } from '@/components/ui/icons/Icon';
import { HomeMark } from '@/components/homes/HomeMark';
import { ActionListSection, type ActionListItem } from '@/components/ui/lists/ActionListSection';
import type { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useHomeViewSelectionSettingsMutable } from '@/hooks/server/useHomeViewSelectionSettings';
import { resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { getAvatarUrl, getDisplayName } from '@/sync/domains/profiles/profile';
import { buildServerSelectionActiveTargetForServer } from '@/sync/domains/server/selection/serverSelectionActiveTarget';
import { resolveServerSelectionGroupActivation } from '@/sync/domains/server/selection/serverSelectionActivation';
import { listServerSelectionTargets } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import {
    getServerSelectionTargetName,
    getServerSelectionTargetSubtitle,
    isAllHomesSelectionTarget,
} from '@/sync/domains/server/selection/serverSelectionTargets';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { useMachineListStatusByServerId, useProfile } from '@/sync/domains/state/storage';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { t } from '@/text';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import {
    resolveAccountServiceIdentity,
    resolveCurrentHomeHealth,
    resolveOtherHomeHealth,
    type AccountPopoverHomeHealth,
    describeAccountServiceIdentity,
} from './accountPopoverModel';
import { useAccountServicePopoverState, type AccountServicePopoverState } from './useAccountServicePopoverState';

export type AccountPopoverStep = 'root' | 'account' | 'details';

type ConnectionTarget = ReturnType<typeof listServerSelectionTargets>[number];
type RowRef = React.ElementRef<typeof SelectableRow>;
type SwitchServer = (serverId: string, scope: 'tab' | 'device', intent?: 'direct' | 'group') => Promise<'switched' | 'blocked' | unknown>;

/**
 * A1 · Identity & Homes: who you are to the account service, then every Home with one health line
 * and its fix inline, then adding a Home, then Manage Homes and Connection details (one row).
 * The service's own actions (find Homes, linked Homes, sign out) sit behind the identity row;
 * technical connection facts behind Connection details. Presentation only: every action is an
 * existing owner's (Home focus switch, reconnect, Home recovery, the add sheet, Lane 02 intents).
 * Mounted only while the popover (or the phone page) shows it.
 */
export function AccountPopoverContent(props: Readonly<{
    step: AccountPopoverStep;
    onStepChange: (step: AccountPopoverStep) => void;
    servers: readonly ServerProfile[];
    targets: readonly ConnectionTarget[];
    activeTargetKey: string;
    activeServerId: string;
    displayServerId: string;
    displayServerProfile: ServerProfile | null;
    /** How the current Home's line names it in the machine guidance. */
    displayHomeLabel: string;
    pendingServerId: string | null;
    homeSummary: HomeConnectionSummary;
    machineSummary: MachineConnectionSummary;
    showsMachineGuidance: boolean;
    runtimeOrigin: string | null;
    homeCarrier: HomeCarrier | null;
    switchServer: SwitchServer;
    /** Reconnects in place; resolves when the attempt settles (the row's Retry shows it pending). */
    onRetry: () => Promise<unknown>;
    onRestore: () => void;
    onAddHome: () => void;
    onManageHomes: () => void;
    onClose: () => void;
    /** The Connection details step's facts (owned by the connection-status control). */
    renderDetails: () => React.ReactNode;
}>) {
    const service = useAccountServicePopoverState({
        profile: props.displayServerProfile,
        runtimeOrigin: props.runtimeOrigin,
        homeCarrier: props.homeCarrier,
        onClose: props.onClose,
    });
    const identityRowRef = React.useRef<RowRef>(null);
    const detailsRowRef = React.useRef<RowRef>(null);
    const backRowRef = React.useRef<RowRef>(null);
    const previousStepRef = React.useRef(props.step);
    // Moving between steps keeps keyboard focus inside the popover: a step opens on its back row,
    // and going back lands on the row that opened it.
    React.useEffect(() => {
        const previous = previousStepRef.current;
        previousStepRef.current = props.step;
        if (previous === props.step) return;
        const target = props.step !== 'root'
            ? backRowRef.current
            : previous === 'account' ? identityRowRef.current : detailsRowRef.current;
        (target as { focus?: () => void } | null)?.focus?.();
    }, [props.step]);

    if (props.step === 'account') {
        return <AccountStep service={service} backRowRef={backRowRef} onBack={() => props.onStepChange('root')} />;
    }
    if (props.step === 'details') {
        return (
            <>
                <ActionListSection
                    actions={[{
                        id: 'details-back',
                        testID: 'connection-popover-details-back',
                        rowRef: backRowRef,
                        label: t('accountPopover.connectionDetails'),
                        accessibilityLabel: `${t('common.back')}, ${t('accountPopover.connectionDetails')}`,
                        icon: <Icon name="caret-left" size={16} />,
                        onPress: () => props.onStepChange('root'),
                    }]}
                />
                {props.renderDetails()}
            </>
        );
    }
    return (
        <RootStep
            {...props}
            service={service}
            identityRowRef={identityRowRef}
            detailsRowRef={detailsRowRef}
        />
    );
}

function RootStep(props: React.ComponentProps<typeof AccountPopoverContent> & Readonly<{
    service: AccountServicePopoverState;
    identityRowRef: React.RefObject<RowRef | null>;
    detailsRowRef: React.RefObject<RowRef | null>;
}>) {
    const { theme } = useUnistyles();
    const { service } = props;
    const homeRows = useAccountPopoverHomeRows(props);
    const secondaryIconColor = theme.colors.text.secondary;
    const linkOffer = service.linkOffer;
    const serviceName = service.namedService ?? t('welcome.yourSignInService');

    return (
        <>
            <IdentitySection
                service={service}
                homeUnreachable={props.homeSummary.kind === 'unavailable'}
                rowRef={props.identityRowRef}
                onOpenAccount={() => props.onStepChange('account')}
            />

            <ActionListSection
                separatorAbove
                title={t('accountPopover.homesTitle')}
                actions={[
                    ...homeRows,
                    {
                        id: 'add-home-or-sign-in',
                        testID: 'connection-popover-add-home',
                        label: t('accountPopover.addHome'),
                        icon: <Icon name="plus" size={16} color={secondaryIconColor} />,
                        onPress: props.onAddHome,
                    },
                ]}
            />

            {props.showsMachineGuidance ? (
                <ConnectionPopoverMachineGuidance homeLabel={props.displayHomeLabel} onClose={props.onClose} />
            ) : null}

            {/* R15 d: the Homes this computer serves. A leaf of the open first layer, desktop only. */}
            {isDesktopHost() ? <ThisComputerServersMenuSection onClose={props.onClose} /> : null}

            {linkOffer ? (
                <ActionListSection
                    separatorAbove
                    actions={[{
                        id: 'account-link-current-home',
                        testID: 'connection-popover-link-current-home',
                        label: linkOffer.kind === 'link_service'
                            ? t('sidebarFooter.linkToService', { service: serviceName })
                            : t('settingsAccount.accountServiceLinkThisHome'),
                        subtitle: linkOffer.kind === 'link_service'
                            ? t('accountPopover.linkSubtitle')
                            : t('settingsAccount.accountServiceLinkThisHomeDescription', {
                                accountService: service.advertisedServiceName ?? undefined,
                            }),
                        icon: <AccountServiceMark url={service.serviceUrl} size={16} />,
                        right: (
                            <ToolbarButton
                                testID="connection-popover-link-current-home-button"
                                label={t('accountPopover.link')}
                                onPress={() => service.openEntry({ kind: 'link', homeServerIdentityId: linkOffer.homeServerIdentityId })}
                            />
                        ),
                        rightElementOutsidePressable: true,
                        onPress: () => service.openEntry({ kind: 'link', homeServerIdentityId: linkOffer.homeServerIdentityId }),
                    }]}
                />
            ) : null}

            <ActionListSection
                separatorAbove
                actions={[
                    {
                        id: 'add-device',
                        testID: 'connection-popover-add-device',
                        label: t('accountPopover.addDevice'),
                        icon: <Icon name="device-mobile" size={16} color={secondaryIconColor} />,
                        onPress: async () => {
                            const targetProfileId = props.displayServerId;
                            props.onClose();
                            const { showHomePairingModal } = await import('@/components/auth/pairing/HomePairingModal');
                            showHomePairingModal('phone', targetProfileId);
                        },
                    },
                    {
                        id: 'manage-homes',
                        testID: 'connection-popover-manage-homes',
                        label: t('accountPopover.manageHomes'),
                        icon: <Icon name="hard-drives" size={16} color={secondaryIconColor} />,
                        onPress: props.onManageHomes,
                    },
                    {
                        id: 'connection-details',
                        testID: 'connection-popover-details',
                        rowRef: props.detailsRowRef,
                        label: t('accountPopover.connectionDetails'),
                        icon: <Icon name="pulse" size={16} color={secondaryIconColor} />,
                        right: <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />,
                        onPress: () => props.onStepChange('details'),
                    },
                ]}
            />
        </>
    );
}

function IdentitySection(props: Readonly<{
    service: AccountServicePopoverState;
    /** The reachability owner's verdict on the current Home (its summary). */
    homeUnreachable: boolean;
    rowRef: React.RefObject<RowRef | null>;
    onOpenAccount: () => void;
}>) {
    const { theme } = useUnistyles();
    const profile = useProfile();
    const displayName = resolveViewerAccountDisplayName(getDisplayName(profile));
    const identity = resolveAccountServiceIdentity({
        entryStatus: props.service.entry.status,
        signedIn: props.service.signedIn,
        serviceName: props.service.namedService,
        selfService: props.service.selfService,
        policyReady: props.service.policyReady,
        policyUnavailable: props.service.policyFailed || props.homeUnreachable,
    });
    const retry = props.service.entry.retry;
    const unavailable = identity.kind === 'unavailable' || identity.kind === 'unsupported';
    // The row always says where the person stands with the account service: never an empty line.
    const subtitle = describeAccountServiceIdentity(identity, 'name');
    const item: ActionListItem = {
        id: 'account-identity',
        testID: 'connection-popover-identity',
        rowRef: props.rowRef,
        label: displayName,
        subtitle,
        subtitleLeading: identity.kind === 'signed_in'
            ? <AccountServiceMark url={props.service.serviceUrl} size={12} />
            : unavailable
                ? <Icon name="warning" size={11} color={theme.colors.status.actionRequired} />
                : null,
        icon: (
            <Avatar
                id={profile.id}
                size={32}
                imageUrl={getAvatarUrl(profile)}
                thumbhash={profile.avatar?.thumbhash}
            />
        ),
        right: identity.canOpenAccount
            ? <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
            : unavailable
                ? <RetryIconButton testID="connection-popover-account-service-retry" onPress={retry} />
                : null,
        rightElementOutsidePressable: !identity.canOpenAccount && unavailable,
        onPress: identity.canOpenAccount ? props.onOpenAccount : undefined,
    };
    return <ActionListSection actions={[item]} />;
}

function AccountStep(props: Readonly<{
    service: AccountServicePopoverState;
    backRowRef: React.RefObject<RowRef | null>;
    onBack: () => void;
}>) {
    const { theme } = useUnistyles();
    const { service } = props;
    const serviceName = service.namedService ?? t('welcome.yourSignInService');
    const iconColor = theme.colors.text.secondary;
    return (
        <>
            <ActionListSection
                actions={[{
                    id: 'account-back',
                    testID: 'connection-popover-account-back',
                    rowRef: props.backRowRef,
                    label: serviceName,
                    accessibilityLabel: `${t('common.back')}, ${serviceName}`,
                    subtitle: service.selfService
                        ? t('accountPopover.signedInToThisHome')
                        : service.signedIn
                            ? t('settingsAccount.accountServiceSignedInTo', { accountService: serviceName })
                            : t('accountPopover.notLinkedTo', { service: serviceName }),
                    icon: <Icon name="caret-left" size={16} />,
                    onPress: props.onBack,
                }]}
            />
            <ActionListSection
                separatorAbove
                actions={[{
                    id: 'account-find-homes',
                    testID: 'connection-popover-find-homes',
                    label: t('settingsAccount.accountServiceFindHomes'),
                    subtitle: t('settingsAccount.accountServiceFindHomesDescription'),
                    icon: <Icon name="magnifying-glass" size={16} color={iconColor} />,
                    onPress: () => service.openEntry({ kind: 'enter', target: { kind: 'automatic' } }),
                }]}
            />
            <ActionListSection
                title={t('settingsAccount.accountServiceHomes')}
                actions={service.linkedHomes.map((home) => ({
                    id: `account-directory-home-${home.homeServerIdentityId}`,
                    testID: `connection-popover-account-directory-home-${home.homeServerIdentityId}`,
                    label: home.label,
                    subtitle: toServerUrlDisplay(home.canonicalServerUrl),
                    icon: <HomeMark serverUrl={home.canonicalServerUrl} />,
                }))}
            />
            {service.signedIn ? (
                <ActionListSection
                    separatorAbove
                    actions={[{
                        id: 'account-service-sign-out',
                        testID: 'connection-popover-account-service-sign-out',
                        label: t('settingsAccount.logoutHome', { home: serviceName }),
                        icon: <Icon name="sign-out" size={16} color={iconColor} />,
                        onPress: () => { void service.signOut(); },
                    }]}
                />
            ) : null}
        </>
    );
}

/** One row per Home (and Home group): its mark, name, one health line and the fix that applies. */
function useAccountPopoverHomeRows(props: React.ComponentProps<typeof AccountPopoverContent>): ActionListItem[] {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { setHomeViewSelectionSettings } = useHomeViewSelectionSettingsMutable();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const authStatusByServerId = useServerAuthStatusByServerId(props.servers);
    const serverById = React.useMemo(() => {
        const map = new Map<string, ServerProfile>();
        for (const server of props.servers) {
            map.set(server.id, server);
            map.set(resolveServerProfileScopeId(server), server);
        }
        return map;
    }, [props.servers]);

    const { switchServer, activeServerId, onClose } = props;
    const switchTarget = React.useCallback(async (target: ConnectionTarget) => {
        const routineSwitchScope = resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost());
        if (target.kind === 'server') {
            if (!serverById.has(target.serverId)) return;
            const result = await switchServer(target.serverId, routineSwitchScope, 'direct');
            if (result === 'blocked') return;
            await setHomeViewSelectionSettings(
                (current) => ({ ...current, ...buildServerSelectionActiveTargetForServer(target.serverId) }),
                { targetScope: routineSwitchScope },
            );
            if ((authStatusByServerId[target.serverId] ?? 'unknown') === 'signedOut') {
                router.replace('/');
            }
            return;
        }
        const activation = await resolveServerSelectionGroupActivation({
            currentServerId: activeServerId,
            serverIds: target.serverIds,
            resolveAuthStatus: async (serverId: string) => (
                serverById.has(serverId) ? authStatusByServerId[serverId] ?? 'unknown' : 'unknown'
            ),
        });
        const nextServerId = activation?.serverId ?? '';
        if (nextServerId && !areServerProfileIdentifiersEquivalent(nextServerId, activeServerId)) {
            const result = await switchServer(nextServerId, routineSwitchScope, 'group');
            if (result === 'blocked') return;
        }
        await setHomeViewSelectionSettings((current) => ({
            ...current,
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: target.groupId,
        }), { targetScope: routineSwitchScope });
        if (nextServerId && activation?.authStatus === 'signedOut') {
            router.replace('/');
            return;
        }
        onClose();
    }, [activeServerId, authStatusByServerId, onClose, router, serverById, setHomeViewSelectionSettings, switchServer]);

    return React.useMemo(() => {
        const nameCounts = new Map<string, number>();
        const labelFor = (target: ConnectionTarget) => {
            if (target.kind !== 'server') return getServerSelectionTargetName(target);
            const profile = serverById.get(target.serverId);
            return resolveHomeDisplayLabel(profile, target.serverId);
        };
        for (const target of props.targets) {
            const key = labelFor(target).trim().toLocaleLowerCase();
            nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
        }
        const toneColor = (health: AccountPopoverHomeHealth, summary: HomeConnectionSummary) => {
            switch (health.tone) {
                case 'ok':
                    return theme.colors.status.connected;
                case 'pending':
                    return theme.colors.status.connecting;
                case 'attention':
                    return summary.statusKey === 'error' ? theme.colors.status.error : theme.colors.status.actionRequired;
                default:
                    return theme.colors.status.default;
            }
        };

        return props.targets.map((target): ActionListItem => {
            const targetKey = `${target.kind}:${target.id}`;
            const selected = targetKey === props.activeTargetKey;
            const label = labelFor(target);
            const profile = target.kind === 'server' ? serverById.get(target.serverId) ?? null : null;
            // "All Homes" is a view, not a Home or a group someone made: a plain stack glyph, no monogram.
            const mark = isAllHomesSelectionTarget(target) ? (
                <Icon name="stack" size={16} color={theme.colors.text.secondary} />
            ) : (
                <HomeMark
                    serverUrl={profile ? profile.canonicalServerUrl ?? profile.serverUrl : null}
                    glyph={target.kind === 'server' ? 'house' : 'stack'}
                />
            );
            const onPress = () => {
                if (selected) return;
                void switchTarget(target);
            };
            if (target.kind !== 'server') {
                const subtitle = getServerSelectionTargetSubtitle(target);
                return {
                    id: `target-use-${target.kind}-${target.id}`,
                    testID: `connection-popover-home-${target.kind}-${target.id}`,
                    label,
                    subtitle,
                    accessibilityLabel: [label, subtitle].join(', '),
                    icon: mark,
                    selected,
                    onPress,
                };
            }
            const isCurrent = areServerProfileIdentifiersEquivalent(target.serverId, props.displayServerId);
            const summary = isCurrent
                ? props.homeSummary
                : resolveHomeTargetSummary({
                    authStatus: authStatusByServerId[target.serverId] ?? 'unknown',
                    projectionStatus: machineListStatusByServerId[target.serverId],
                    pending: props.pendingServerId === target.serverId,
                });
            const health = isCurrent
                ? resolveCurrentHomeHealth(summary, props.machineSummary)
                : resolveOtherHomeHealth(summary);
            const color = toneColor(health, summary);
            const fix = health.fix;
            const fixPress = fix === 'retry' ? props.onRetry : fix === 'restore' ? props.onRestore : onPress;
            const disambiguator = (nameCounts.get(label.trim().toLocaleLowerCase()) ?? 0) > 1
                ? getServerSelectionTargetSubtitle(target)
                : null;
            return {
                id: `target-use-${target.kind}-${target.id}`,
                testID: `connection-popover-home-${target.kind}-${target.id}`,
                label,
                subtitle: health.label,
                subtitleLeading: health.tone === 'attention'
                    ? <Icon name="warning" size={11} color={color} />
                    : <StatusDot color={color} isPulsing={health.tone === 'pending'} size={6} />,
                accessibilityLabel: [label, health.label, disambiguator].filter(Boolean).join(', '),
                icon: mark,
                selected,
                // Retry is a glyph (a failed Home keeps its row quiet); Sign in stays a labelled action.
                right: fix === 'retry' ? (
                    <RetryIconButton testID={`connection-popover-home-${target.kind}-${target.id}-fix`} onPress={fixPress} />
                ) : fix ? (
                    <ToolbarButton
                        testID={`connection-popover-home-${target.kind}-${target.id}-fix`}
                        label={t('accountPopover.signIn')}
                        onPress={fixPress}
                    />
                ) : undefined,
                rightElementOutsidePressable: fix !== null,
                onPress,
            };
        });
    }, [
        authStatusByServerId,
        machineListStatusByServerId,
        props.activeTargetKey,
        props.displayServerId,
        props.homeSummary,
        props.machineSummary,
        props.onRestore,
        props.onRetry,
        props.pendingServerId,
        props.targets,
        serverById,
        switchTarget,
        theme,
    ]);
}

const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

const RETRY_GLYPH_PX = 18;

/** The inline retry of a failed row: the refresh glyph, no chrome, named and explained on hover. */
function RetryIconButton(props: Readonly<{ testID: string; onPress: () => unknown }>) {
    return (
        <IconButton
            testID={props.testID}
            iconName="arrow-clockwise"
            variant="plain"
            // A chromeless square just larger than its glyph, so the glyph's edge sits on the row's
            // trailing edge where a labelled action (Sign in) ends; the press frame grows vertically.
            size={RETRY_GLYPH_PX + 6}
            iconSize={RETRY_GLYPH_PX}
            accessibilityLabel={t('common.retry')}
            tooltip={t('common.retry')}
            minimumInteractiveTargetSize={minimumInteractiveTargetSize}
            onPress={props.onPress}
        />
    );
}
