import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderBrowserButton } from '@/components/sessions/actions/SessionHeaderBrowserButton';
import { SessionHeaderInfoButton } from '@/components/sessions/actions/SessionHeaderInfoButton';
import { SessionHeaderRightSidebarButton } from '@/components/sessions/actions/SessionHeaderRightSidebarButton';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { isSessionRouteHydrationPending } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { LruMap } from '@/utils/cache/lruMap';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { resolveSessionViewBadges } from './resolveSessionViewBadges';
import { resolveSessionViewHeaderActionItems } from './resolveSessionViewHeaderActionItems';
import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';
import {
    resolveExternalSessionIdentityPresentation,
} from '../../presentation/externalSessionIdentityPresentation';
import type { ExternalSessionRuntimePresentation } from '../../presentation/externalSessionRuntimePresentation';
import { SessionRowAttentionIndicator } from '../row/SessionRowAttentionIndicator';

export type SessionViewHeaderProps = Readonly<{
    title: string;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    avatarId?: string;
    rightElement?: React.ReactNode;
    /** The right-sidebar toggle. The header decides whether it fits the margin or joins the icons. */
    gutterElement?: React.ReactNode;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    constrainWidth?: boolean;
}>;

type ResolveSessionViewHeaderPropsInput = Readonly<{
    isDataReady: boolean;
    routeHydrationState?: SessionRouteHydrationState | null;
    session: Session | null;
    sessionId: string;
    sessionInfoHref: string;
    sessionRunsHref: string;
    sessionAutomationsHref: string;
    paneScopeId: string;
    windowWidth: number;
    sessionAutomationsEnabledCount: number;
    sessionExecutionRunsSupported: boolean;
    showAutomations: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    navigateWithBlurOnWeb: (action: () => void) => void;
    handleHeaderExtraItemSelect: (actionId: string) => boolean;
    headerMenuExtraItems?: ReadonlyArray<DropdownMenuItem>;
    router: Readonly<{
        push: (path: string) => void;
        navigate: (path: string, options: { dangerouslySingular: () => string }) => void;
    }>;
    actionIconColor: string;
    headerTintColor: string;
    statusErrorColor: string;
    workspaceSubtitle?: string | null;
    workspaceSubtitleEllipsizeMode?: 'head' | 'tail';
    externalSessionRuntime: ExternalSessionRuntimePresentation | null;
    /**
     * Plugin-UI projection + open handler for the session header-action menu
     * (Phase 2.2 / finding #11). When provided, plugin-contributed header actions
     * are surfaced in the action menu and dispatched through the canonical
     * `executePluginUiAction` executor.
     */
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiLocale?: string | null;
    onOpenPluginSurface?: (surfaceId: string) => void;
}>;

const LOADING_HEADER_PROPS: SessionViewHeaderProps = {
    title: '',
    subtitle: undefined,
    avatarId: undefined,
    rightElement: undefined,
    isConnected: false,
    flavor: null,
};

const DELETED_HEADER_PROPS: SessionViewHeaderProps = {
    title: t('errors.sessionDeleted'),
    subtitle: undefined,
    avatarId: undefined,
    rightElement: undefined,
    isConnected: false,
    flavor: null,
};

const SESSION_VIEW_HEADER_PROPS_CACHE = new LruMap<string, SessionViewHeaderProps>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function buildSessionViewHeaderPropsCacheKey(input: Readonly<{
    sessionId: string;
    sessionServerId: string | null | undefined;
    sessionMachineId: string | null | undefined;
    title: string;
    subtitle: string | undefined;
    subtitleEllipsizeMode: 'head' | 'tail' | undefined;
    avatarId: string | undefined;
    sessionInfoHref: string;
    sessionRunsHref: string;
    sessionAutomationsHref: string;
    isConnected: boolean;
    flavor: string | null;
    storageBadge: string;
    providerBadge: string | null;
    shouldFoldHeaderIconActions: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    sessionExecutionRunsSupported: boolean;
    showAutomations: boolean;
    actionIconColor: string;
    headerTintColor: string;
    statusErrorColor: string;
    paneScopeId: string;
    sessionAutomationsEnabledCount: number;
    headerMenuExtraItemIdsKey: string;
    pluginUiProjectionGeneration: number | null;
    pluginUiLocale: string | null;
    backgroundActivityStatusText: string | null;
    externalAgentState: ExternalSessionRuntimePresentation['externalAgent']['state'] | null;
}>): string {
    return JSON.stringify([
        input.sessionId,
        input.sessionServerId ?? '',
        input.sessionMachineId ?? '',
        input.title,
        input.subtitle ?? '',
        input.subtitleEllipsizeMode ?? '',
        input.avatarId ?? '',
        input.sessionInfoHref,
        input.sessionRunsHref,
        input.sessionAutomationsHref,
        input.isConnected,
        input.flavor ?? '',
        input.storageBadge,
        input.providerBadge ?? '',
        input.shouldFoldHeaderIconActions,
        input.shouldShowSubagentsButton,
        input.subagentActiveCount,
        input.sessionExecutionRunsSupported,
        input.showAutomations,
        input.actionIconColor,
        input.headerTintColor,
        input.statusErrorColor,
        input.paneScopeId,
        input.sessionAutomationsEnabledCount,
        input.headerMenuExtraItemIdsKey,
        input.pluginUiProjectionGeneration ?? '',
        input.pluginUiLocale ?? '',
        input.backgroundActivityStatusText ?? '',
        input.externalAgentState ?? '',
    ]);
}

export function resolveSessionViewHeaderProps(input: ResolveSessionViewHeaderPropsInput): SessionViewHeaderProps {
    if (!input.session && input.routeHydrationState && isSessionRouteHydrationPending(input.routeHydrationState)) {
        return LOADING_HEADER_PROPS;
    }

    if (!input.isDataReady && !input.session) {
        return LOADING_HEADER_PROPS;
    }

    if (!input.session) {
        return DELETED_HEADER_PROPS;
    }

    const session = input.session;
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const externalSessionIdentity = resolveExternalSessionIdentityPresentation(ownerMetadata);
    const shouldFoldHeaderIconActions = input.windowWidth < 520;
    const badgeLabel = input.sessionAutomationsEnabledCount > 99 ? '99+' : String(input.sessionAutomationsEnabledCount);
    const title = getSessionName(session);
    const fallbackSubtitle = ownerMetadata?.path
        ? formatPathRelativeToHome(ownerMetadata.path, ownerMetadata.homeDir)
        : undefined;
    const workspaceSubtitle = typeof input.workspaceSubtitle === 'string' && input.workspaceSubtitle.length > 0
        ? input.workspaceSubtitle
        : undefined;
    const subtitle = workspaceSubtitle ?? fallbackSubtitle;
    const subtitleEllipsizeMode = subtitle
        ? input.workspaceSubtitleEllipsizeMode ?? 'head' as const
        : undefined;
    const avatarId = getSessionAvatarId(session);
    const isConnected = session.presence === 'online';
    const flavor = readSessionPresentationAgentId(session) ?? ownerMetadata?.flavor ?? null;
    const resolvedStorageBadge = externalSessionIdentity.storageLabel;
    const resolvedProviderBadge = externalSessionIdentity.headerBadgeLabel;
    const sessionStatus = getSessionStatus(session, Date.now(), { workingTextMode: 'static' });
    const backgroundActivityStatusText = sessionStatus.state === 'background_active'
        ? sessionStatus.statusText
        : null;
    const cacheKey = buildSessionViewHeaderPropsCacheKey({
        sessionId: session.id,
        sessionServerId: session.serverId,
        sessionMachineId: ownerMetadata?.machineId ?? null,
        title,
        subtitle,
        subtitleEllipsizeMode,
        avatarId,
        sessionInfoHref: input.sessionInfoHref,
        sessionRunsHref: input.sessionRunsHref,
        sessionAutomationsHref: input.sessionAutomationsHref,
        isConnected,
        flavor,
        storageBadge: resolvedStorageBadge,
        providerBadge: resolvedProviderBadge,
        shouldFoldHeaderIconActions,
        shouldShowSubagentsButton: input.shouldShowSubagentsButton,
        subagentActiveCount: input.subagentActiveCount,
        sessionExecutionRunsSupported: input.sessionExecutionRunsSupported,
        showAutomations: input.showAutomations,
        actionIconColor: input.actionIconColor,
        headerTintColor: input.headerTintColor,
        statusErrorColor: input.statusErrorColor,
        paneScopeId: input.paneScopeId,
        sessionAutomationsEnabledCount: input.sessionAutomationsEnabledCount,
        headerMenuExtraItemIdsKey: (input.headerMenuExtraItems ?? []).map((item) => item.id).join('|'),
        pluginUiProjectionGeneration: input.pluginUiProjection?.generation ?? null,
        pluginUiLocale: input.pluginUiLocale ?? null,
        backgroundActivityStatusText,
        externalAgentState: input.externalSessionRuntime?.externalAgent.state ?? null,
    });

    const cached = SESSION_VIEW_HEADER_PROPS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const resolvedBadges = resolveSessionViewBadges({
        storageBadge: resolvedStorageBadge,
        providerBadge: resolvedProviderBadge,
    });
    const resolvedFoldedHeaderItems = resolveSessionViewHeaderActionItems({
        shouldFoldHeaderIconActions,
        shouldShowSubagentsButton: input.shouldShowSubagentsButton,
        subagentActiveCount: input.subagentActiveCount,
        sessionExecutionRunsSupported: input.sessionExecutionRunsSupported,
        showAutomations: input.showAutomations,
        actionIconColor: input.actionIconColor,
    });
    const resolvedHeaderMenuExtraItems = [
        ...resolvedFoldedHeaderItems,
        ...(input.headerMenuExtraItems ?? []),
    ];

    // Keeps dev's web-blur wrapper: navigating away from a focused web control without blurring it
    // leaves the caret behind on the outgoing screen.
    const openSessionInfo = () => input.navigateWithBlurOnWeb(() => input.router.navigate(input.sessionInfoHref as any, {
        dangerouslySingular() {
            return 'session-info';
        },
    } as any));

    const next: SessionViewHeaderProps = {
        title,
        subtitle,
        subtitleEllipsizeMode,
        avatarId,
        gutterElement: shouldFoldHeaderIconActions
            ? undefined
            : <SessionHeaderRightSidebarButton scopeId={input.paneScopeId} />,
        rightElement: (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {input.externalSessionRuntime ? (
                    <View
                        testID={`session-header-external-agent-status-${input.externalSessionRuntime.externalAgent.state}`}
                        accessibilityLabel={t(input.externalSessionRuntime.externalAgent.labelKey)}
                        style={{
                            maxWidth: 160,
                            marginRight: 4,
                            paddingHorizontal: 6,
                            paddingVertical: 4,
                            borderRadius: 999,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 3,
                        }}
                    >
                        <SessionRowAttentionIndicator
                            indicator={input.externalSessionRuntime.externalAgent.indicator}
                            sessionId={`${input.sessionId}-header-external`}
                            attentionState={
                                input.externalSessionRuntime.externalAgent.indicator === 'working'
                                    ? 'working'
                                    : input.externalSessionRuntime.externalAgent.indicator === 'action'
                                        ? 'action_required'
                                        : input.externalSessionRuntime.externalAgent.indicator === 'ready'
                                            ? 'ready'
                                            : 'quiet'
                            }
                            accessibilityLabel={t(input.externalSessionRuntime.externalAgent.labelKey)}
                            workingMode="spinner"
                        />
                        <Text
                            numberOfLines={1}
                            style={{
                                color: input.actionIconColor,
                                fontSize: 12,
                                lineHeight: 16,
                                fontWeight: '600',
                            }}
                        >
                            {t(input.externalSessionRuntime.externalAgent.labelKey)}
                        </Text>
                    </View>
                ) : null}
                {backgroundActivityStatusText ? (
                    <View
                        testID="session-header-background-activity-status"
                        style={{
                            maxWidth: 132,
                            marginRight: 4,
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            borderRadius: 999,
                        }}
                    >
                        <Text
                            numberOfLines={1}
                            style={{
                                color: input.actionIconColor,
                                fontSize: 12,
                                lineHeight: 16,
                                fontWeight: '600',
                            }}
                        >
                            {backgroundActivityStatusText}
                        </Text>
                    </View>
                ) : null}
                <SessionHeaderActionMenu
                    sessionId={input.sessionId}
                    session={session}
                    extraItems={resolvedHeaderMenuExtraItems.length > 0 ? resolvedHeaderMenuExtraItems : undefined}
                    onSelectExtraItem={input.handleHeaderExtraItemSelect}
                    pluginUiProjection={input.pluginUiProjection}
                    pluginUiLocale={input.pluginUiLocale}
                    onOpenPluginSurface={input.onOpenPluginSurface}
                />
                {!shouldFoldHeaderIconActions ? (
                    <SessionHeaderSubagentsButton
                        scopeId={input.paneScopeId}
                        activeCount={input.subagentActiveCount}
                    />
                ) : null}
                <SessionHeaderTerminalButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
                <SessionHeaderBrowserButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
                {!shouldFoldHeaderIconActions ? (
                    <SessionHeaderInfoButton onPress={openSessionInfo} />
                ) : null}
                {!shouldFoldHeaderIconActions && input.showAutomations && input.sessionAutomationsEnabledCount > 0 ? (
                    <Pressable
                        onPress={() => input.navigateWithBlurOnWeb(() => input.router.push(input.sessionAutomationsHref as any))}
                        hitSlop={15}
                        style={({ pressed }) => ({
                            width: 44,
                            height: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? 0.7 : 1,
                        })}
                        accessibilityRole="button"
                        accessibilityLabel={t('session.openAutomations')}
                    >
                        <View style={{ position: 'relative', width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                            <Ionicons name="timer-outline" size={SESSION_HEADER_ICON_SIZE_PX} color={input.headerTintColor} />
                            {input.sessionAutomationsEnabledCount > 0 ? (
                                <View style={{
                                    position: 'absolute',
                                    top: -2,
                                    right: -6,
                                    backgroundColor: input.statusErrorColor,
                                    borderRadius: 8,
                                    minWidth: 16,
                                    height: 16,
                                    paddingHorizontal: 4,
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                }}>
                                    <Text style={{
                                        color: input.headerTintColor,
                                        fontSize: 10,
                                        fontWeight: '600',
                                    }}>
                                        {badgeLabel}
                                    </Text>
                                </View>
                            ) : null}
                        </View>
                    </Pressable>
                ) : null}
            </View>
        ),
        badges: resolvedBadges,
        isConnected,
        flavor,
    };

    SESSION_VIEW_HEADER_PROPS_CACHE.set(cacheKey, next);
    return next;
}
