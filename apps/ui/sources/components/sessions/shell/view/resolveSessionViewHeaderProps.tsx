import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';
import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { useDetailsTabHeaderActionsCompact } from '@/components/appShell/panes/details/header/DetailsTabHeader';

import type { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Platform, View } from 'react-native';

import { SessionHeaderActionMenu } from '@/components/sessions/actions/SessionHeaderActionMenu';
import { resolvePluginSessionHeaderActionPresentations } from '@/components/sessions/actions/pluginHeaderActions';
import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { SessionHeaderInfoButton } from '@/components/sessions/actions/SessionHeaderInfoButton';
import { SessionHeaderActionButton, SessionHeaderActionsRow, SessionHeaderGlyph } from '@/components/sessions/actions/SessionHeaderActionButton';
import { SessionHeaderRoleChip } from '@/components/roles/session/SessionHeaderRoleChip';
import { PendingNavigationPill } from '@/components/sessions/pendingNavigation/PendingNavigationPill';
import type { WorkSummary } from '@/components/sessions/work/workProjection';
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
import { getSessionAvatarId, getSessionName, getSessionStatus, getSessionSubtitle, resolveLockedSessionTitle } from '@/utils/sessions/sessionUtils';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { isVoiceConversationCustodySessionMetadata } from '@happier-dev/protocol/voice/sessionBinding';
import { readSessionRoleIdV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { createPluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { normalizePluginSurfacePlatform } from '@/components/plugins/surfaces/pluginSurfaceContext';

import { resolveSessionViewBadges } from './resolveSessionViewBadges';
import { resolveSessionViewHeaderActionItems } from './resolveSessionViewHeaderActionItems';
import {
    resolveExternalSessionIdentityPresentation,
} from '../../presentation/externalSessionIdentityPresentation';
import type { ExternalSessionRuntimePresentation } from '../../presentation/externalSessionRuntimePresentation';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveSessionCompanionHeaderPlacement } from '@/components/sessions/companion/sessionCompanionHeaderPlacement';
import { resolveSessionCompanionHeaderIntent } from '@/components/sessions/companion/sessionCompanionHeaderIntent';
import { readSessionBotFaceFacts, type SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { readBotActivity, type BotActivity } from '@/components/sessions/bots/botActivity';
import type { SessionCompanionPlacement } from '@/components/sessions/companion/layout/resolveSessionCompanionPlacement';
import type { SessionCompanionAvailability } from '@/components/sessions/companion/state/useSessionCompanionPreference';
import {
    SESSION_BOARD_DESTINATION,
    SESSION_BOARD_HEADER_MENU_ACTION_ID,
} from '@/components/sessions/board/sessionBoardDestination';

export type SessionViewHeaderProps = Readonly<{
    title: string;
    titleAccessory?: React.ReactNode;
    subtitle?: string;
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    onBackPress?: () => void;
    avatarId?: string;
    /** A Bot's face (Bot Sessions only); the avatar slot draws it instead of the generic avatar. */
    botFace?: SessionBotFaceFacts | null;
    botActivity?: BotActivity;
    agentId?: string | null;
    rightElement?: React.ReactNode;
    backgroundColor?: string;
    tintColor?: string;
    isConnected?: boolean;
    flavor?: string | null;
    constrainWidth?: boolean;
    /**
     * Present for a loaded Session: the header leaf re-reads the bot face, activity and connection from the
     * live runtime source, since the shell Session does not move with a turn's thinking/status writes.
     */
    liveStatusSource?: SessionViewHeaderLiveStatusSource;
}>;

export type SessionViewHeaderLiveStatusSource = Readonly<{
    session: Session;
    managedWakeProjection: ResolveSessionViewHeaderPropsInput['managedWakeProjection'];
}>;

/** The header's turn-dependent facts: one reading for the shell pass and the live leaf. */
export function resolveSessionViewHeaderLiveStatus(
    session: Session,
    managedWakeProjection: ResolveSessionViewHeaderPropsInput['managedWakeProjection'],
): Readonly<{ botFace: SessionBotFaceFacts | null; botActivity: BotActivity | undefined; isConnected: boolean }> {
    const nowMs = Date.now();
    const botFace = readSessionBotFaceFacts(session, session.serverId ?? null);
    const status = getSessionStatus(session, nowMs, { managedWakeProjection });
    return {
        botFace,
        botActivity: botFace ? readBotActivity(session, nowMs, status) : undefined,
        isConnected: status.isConnected,
    };
}

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
    managedWakeProjection?: ManagedWakeProjection | null;
    currentMachineId?: unknown;
    sessionId: string;
    sessionInfoHref: `/session/${string}`;
    sessionRunsHref: `/session/${string}`;
    sessionAutomationsHref: `/session/${string}`;
    paneScopeId: string;
    windowWidth: number;
    actionRailVisible?: boolean;
    mobileTerminalTabAvailable?: boolean;
    /** Browser is a destination of this Session on this device (desktop/web with Browser enabled). */
    browserMenuEntryAvailable?: boolean;
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
    router: Readonly<Pick<ReturnType<typeof useRouter>, 'push' | 'navigate'>>;
    actionIconColor: string;
    headerTintColor: string;
    statusErrorColor: string;
    workspaceSubtitle?: string | null;
    workspaceSubtitleEllipsizeMode?: 'head' | 'tail';
    /** A Voice conversation's place ("Global Voice · OpenAI Realtime"), which replaces its private folder. */
    voiceConversationSubtitle?: string;
    /**
     * The Session's created machine and its native power word ("do-bot-1", "Asleep"), from the machine
     * presence owner; null while the machine has no native lifecycle word to say.
     */
    machinePower?: Readonly<{ machineName: string | null; word: string }> | null;
    externalSessionRuntime: ExternalSessionRuntimePresentation | null;
    /**
     * Plugin-UI projection + open handler for the session header-action menu
     * (Phase 2.2 / finding #11). When provided, plugin-contributed header actions
     * are surfaced in the action menu and dispatched through their canonical
     * header-action owner.
     */
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiLocale?: string | null;
    localizePluginText?: PluginLocalizedTextResolver;
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
        return {
            title: t('errors.sessionDeleted'),
            subtitle: undefined,
            avatarId: undefined,
            rightElement: undefined,
            isConnected: false,
            flavor: null,
        };
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
        ? formatSessionPath(ownerMetadata.path, ownerMetadata.homeDir)
        : undefined;
    const workspaceSubtitle = typeof input.workspaceSubtitle === 'string' && input.workspaceSubtitle.length > 0
        ? input.workspaceSubtitle
        : undefined;
    // A Voice conversation names where it lives (Global Voice and its service); a no-folder session names
    // where it runs (its machine). Neither shows its private folder.
    const voiceConversation = isVoiceConversationCustodySessionMetadata(ownerMetadata);
    const locationSubtitle = voiceConversation
        ? input.voiceConversationSubtitle
        : readSessionDirectoryKind(ownerMetadata) === 'managed'
            ? getSessionSubtitle(session)
            : workspaceSubtitle ?? fallbackSubtitle;
    // Until a session is named it is titled after its folder; a subtitle repeating that says nothing.
    const placeSubtitle = locationSubtitle === title ? undefined : locationSubtitle;
    // A created machine that is asleep, starting or stopping is named with its word after the folder
    // (lab b-wake-S / b-wake-A); a no-folder Session's place already is that machine.
    // The word may already name the machine ("Starting do-bot-1…"); it then stands alone.
    const machinePower = voiceConversation ? null : input.machinePower ?? null;
    const machineName = machinePower?.machineName;
    const subtitleParts = [
        placeSubtitle,
        machineName && machineName !== placeSubtitle && !machinePower.word.includes(machineName) ? machineName : undefined,
        machinePower?.word,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0);
    const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' · ') : undefined;
    const subtitleEllipsizeMode = subtitle
        ? voiceConversation ? 'tail' as const : input.workspaceSubtitleEllipsizeMode ?? 'head' as const
        : undefined;
    const avatarId = getSessionAvatarId(session);
    const { botFace, botActivity, isConnected } = resolveSessionViewHeaderLiveStatus(session, input.managedWakeProjection);
    const liveStatusSource: SessionViewHeaderLiveStatusSource = { session, managedWakeProjection: input.managedWakeProjection };
    const agentId = readSessionPresentationAgentId(session);
    const flavor = agentId;
    // Only an external Session names its storage: every other Session here is a Happier Session,
    // and a badge saying so is healthy-state noise that costs the title its width.
    const resolvedStorageBadge = externalSessionIdentity.agentId !== null ? externalSessionIdentity.storageLabel : null;
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
            botFace,
            botActivity,
            agentId,
            badges: resolveSessionViewBadges({
                storageBadge: resolvedStorageBadge,
                providerBadge: resolvedProviderBadge,
            }),
            rightElement: undefined,
            isConnected,
            liveStatusSource,
            flavor,
        };
    }
    // The leaf subscribes to its selected role; catalog/snapshot edits do not invalidate the shell.
    // The role stays on every width; a tight title row takes its compact mark (SessionPaneHeader).
    const roleId = readSessionRoleIdV1(ownerMetadata);
    // SessionView owns mounted identity with useMemo. Global retention would keep
    // pane callbacks and their component trees alive after navigation.

    const resolvedBadges = resolveSessionViewBadges({
        storageBadge: resolvedStorageBadge,
        providerBadge: resolvedProviderBadge,
    });
    // The rail carries Work, Terminal, Browser, People and Computer; while it is not on screen they are
    // reached from ⋯ (calm-shell R2-1). Activity lives in the title strip, Automations in ⋯ and Habits.
    const destinationsInMenu = input.actionRailVisible !== true;
    const resolvedFoldedHeaderItems = resolveSessionViewHeaderActionItems({
        destinationsInMenu,
        workAvailable: input.shouldShowSubagentsButton || (input.workSummary?.outstanding ?? 0) > 0,
        workCount: input.workSummary?.outstanding ?? input.subagentActiveCount,
        terminalAvailable: !input.mobileTerminalTabAvailable,
        browserAvailable: input.browserMenuEntryAvailable === true,
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
        localize: input.localizePluginText,
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
    // Board, Companion and plugin actions keep their scope and invocation but live in ⋯: the header
    // carries only what is about this Session's state (calm-shell `cshead.H1`).
    const companionHeaderActionPlacement = preferredCompanionPlacement === null ? null : 'overflow';
    const companionHeaderIntent = input.companionHeaderAction
        ? resolveSessionCompanionHeaderIntent(input.companionHeaderAction)
        : null;
    if (input.boardHeaderAction) {
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
    const pluginHeaderActionPlacement = 'overflow' as const;

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
        titleAccessory: roleId ? <SessionHeaderRoleChip
            sessionId={input.sessionId}
            serverId={session.serverId ?? null}
            roleId={roleId}
        /> : undefined,
        subtitle,
        subtitleEllipsizeMode,
        avatarId,
        botFace,
        botActivity,
        agentId,
        rightElement: (
            <SessionHeaderActionsRow>
                <PendingNavigationPill address={normalizeSessionAddress(session.serverId, input.sessionId)} presentation="header" />
                {/* No current evidence about the external Agent shows nothing rather than an "unknown" chip. */}
                {input.externalSessionRuntime && input.externalSessionRuntime.externalAgent.state !== 'unknown' ? (
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
                        <WorkStatusGlyph
                            status={resolveWorkStatusTone({ kind: 'external_agent', facts: {
                                externalAgent: input.externalSessionRuntime.externalAgent,
                                word: t(input.externalSessionRuntime.externalAgent.labelKey),
                            } })}
                            testIDSuffix={`${input.sessionId}-header-external`}
                        />
                        <HeaderChipLabel>
                            <Text
                                numberOfLines={1}
                                style={{
                                    color: input.actionIconColor,
                                    ...Typography.variant('meta', 'semiBold'),
                                }}
                            >
                                {t(input.externalSessionRuntime.externalAgent.labelKey)}
                            </Text>
                        </HeaderChipLabel>
                    </View>
                ) : null}
                {workspaceSyncAttentionLabel && input.onOpenWorkspaceSyncConflicts ? (
                    <SessionHeaderActionButton
                        onPress={input.onOpenWorkspaceSyncConflicts}
                        accessibilityLabel={workspaceSyncAttentionLabel}
                    >
                        <SessionHeaderIconWithCount
                            count={workspaceSyncAttentionBadgeCount}
                            badgeColor={input.statusErrorColor}
                        >
                            <SessionHeaderGlyph name="warning" color={input.headerTintColor} />
                        </SessionHeaderIconWithCount>
                    </SessionHeaderActionButton>
                ) : null}
                {/* Follow (a quiet chip) and the one ⋯ with every rare entry. */}
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
                    destinationsInMenu={destinationsInMenu}
                    // Session details live in the rail's Info tab; without a visible rail the header keeps (i), before ⋯.
                    beforeMenu={destinationsInMenu ? <SessionHeaderInfoButton onPress={openSessionInfo} /> : null}
                />
            </SessionHeaderActionsRow>
        ),
        badges: resolvedBadges,
        isConnected,
        liveStatusSource,
        flavor,
    };

    return next;
}

/** A header chip's words, left out while the header is tight; its accessible label and mark stay. */
function HeaderChipLabel(props: Readonly<{ children: React.ReactNode }>): React.ReactElement | null {
    return useDetailsTabHeaderActionsCompact() ? null : <>{props.children}</>;
}
