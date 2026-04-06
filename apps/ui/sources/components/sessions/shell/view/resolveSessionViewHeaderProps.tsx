import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { Text } from '@/components/ui/text/Text';
import { getAgentCore } from '@/agents/catalog/catalog';
import { t } from '@/text';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName } from '@/utils/sessions/sessionUtils';

import { resolveSessionViewBadges } from './resolveSessionViewBadges';
import { resolveSessionViewHeaderActionItems } from './resolveSessionViewHeaderActionItems';

export type SessionViewHeaderProps = Readonly<{
    title: string;
    subtitle?: string;
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
    session: Session | null;
    sessionId: string;
    paneScopeId: string;
    windowWidth: number;
    sessionAutomationsEnabledCount: number;
    sessionExecutionRunsSupported: boolean;
    showAutomations: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    navigateWithBlurOnWeb: (action: () => void) => void;
    handleHeaderExtraItemSelect: (actionId: string) => boolean;
    router: Readonly<{
        push: (path: string) => void;
        navigate: (path: string, options: { dangerouslySingular: () => string }) => void;
    }>;
    actionIconColor: string;
    headerTintColor: string;
    statusErrorColor: string;
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

const SESSION_VIEW_HEADER_PROPS_CACHE = new Map<string, SessionViewHeaderProps>();

function buildSessionViewHeaderPropsCacheKey(input: Readonly<{
    sessionId: string;
    sessionUpdatedAt: number | null | undefined;
    sessionServerId: string | null | undefined;
    sessionMachineId: string | null | undefined;
    title: string;
    subtitle: string | undefined;
    avatarId: string | undefined;
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
}>): string {
    return JSON.stringify([
        input.sessionId,
        input.sessionUpdatedAt ?? 0,
        input.sessionServerId ?? '',
        input.sessionMachineId ?? '',
        input.title,
        input.subtitle ?? '',
        input.avatarId ?? '',
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
    ]);
}

export function resolveSessionViewHeaderProps(input: ResolveSessionViewHeaderPropsInput): SessionViewHeaderProps {
    if (!input.isDataReady && !input.session) {
        return LOADING_HEADER_PROPS;
    }

    if (!input.session) {
        return DELETED_HEADER_PROPS;
    }

    const session = input.session;
    const directSessionLink = readDirectSessionLink(session.metadata);
    const shouldFoldHeaderIconActions = input.windowWidth < 520;
    const badgeLabel = input.sessionAutomationsEnabledCount > 99 ? '99+' : String(input.sessionAutomationsEnabledCount);
    const title = getSessionName(session);
    const subtitle = session.metadata?.path ? formatPathRelativeToHome(session.metadata.path, session.metadata?.homeDir) : undefined;
    const avatarId = getSessionAvatarId(session);
    const isConnected = session.presence === 'online';
    const flavor = session.metadata?.flavor || null;
    const resolvedStorageBadge = directSessionLink ? t('sessionsList.storageDirectTab') : t('sessionsList.storagePersistedTab');
    const resolvedProviderBadge = directSessionLink
        ? [
            t(getAgentCore(directSessionLink.providerId).displayNameKey),
            typeof session.metadata?.host === 'string' && session.metadata.host.trim()
                ? session.metadata.host.trim()
                : directSessionLink.machineId,
        ].join(' · ')
        : null;
    const cacheKey = buildSessionViewHeaderPropsCacheKey({
        sessionId: session.id,
        sessionUpdatedAt: session.updatedAt,
        sessionServerId: session.serverId,
        sessionMachineId: session.metadata?.machineId ?? null,
        title,
        subtitle,
        avatarId,
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

    const next: SessionViewHeaderProps = {
        title,
        subtitle,
        avatarId,
        onAvatarPress: () => input.router.navigate((`/session/${input.sessionId}/info`) as any, {
            dangerouslySingular() {
                return 'session-info';
            },
        } as any),
        rightElement: (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <SessionHeaderActionMenu
                    sessionId={input.sessionId}
                    session={session}
                    extraItems={resolvedFoldedHeaderItems.length > 0 ? resolvedFoldedHeaderItems : undefined}
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
                        onPress={() => input.router.push(`/session/${input.sessionId}/runs` as any)}
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
                        onPress={() => input.navigateWithBlurOnWeb(() => input.router.push(`/session/${input.sessionId}/automations` as any))}
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
