import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { resolvePluginSessionHeaderActionPresentations } from '@/components/sessions/actions/pluginHeaderActions';
import { SessionHeaderBrowserButton } from '@/components/sessions/actions/SessionHeaderBrowserButton';
import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { SessionHeaderInfoButton } from '@/components/sessions/actions/SessionHeaderInfoButton';
import { SessionHeaderRightSidebarButton } from '@/components/sessions/actions/SessionHeaderRightSidebarButton';
import {
    SESSION_HEADER_ACTION_TAP_TARGET_PX,
    SESSION_HEADER_ICON_SIZE_PX,
} from '@/components/sessions/actions/sessionHeaderIconMetrics';
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
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName } from '@/utils/sessions/sessionUtils';
import { LruMap } from '@/utils/cache/lruMap';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { createPluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { normalizePluginSurfacePlatform } from '@/components/plugins/surfaces/pluginSurfaceContext';

import { resolveSessionViewBadges } from './resolveSessionViewBadges';
import { resolveSessionViewHeaderActionItems } from './resolveSessionViewHeaderActionItems';
import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';
import {
    resolveExternalSessionIdentityPresentation,
} from '../../presentation/externalSessionIdentityPresentation';
import type { ExternalSessionRuntimePresentation } from '../../presentation/externalSessionRuntimePresentation';
import { SessionRowAttentionIndicator } from '../row/SessionRowAttentionIndicator';
import { resolveAgentIdFromFlavor, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { AgentId } from '@/agents/registry/registryCore';
import { Icon } from '@/components/ui/icons/Icon';

export type SessionViewHeaderProps = Readonly<{
    title: string;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    avatarId?: string;
    agentId?: AgentId | null;
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
    currentMachineId?: unknown;
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
     * are surfaced in the action menu and dispatched through their canonical
     * header-action owner.
     */
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiLocale?: string | null;
    pluginUiScopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    /** Existing Session Account-lifetime predicate for action execution. */
    pluginUiScopeIsCurrent?: (() => boolean) | null;
    onOpenPluginSurface?: PluginSurfaceOpenHandler;
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

// The compact breakpoint already owns when header chrome must fold. Outside it,
// reserve exactly one existing direct-action hit target for plugin chrome. The
// trailing row has no remaining-width callback and each additional direct action
// consumes another fixed target, so more actions use the incumbent overflow menu
// rather than competing with the session title or adding a plugin layout engine.
const DIRECT_PLUGIN_HEADER_ACTION_WIDTH_BUDGET_PX = SESSION_HEADER_ACTION_TAP_TARGET_PX;

function resolvePluginHeaderActionPlacement(input: Readonly<{
    shouldFoldHeaderIconActions: boolean;
    actionCount: number;
}>): 'direct' | 'overflow' {
    const directActionWidth = Math.max(0, input.actionCount) * SESSION_HEADER_ACTION_TAP_TARGET_PX;
    return input.shouldFoldHeaderIconActions || directActionWidth > DIRECT_PLUGIN_HEADER_ACTION_WIDTH_BUDGET_PX
        ? 'overflow'
        : 'direct';
}

function buildSessionViewHeaderPropsCacheKey(input: Readonly<{
    sessionId: string;
    sessionServerId: string | null | undefined;
    sessionMachineId: string | null | undefined;
    title: string;
    subtitle: string | undefined;
    subtitleEllipsizeMode: 'head' | 'tail' | undefined;
    avatarId: string | undefined;
    // Part of the key, not just the props: the header renders this, so a session whose agent
    // changes must not be served the previous agent's cached header.
    agentId: AgentId | null | undefined;
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
    pluginUiScopedServerId: string | null;
    pluginUiScopedMachineId: string | null;
    pluginUiScopedGeneration: number | null;
    pluginUiInteractionEnabled: boolean;
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
        input.pluginUiScopedServerId ?? '',
        input.pluginUiScopedMachineId ?? '',
        input.pluginUiScopedGeneration ?? '',
        input.pluginUiInteractionEnabled,
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
    const externalSessionIdentity = resolveExternalSessionIdentityPresentation(
        ownerMetadata,
        input.currentMachineId,
    );
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
    const agentId = resolveAgentIdFromSessionMetadata(session.metadata)
        ?? resolveAgentIdFromFlavor(session.metadata?.flavor ?? null);
    const isConnected = session.presence === 'online';
    const flavor = readSessionPresentationAgentId(session) ?? ownerMetadata?.flavor ?? null;
    const resolvedStorageBadge = externalSessionIdentity.storageLabel;
    const resolvedProviderBadge = externalSessionIdentity.identityLabel;
    const cacheKey = buildSessionViewHeaderPropsCacheKey({
        sessionId: session.id,
        sessionServerId: session.serverId,
        sessionMachineId: ownerMetadata?.machineId ?? null,
        title,
        subtitle,
        subtitleEllipsizeMode,
        avatarId,
        agentId,
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
        pluginUiScopedServerId: input.pluginUiScopedLaunchFacts?.serverId ?? null,
        pluginUiScopedMachineId: input.pluginUiScopedLaunchFacts?.machineId ?? null,
        pluginUiScopedGeneration: input.pluginUiScopedLaunchFacts?.generation ?? null,
        pluginUiInteractionEnabled: input.pluginUiScopedLaunchFacts?.interactionEnabled === true,
        externalAgentState: input.externalSessionRuntime?.externalAgent.state ?? null,
    });

    // A plugin projection makes the element carry live projection, navigation,
    // and Account-lifetime authority. Scalar cache keys cannot distinguish a
    // same-generation successor, so retain the LRU only for authority-free
    // headers rather than adding a second identity/currentness registry.
    const hasPluginUiAuthority = input.pluginUiProjection != null;
    if (!hasPluginUiAuthority) {
        const cached = SESSION_VIEW_HEADER_PROPS_CACHE.get(cacheKey);
        if (cached) {
            return cached;
        }
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
    const pluginHeaderActions = resolvePluginSessionHeaderActionPresentations({
        projection: input.pluginUiProjection,
        locale: input.pluginUiLocale,
        scopedLaunchFacts: input.pluginUiScopedLaunchFacts,
        policyContext: createPluginUiPolicyEvaluationContext({
            platform: normalizePluginSurfacePlatform(Platform.OS),
            channel: 'internal',
        }),
    });
    const pluginHeaderActionPlacement = resolvePluginHeaderActionPlacement({
        shouldFoldHeaderIconActions,
        actionCount: pluginHeaderActions.length,
    });

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
        agentId,
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
                <SessionHeaderActionMenu
                    sessionId={input.sessionId}
                    session={session}
                    extraItems={resolvedHeaderMenuExtraItems.length > 0 ? resolvedHeaderMenuExtraItems : undefined}
                    onSelectExtraItem={input.handleHeaderExtraItemSelect}
                    pluginUiProjection={input.pluginUiProjection}
                    pluginUiScopedLaunchFacts={input.pluginUiScopedLaunchFacts}
                    pluginUiScopeIsCurrent={input.pluginUiScopeIsCurrent}
                    onOpenPluginSurface={input.onOpenPluginSurface}
                    pluginHeaderActions={pluginHeaderActions}
                    pluginHeaderActionPlacement={pluginHeaderActionPlacement}
                />
                {!shouldFoldHeaderIconActions ? (
                    <SessionHeaderSubagentsButton
                        scopeId={input.paneScopeId}
                        activeCount={input.subagentActiveCount}
                    />
                ) : null}
                <SessionHeaderTerminalButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
                <SessionHeaderBrowserButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
{/* Never folded. Session details used to be reachable by pressing the avatar, which was
                shown on every width; moving that navigation to an icon that folds below 520pt would
                delete the only path to it on phones rather than tidy the row. */}
                <SessionHeaderInfoButton onPress={openSessionInfo} />
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
                        <SessionHeaderIconWithCount
                            count={input.sessionAutomationsEnabledCount}
                            badgeColor={input.statusErrorColor}
                        >
                            <Icon
                                name="timer"
                                size={SESSION_HEADER_ICON_SIZE_PX}
                                color={input.headerTintColor}
                            />
                        </SessionHeaderIconWithCount>
                    </Pressable>
                ) : null}
            </View>
        ),
        badges: resolvedBadges,
        isConnected,
        flavor,
    };

    if (!hasPluginUiAuthority) {
        SESSION_VIEW_HEADER_PROPS_CACHE.set(cacheKey, next);
    }
    return next;
}
