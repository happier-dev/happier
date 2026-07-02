import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { getAgentCore } from '@/agents/catalog/catalog';
import { t } from '@/text';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { isSessionRouteHydrationPending } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName } from '@/utils/sessions/sessionUtils';
import { LruMap } from '@/utils/cache/lruMap';

import { resolveSessionViewBadges } from './resolveSessionViewBadges';
import { resolveSessionViewHeaderActionItems } from './resolveSessionViewHeaderActionItems';
import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

export type SessionViewHeaderProps = Readonly<{
    title: string;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    onAvatarPress?: () => void;
    avatarId?: string;
    rightElement?: React.ReactNode;
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
}>;

const LOADING_HEADER_PROPS: SessionViewHeaderProps = {
    title: '',
    subtitle: undefined,
    avatarId: undefined,
    onAvatarPress: undefined,
    rightElement: undefined,
    isConnected: false,
    flavor: null,
};

const DELETED_HEADER_PROPS: SessionViewHeaderProps = {
    title: t('errors.sessionDeleted'),
    subtitle: undefined,
    avatarId: undefined,
    onAvatarPress: undefined,
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
    const externalSessionLink = readExternalSessionLink(session.metadata);
    const shouldFoldHeaderIconActions = input.windowWidth < 520;
    const badgeLabel = input.sessionAutomationsEnabledCount > 99 ? '99+' : String(input.sessionAutomationsEnabledCount);
    const title = getSessionName(session);
    const fallbackSubtitle = session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined;
    const workspaceSubtitle = typeof input.workspaceSubtitle === 'string' && input.workspaceSubtitle.length > 0
        ? input.workspaceSubtitle
        : undefined;
    const subtitle = workspaceSubtitle ?? fallbackSubtitle;
    const subtitleEllipsizeMode = subtitle
        ? input.workspaceSubtitleEllipsizeMode ?? 'head' as const
        : undefined;
    const avatarId = getSessionAvatarId(session);
    const isConnected = session.presence === 'online';
    const flavor = session.metadata?.flavor || null;
    const resolvedStorageBadge = externalSessionLink ? t('sessionsList.storageDirectTab') : t('sessionsList.storagePersistedTab');
    const resolvedProviderBadge = externalSessionLink
        ? [
            t(getAgentCore(externalSessionLink.providerId).displayNameKey),
            typeof session.metadata?.host === 'string' && session.metadata.host.trim()
                ? session.metadata.host.trim()
                : externalSessionLink.machineId,
        ].join(' · ')
        : null;
    const cacheKey = buildSessionViewHeaderPropsCacheKey({
        sessionId: session.id,
        sessionServerId: session.serverId,
        sessionMachineId: session.metadata?.machineId ?? null,
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

    const next: SessionViewHeaderProps = {
        title,
        subtitle,
        subtitleEllipsizeMode,
        avatarId,
        onAvatarPress: () => input.navigateWithBlurOnWeb(() => input.router.navigate(input.sessionInfoHref as any, {
            dangerouslySingular() {
                return 'session-info';
            },
        } as any)),
        rightElement: (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <SessionHeaderActionMenu
                    sessionId={input.sessionId}
                    session={session}
                    extraItems={resolvedHeaderMenuExtraItems.length > 0 ? resolvedHeaderMenuExtraItems : undefined}
                    onSelectExtraItem={input.handleHeaderExtraItemSelect}
                />
                {!shouldFoldHeaderIconActions ? (
                    <SessionHeaderSubagentsButton
                        scopeId={input.paneScopeId}
                        activeCount={input.subagentActiveCount}
                        hasAnySubagents={input.shouldShowSubagentsButton}
                    />
                ) : null}
                <SessionHeaderTerminalButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
                {!shouldFoldHeaderIconActions && input.sessionExecutionRunsSupported ? (
                    <Pressable
                        onPress={() => input.router.push(input.sessionRunsHref as any)}
                        hitSlop={15}
                        style={({ pressed }) => ({
                            width: 44,
                            height: 44,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? 0.7 : 1,
                        })}
                        accessibilityRole="button"
                        accessibilityLabel={t('session.openRuns')}
                    >
                        <Ionicons name="play-outline" size={22} color={input.headerTintColor} />
                    </Pressable>
                ) : null}
                {!shouldFoldHeaderIconActions && input.showAutomations ? (
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
                            <Ionicons name="timer-outline" size={22} color={input.headerTintColor} />
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
