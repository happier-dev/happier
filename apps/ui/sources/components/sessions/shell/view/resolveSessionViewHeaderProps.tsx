import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';

import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { resolvePluginSessionHeaderActionPresentations } from '@/components/sessions/actions/pluginHeaderActions';
import { SessionHeaderBrowserButton } from '@/components/sessions/actions/SessionHeaderBrowserButton';
import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { SessionHeaderInfoButton } from '@/components/sessions/actions/SessionHeaderInfoButton';
import {
    SESSION_HEADER_ACTION_TAP_TARGET_PX,
    SESSION_HEADER_ICON_SIZE_PX,
} from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderSubagentsButton } from '@/components/sessions/actions/SessionHeaderSubagentsButton';
import { SessionHeaderTerminalButton } from '@/components/sessions/actions/SessionHeaderTerminalButton';
import { SessionHeaderWorkStrip } from '@/components/sessions/work/SessionHeaderWorkStrip';
import { PendingNavigationPill } from '@/components/sessions/pendingNavigation/PendingNavigationPill';
import { EMPTY_WORK_SUMMARY, type WorkSummary } from '@/components/sessions/work/workProjection';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { WorkspaceSyncSetAttention } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { formatWorkspaceSyncSetAttention } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import { isSessionRouteHydrationPending } from '@/sync/domains/session/sessionRouteHydrationState';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { formatPathRelativeToHome, getSessionAvatarId, getSessionName, getSessionStatus, getSessionSubtitle, resolveLockedSessionTitle } from '@/utils/sessions/sessionUtils';
import { readSessionDirectoryKind } from '@happier-dev/protocol';
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
import { Icon } from '@/components/ui/icons/Icon';
import { ActionOperationActivityButton } from '@/components/inbox/actionOperations/ActionOperationActivityButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { resolveSessionCompanionHeaderPlacement } from '@/components/sessions/companion/sessionCompanionHeaderPlacement';
import { resolveSessionCompanionHeaderIntent } from '@/components/sessions/companion/sessionCompanionHeaderIntent';
import type { SessionCompanionPlacement } from '@/components/sessions/companion/layout/resolveSessionCompanionPlacement';
import type { SessionCompanionAvailability } from '@/components/sessions/companion/state/useSessionCompanionPreference';
import {
    SESSION_BOARD_DESTINATION,
    SESSION_BOARD_HEADER_MENU_ACTION_ID,
} from '@/components/sessions/board/sessionBoardDestination';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const WORKSPACE_SYNC_CONFLICT_TARGET_SIZE = Math.max(
    SESSION_HEADER_ACTION_TAP_TARGET_PX,
    resolveMinimumInteractiveTargetSize(Platform.OS),
);
const WORKSPACE_SYNC_CONFLICT_HIT_SLOP = Math.max(
    0,
    (WORKSPACE_SYNC_CONFLICT_TARGET_SIZE - SESSION_HEADER_ACTION_TAP_TARGET_PX) / 2,
);

export type SessionViewHeaderProps = Readonly<{
    title: string;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    avatarId?: string;
    agentId?: string | null;
    rightElement?: React.ReactNode;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    constrainWidth?: boolean;
}>;

/**
 * Which settled blocked surface owns the body right now. A blocked Session keeps its safe title and
 * Home context but drops every content-derived action, because none of them can act on a transcript
 * this viewer cannot read.
 */
export type SessionViewHeaderBlockedSurface = 'access_denied' | 'content_blocked';

type ResolveSessionViewHeaderPropsInput = Readonly<{
    isDataReady: boolean;
    routeHydrationState?: SessionRouteHydrationState | null;
    blockedSurface?: SessionViewHeaderBlockedSurface | null;
    session: Session | null;
    currentMachineId?: unknown;
    sessionId: string;
    sessionInfoHref: string;
    sessionRunsHref: string;
    sessionAutomationsHref: string;
    paneScopeId: string;
    windowWidth: number;
    actionRailVisible?: boolean;
    mobileTerminalTabAvailable?: boolean;
    sessionAutomationsEnabledCount: number;
    sessionExecutionRunsSupported: boolean;
    showAutomations: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    /** The Work projection's closed summary (ORC R-09): the in-row strip reads nothing else. */
    workSummary?: WorkSummary;
    navigateWithBlurOnWeb: (action: () => void) => void;
    handleHeaderExtraItemSelect: (actionId: string) => boolean;
    headerMenuExtraItems?: ReadonlyArray<DropdownMenuItem>;
    collaborationHeader?: Readonly<{
        target: SessionAddress;
        compact: boolean;
    }>;
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
    actionAccountLifetime?: ServerAccountScopeLifetime | null;
    onOpenPluginSurface?: PluginSurfaceOpenHandler;
    workspaceSyncAttention?: WorkspaceSyncSetAttention;
    onOpenWorkspaceSyncConflicts?: () => void;
    /** Board is direct only when the shell's existing width budget admits it. */
    boardHeaderAction?: Readonly<{
        onPress: () => void;
        /** Existing content or an already-open Board may claim the one optional direct slot. */
        preferDirect: boolean;
    }>;
    /** Current exact-realm facts used by the one optional-action selector. */
    companionHeaderAction?: Readonly<{
        availability: SessionCompanionAvailability;
        preferenceExists: boolean;
        visible: boolean;
        itemCount: number;
        placement: SessionCompanionPlacement;
        isPhone: boolean;
    }>;
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

type OptionalHeaderActionOwner = 'board' | 'companion' | 'plugin';

/** The incumbent header owns exactly one optional direct action. */
function resolveOptionalHeaderActionOwner(input: Readonly<{
    shouldFoldHeaderIconActions: boolean;
    boardPrefersDirect: boolean;
    companionPrefersDirect: boolean;
    pluginActionCount: number;
}>): OptionalHeaderActionOwner | null {
    if (input.shouldFoldHeaderIconActions) return null;
    if (input.boardPrefersDirect) return 'board';
    if (input.companionPrefersDirect) return 'companion';
    return input.pluginActionCount === 1 ? 'plugin' : null;
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
    agentId: string | null | undefined;
    sessionInfoHref: string;
    sessionRunsHref: string;
    sessionAutomationsHref: string;
    isConnected: boolean;
    flavor: string | null;
    storageBadge: string;
    providerBadge: string | null;
    actionRailVisible: boolean;
    mobileTerminalTabAvailable: boolean;
    shouldFoldHeaderIconActions: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    workOutstandingCount: number;
    workNeedsYouCount: number;
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
    pluginUiInteractionEnabled: boolean;
    externalAgentState: ExternalSessionRuntimePresentation['externalAgent']['state'] | null;
    workspaceSyncConflictedLinkCount: number;
    workspaceSyncUnknownLinkCount: number;
    hasBoardHeaderAction: boolean;
    companionAvailability: SessionCompanionAvailability | null;
    companionPreferenceExists: boolean;
    companionVisible: boolean;
    companionItemCount: number;
    // The Companion header intent reads both of these, so a key without them
    // serves a stale intent when only the placement facts move.
    companionPlacement: SessionCompanionPlacement | null;
    companionIsPhone: boolean;
    hasCollaborationHeader: boolean;
}>): string {
    return JSON.stringify([
        input.sessionId,
        input.sessionServerId ?? '',
        input.sessionMachineId ?? '',
        input.title,
        input.subtitle ?? '',
        input.subtitleEllipsizeMode ?? '',
        input.avatarId ?? '',
        input.agentId ?? '',
        input.sessionInfoHref,
        input.sessionRunsHref,
        input.sessionAutomationsHref,
        input.isConnected,
        input.flavor ?? '',
        input.storageBadge,
        input.providerBadge ?? '',
        input.actionRailVisible,
        input.mobileTerminalTabAvailable,
        input.shouldFoldHeaderIconActions,
        input.shouldShowSubagentsButton,
        input.subagentActiveCount,
        input.workOutstandingCount,
        input.workNeedsYouCount,
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
        input.pluginUiInteractionEnabled,
        input.externalAgentState ?? '',
        input.workspaceSyncConflictedLinkCount,
        input.workspaceSyncUnknownLinkCount,
        input.hasBoardHeaderAction,
        input.companionAvailability ?? '',
        input.companionPreferenceExists,
        input.companionVisible,
        input.companionItemCount,
        input.companionPlacement,
        input.companionIsPhone,
        input.hasCollaborationHeader,
    ]);
}

export function shouldFoldSessionHeaderIconActions(windowWidth: number): boolean {
    return windowWidth < 520;
}

export function resolveSessionViewHeaderProps(input: ResolveSessionViewHeaderPropsInput): SessionViewHeaderProps {
    // Explicit denial outranks hydration progress and the deleted shell: a revoked Session is not
    // missing, and its cached title is no longer ours to display.
    if (input.blockedSurface === 'access_denied') {
        return {
            title: t('session.access.removedTitle'),
            subtitle: undefined,
            avatarId: undefined,
            rightElement: undefined,
            isConnected: false,
            flavor: null,
        };
    }

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
    const shouldFoldHeaderIconActions = shouldFoldSessionHeaderIconActions(input.windowWidth);
    const badgeLabel = input.sessionAutomationsEnabledCount > 99 ? '99+' : String(input.sessionAutomationsEnabledCount);
    const title = getSessionName(session);
    const fallbackSubtitle = ownerMetadata?.path
        ? formatPathRelativeToHome(ownerMetadata.path, ownerMetadata.homeDir)
        : undefined;
    const workspaceSubtitle = typeof input.workspaceSubtitle === 'string' && input.workspaceSubtitle.length > 0
        ? input.workspaceSubtitle
        : undefined;
    // A no-folder session names where it runs (its machine), never its private folder.
    const subtitle = readSessionDirectoryKind(ownerMetadata) === 'managed'
        ? getSessionSubtitle(session)
        : workspaceSubtitle ?? fallbackSubtitle;
    const subtitleEllipsizeMode = subtitle
        ? input.workspaceSubtitleEllipsizeMode ?? 'head' as const
        : undefined;
    const avatarId = getSessionAvatarId(session);
    const agentId = resolveAgentIdFromSessionMetadata(session.metadata)
        ?? resolveAgentIdFromFlavor(session.metadata?.flavor ?? null);
    const isConnected = getSessionStatus(session).isConnected;
    const flavor = readSessionPresentationAgentId(session) ?? ownerMetadata?.flavor ?? null;
    const resolvedStorageBadge = externalSessionIdentity.storageLabel;
    const resolvedProviderBadge = externalSessionIdentity.identityLabel;

    if (input.blockedSurface === 'content_blocked') {
        // Keep the safe identity a locked Session may still show, and drop the action row: every
        // one of those controls acts on transcript-derived state this viewer cannot read yet.
        // The locked-title rule lives with the list row's owner so both surfaces name a
        // locked Session identically.
        return {
            title: resolveLockedSessionTitle(title),
            subtitle,
            subtitleEllipsizeMode,
            avatarId,
            agentId,
            badges: resolveSessionViewBadges({
                storageBadge: resolvedStorageBadge,
                providerBadge: resolvedProviderBadge,
            }),
            rightElement: undefined,
            isConnected,
            flavor,
        };
    }
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
        actionRailVisible: input.actionRailVisible === true,
        mobileTerminalTabAvailable: input.mobileTerminalTabAvailable === true,
        shouldFoldHeaderIconActions,
        shouldShowSubagentsButton: input.shouldShowSubagentsButton,
        subagentActiveCount: input.subagentActiveCount,
        workOutstandingCount: input.workSummary?.outstanding ?? 0,
        workNeedsYouCount: input.workSummary?.needsYou ?? 0,
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
        pluginUiInteractionEnabled: input.pluginUiScopedLaunchFacts?.interactionEnabled === true,
        externalAgentState: input.externalSessionRuntime?.externalAgent.state ?? null,
        workspaceSyncConflictedLinkCount: input.workspaceSyncAttention?.conflictedLinkCount ?? 0,
        workspaceSyncUnknownLinkCount: input.workspaceSyncAttention?.unknownLinkCount ?? 0,
        hasBoardHeaderAction: input.boardHeaderAction !== undefined,
        companionAvailability: input.companionHeaderAction?.availability ?? null,
        companionPreferenceExists: input.companionHeaderAction?.preferenceExists === true,
        companionVisible: input.companionHeaderAction?.visible === true,
        companionItemCount: input.companionHeaderAction?.itemCount ?? 0,
        companionPlacement: input.companionHeaderAction?.placement ?? null,
        companionIsPhone: input.companionHeaderAction?.isPhone === true,
        hasCollaborationHeader: input.collaborationHeader !== undefined,
    });

    // Plugin actions and workspace-conflict navigation carry live authority.
    // Scalar cache keys cannot distinguish a same-generation successor or a
    // same-count conflict moving between relationships, so retain the LRU only
    // for authority-free headers rather than caching stale action closures.
    const hasLiveUiAuthority = input.pluginUiProjection != null
        || (input.workspaceSyncAttention?.conflictedLinkCount ?? 0) > 0
        || (input.workspaceSyncAttention?.unknownLinkCount ?? 0) > 0
        || input.boardHeaderAction !== undefined;
    if (!hasLiveUiAuthority) {
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
    const preferredCompanionPlacement = input.companionHeaderAction
        ? resolveSessionCompanionHeaderPlacement({
            ...input.companionHeaderAction,
            headerActionsFolded: shouldFoldHeaderIconActions,
        })
        : null;
    // Board content/open state has the established first claim. A deliberate
    // Companion preference follows, then a sole plugin action. Every unselected
    // candidate remains in the incumbent overflow menu.
    const optionalDirectActionOwner = resolveOptionalHeaderActionOwner({
        shouldFoldHeaderIconActions,
        boardPrefersDirect: !input.actionRailVisible && input.boardHeaderAction?.preferDirect === true,
        companionPrefersDirect: preferredCompanionPlacement === 'direct',
        pluginActionCount: pluginHeaderActions.length,
    });
    const boardHeaderActionPlacement = optionalDirectActionOwner === 'board' ? 'direct' : 'overflow';
    const companionHeaderActionPlacement = preferredCompanionPlacement === null
        ? null
        : optionalDirectActionOwner === 'companion'
            ? 'direct'
            : 'overflow';
    const companionHeaderIntent = input.companionHeaderAction
        ? resolveSessionCompanionHeaderIntent(input.companionHeaderAction)
        : null;
    if (input.boardHeaderAction && boardHeaderActionPlacement === 'overflow') {
        resolvedHeaderMenuExtraItems.push({
            id: SESSION_BOARD_HEADER_MENU_ACTION_ID,
            title: t(SESSION_BOARD_DESTINATION.labelKey),
            icon: <Icon
                name={SESSION_BOARD_DESTINATION.icon}
                size={16}
                color={input.actionIconColor}
            />,
        });
    }
    const pluginHeaderActionPlacement = optionalDirectActionOwner === 'plugin' ? 'direct' : 'overflow';
    const headerInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const headerInteractiveHitSlop = headerInteractiveTargetSize > SESSION_HEADER_ACTION_TAP_TARGET_PX
        ? undefined
        : 15;

    // Keeps dev's web-blur wrapper: navigating away from a focused web control without blurring it
    // leaves the caret behind on the outgoing screen.
    const openSessionInfo = () => input.navigateWithBlurOnWeb(() => input.router.navigate(input.sessionInfoHref as any, {
        dangerouslySingular() {
            return 'session-info';
        },
    } as any));
    const workspaceSyncAttentionLabel = input.workspaceSyncAttention
        ? formatWorkspaceSyncSetAttention(input.workspaceSyncAttention)
        : null;
    const workspaceSyncAttentionBadgeCount = input.workspaceSyncAttention?.conflictedLinkCount
        || input.workspaceSyncAttention?.unknownLinkCount || 0;

    const next: SessionViewHeaderProps = {
        title,
        subtitle,
        subtitleEllipsizeMode,
        avatarId,
        agentId,
        rightElement: (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <PendingNavigationPill address={normalizeSessionAddress(session.serverId, input.sessionId)} presentation="header" />
                <ActionOperationActivityButton
                    preferredSessionAddress={normalizeSessionAddress(session.serverId, input.sessionId)}
                    testID="session-header-action-operations"
                    buttonSize={SESSION_HEADER_ACTION_TAP_TARGET_PX}
                    iconSize={SESSION_HEADER_ICON_SIZE_PX}
                />
                {boardHeaderActionPlacement === 'direct' && input.boardHeaderAction ? (
                    <Pressable
                        testID="session-header-board-button"
                        onPress={input.boardHeaderAction.onPress}
                        hitSlop={headerInteractiveHitSlop}
                        style={({ pressed }) => ({
                            width: headerInteractiveTargetSize,
                            height: headerInteractiveTargetSize,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? motionTokens.press.opacity : 1,
                        })}
                        accessibilityRole="button"
                        accessibilityLabel={t(SESSION_BOARD_DESTINATION.labelKey)}
                    >
                        <Icon
                            name={SESSION_BOARD_DESTINATION.icon}
                            size={SESSION_HEADER_ICON_SIZE_PX}
                            color={input.headerTintColor}
                        />
                    </Pressable>
                ) : null}
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
                    actionAccountLifetime={input.actionAccountLifetime}
                    onOpenPluginSurface={input.onOpenPluginSurface}
                    pluginHeaderActions={pluginHeaderActions}
                    pluginHeaderActionPlacement={pluginHeaderActionPlacement}
                    companionHeaderActionPlacement={companionHeaderActionPlacement}
                    companionHeaderIntent={companionHeaderIntent}
                    collaborationHeader={input.collaborationHeader}
                />
                {!shouldFoldHeaderIconActions && (input.workSummary?.outstanding ?? 0) > 0 ? (
                    <SessionHeaderWorkStrip
                        sessionId={input.sessionId}
                        serverId={session.serverId ?? null}
                        scopeId={input.paneScopeId}
                        summary={input.workSummary ?? EMPTY_WORK_SUMMARY}
                    />
                ) : !shouldFoldHeaderIconActions && !input.actionRailVisible ? (
                    <SessionHeaderSubagentsButton
                        scopeId={input.paneScopeId}
                        activeCount={input.subagentActiveCount}
                    />
                ) : null}
                {!input.actionRailVisible && !input.mobileTerminalTabAvailable ? (
                    <SessionHeaderTerminalButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
                ) : null}
                <SessionHeaderBrowserButton sessionId={input.sessionId} scopeId={input.paneScopeId} />
                {workspaceSyncAttentionLabel && input.onOpenWorkspaceSyncConflicts ? (
                    <Pressable
                        onPress={input.onOpenWorkspaceSyncConflicts}
                        hitSlop={WORKSPACE_SYNC_CONFLICT_HIT_SLOP}
                        style={({ pressed }) => ({
                            width: SESSION_HEADER_ACTION_TAP_TARGET_PX,
                            height: SESSION_HEADER_ACTION_TAP_TARGET_PX,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: pressed ? motionTokens.press.opacity : 1,
                        })}
                        accessibilityRole="button"
                        accessibilityLabel={workspaceSyncAttentionLabel}
                    >
                        <SessionHeaderIconWithCount
                            count={workspaceSyncAttentionBadgeCount}
                            badgeColor={input.statusErrorColor}
                        >
                            <Icon name="warning" size={SESSION_HEADER_ICON_SIZE_PX} color={input.headerTintColor} />
                        </SessionHeaderIconWithCount>
                    </Pressable>
                ) : null}
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
                            opacity: pressed ? motionTokens.press.opacity : 1,
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

    if (!hasLiveUiAuthority) {
        SESSION_VIEW_HEADER_PROPS_CACHE.set(cacheKey, next);
    }
    return next;
}
