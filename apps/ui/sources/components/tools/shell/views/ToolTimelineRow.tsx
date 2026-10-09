import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import { useToolFeedRowDisplaySettings, type ToolViewDisplaySettings } from './toolViewDisplaySettings';
import { ToolInlineBody } from '@/components/tools/shell/views/ToolInlineBody';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';
import { buildToolHeaderModel } from '@/components/tools/shell/presentation/buildToolHeaderModel';
import { deriveToolTimelineDensity } from '@/components/tools/normalization/policy/deriveToolTimelineDensity';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import {
    isPendingUserActionRequest,
    resolvePermissionPromptSurface,
    shouldShowGenericPermissionPromptForRequest,
} from '@/utils/sessions/permissions/permissionPromptPolicy';
import { t } from '@/text';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    resolveToolViewExpandedDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
    type ToolViewExpandedDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import { ToolTimelineRowHeader } from '@/components/tools/shell/views/timeline/ToolTimelineRowHeader';
import { TranscriptJumpAttention } from '@/components/sessions/transcript/navigation/TranscriptJumpHighlightOverlay';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { resolveToolTranscriptSidechainId } from './resolveToolTranscriptSidechainId';
import {
    SidechainHydrationInlineStatus,
    shouldShowSidechainHydrationInlineStatus,
} from './SidechainHydrationInlineStatus';
import { isGenericSubAgentToolName, isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { buildToolCallMessageRouteId } from "@happier-dev/session-core/messages";
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { usePendingPromptLanding } from '../permissions/usePendingPromptPrimaryFocus';
import { resolvePermissionRequestId } from '@/components/tools/renderers/core/resolvePermissionRequestId';
import { ApprovalPromptCard } from '../approvals/ApprovalPromptCard';
import { resolveInactiveSessionToolCallFailure } from '../permissions/resolveInactiveSessionToolCallFailure';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { Text } from '@/components/ui/text/Text';
import { resolveToolErrorSummary } from '@/components/tools/shell/presentation/resolveToolErrorSummary';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { buildApprovalToolCallLocation, doesApprovalMatchToolCall } from './toolApprovalPromptMatching';
import { isAskUserQuestionToolName } from '@happier-dev/protocol/activity/agentRequestSummary';
import { resolveToolPermissionTerminalErrorMessage } from '@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage';
import { Icon } from '@/components/ui/icons/Icon';
import {
    TranscriptRowSeqProvider,
    useHistoricalTranscriptAgentId,
} from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { SessionBoardActionResultReference } from '@/components/sessions/transcript/references/SessionBoardActionResultReference';
import { WorkflowRunActionResultReference } from '@/components/sessions/transcript/references/WorkflowRunActionResultReference';
import { readTranscriptProjectCommandCall } from '@/components/sessions/transcript/references/transcriptProjectCommandReference';
import { ProjectCommandToolTimelineRowHeader } from './timeline/ProjectCommandToolTimelineRowHeader';
import { WorkflowDefinitionActionResultReference } from '@/components/sessions/transcript/references/WorkflowDefinitionActionResultReference';
import { BrowserActionResultReference } from '@/components/sessions/transcript/references/BrowserActionResultReference';
import { ComputerActionResultReference } from '@/components/sessions/transcript/references/ComputerActionResultReference';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { useTranscriptFindRow } from '@/components/sessions/transcript/find/TranscriptFindContext';

const TOOL_TIMELINE_ROW_HIGHLIGHT_RADIUS = 10;

type ToolTimelineRowProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages?: Message[];
    sessionId?: string;
    serverId?: string;
    messageId?: string;
    /** Row seq, so a seq-targeted transcript jump can land its highlight here. */
    jumpHighlightSeq?: number | null;
    headerAction?: ToolRowPinAction | null;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    forcePermissionPromptsInTranscript?: boolean;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: TranscriptPermissionDisabledReason;
    };
};

/**
 * A tool call as an activity-feed row. It reads its display settings from the store unless
 * `displaySettings` is given (settings previews); the choice is fixed for a given caller, so the
 * row never switches between the two while mounted.
 */
export const ToolTimelineRow = React.memo((props: ToolTimelineRowProps & { displaySettings?: ToolViewDisplaySettings }) => (
    props.displaySettings
        ? <ToolTimelineRowContent {...props} displaySettings={props.displaySettings} />
        : <ToolTimelineRowWithStoreSettings {...props} />
));

const ToolTimelineRowWithStoreSettings = React.memo((props: ToolTimelineRowProps) => {
    const displaySettings = useToolFeedRowDisplaySettings();
    return <ToolTimelineRowContent {...props} displaySettings={displaySettings} />;
});

const ToolTimelineRowContent = React.memo((props: ToolTimelineRowProps & { displaySettings: ToolViewDisplaySettings }) => {
    const { theme } = useUnistyles();
    const transcriptSource = useSessionTranscriptSource();
    const sourceInteraction = transcriptSource.useInteraction();
    const interaction = props.interaction ?? sourceInteraction;
    // The canonical transcript row sequence. It already reaches this component
    // for jump targeting; historical Agent attribution is its second reader, and
    // it is published to the whole tool subtree so the body, the permission
    // footer and the full view resolve the same Agent without six layers of
    // prop drilling.
    const transcriptSeq = props.jumpHighlightSeq ?? null;
    const historicalAgentId = useHistoricalTranscriptAgentId(transcriptSeq);

    const toolForSession = React.useMemo(() => {
        return resolveInactiveSessionToolCallFailure({
            tool: props.tool,
            permissionDisabledReason: interaction.permissionDisabledReason,
        });
    }, [interaction.permissionDisabledReason, props.tool]);

    const headerModel = React.useMemo(() => {
        return buildToolHeaderModel({
            tool: toolForSession,
            metadata: props.metadata,
            iconSize: 18,
            iconColorPrimary: theme.colors.text.primary,
            iconColorSecondary: theme.colors.text.secondary,
            historicalAgentId,
        });
    }, [historicalAgentId, props.metadata, theme.colors.text.primary, theme.colors.text.secondary, toolForSession]);
    const toolForRendering = headerModel.toolForRendering;
    const pendingLanding = usePendingPromptLanding(resolvePermissionRequestId(toolForRendering), props.messageId);
    const pendingLandingToken = props.messageId ? pendingLanding?.token : undefined;

    const {
        toolViewDetailLevelDefault,
        toolViewDetailLevelDefaultLocalControl,
        toolViewDetailLevelByToolName,
        toolViewTapAction,
        toolViewExpandedDetailLevelDefault,
        toolViewExpandedDetailLevelByToolName,
        toolViewTimelineFeedDefaultExpanded,
        permissionPromptSurface,
    } = props.displaySettings;

    const isWaitingForPermission = headerModel.isWaitingForPermission;
    const isPendingUserAction = isPendingUserActionRequest({
        toolName: toolForRendering.name,
        requestKind: toolForRendering.permission?.kind,
        permissionStatus: toolForRendering.permission?.status,
    });
    const forceExpandedForPendingUserAction = isPendingUserAction;

    const initialIsExpandedRef = React.useRef<boolean>(toolViewTimelineFeedDefaultExpanded === true || forceExpandedForPendingUserAction || pendingLandingToken !== undefined);
    const [isExpanded, setIsExpanded] = React.useState<boolean>(initialIsExpandedRef.current);
    const [expandedByUser, setExpandedByUser] = React.useState<boolean>(false);
    const find = useTranscriptFindRow(props.messageId);
    const findBodyReveal = find?.reveal && find.reveal.blockId !== 'tool-title';
    const findRevealId = findBodyReveal ? find?.reveal?.requestId : undefined;
    React.useEffect(() => {
        if (findRevealId !== undefined) setIsExpanded(true);
    }, [findRevealId]);
    React.useEffect(() => {
        if (pendingLandingToken !== undefined) setIsExpanded(true);
    }, [pendingLandingToken]);

    React.useEffect(() => {
        if (!forceExpandedForPendingUserAction) return;
        setIsExpanded(true);
    }, [forceExpandedForPendingUserAction]);

    const routeMessageId = React.useMemo(() => {
        return buildToolCallMessageRouteId({
            toolId: typeof toolForRendering.id === 'string' ? toolForRendering.id : null,
            fallbackMessageId: props.messageId,
        });
    }, [props.messageId, toolForRendering.id]);

    const handleOpen = React.useCallback(() => {
        const sessionId = props.sessionId;
        if (!sessionId || !routeMessageId) return;
        navigateWithBlurOnWeb(() => {
            transcriptSource.navigate?.(buildScopedSessionRouteHref({
                sessionId,
                serverId: props.serverId,
                suffix: `/message/${encodeURIComponent(routeMessageId)}`,
            }));
        });
    }, [props.serverId, props.sessionId, routeMessageId, transcriptSource]);

    const canOpen = transcriptSource.navigate !== null && !!(props.sessionId && routeMessageId);
    const primaryTapAction: 'expand' | 'open' =
        toolViewTapAction === 'open' && canOpen ? 'open' : 'expand';

    const handleToggleExpand = React.useCallback(() => {
        if (forceExpandedForPendingUserAction) return;
        const next = !isExpanded;
        setIsExpanded(next);
        // Only show the persistent "expanded" chevron when the tool started collapsed and the user expanded it.
        if (initialIsExpandedRef.current === false && next === true) {
            setExpandedByUser(true);
        } else {
            setExpandedByUser(false);
        }
    }, [forceExpandedForPendingUserAction, isExpanded]);

    const onPress = primaryTapAction === 'open' ? handleOpen : handleToggleExpand;

    const normalizedToolName = headerModel.normalizedToolName;
    const title = headerModel.title;
    const subtitle = headerModel.subtitle;
    const statusText = headerModel.statusText;
    const shouldHideBodyPermanently = headerModel.shouldHideBodyPermanently;
    const shouldCollapseUnknownToolByDefault = headerModel.shouldCollapseUnknownToolByDefault;

    const normalizedToolViewDetailLevelDefaultSetting: ToolViewDetailLevelSetting =
        toolViewDetailLevelDefault === 'default' ||
        toolViewDetailLevelDefault === 'title' ||
        toolViewDetailLevelDefault === 'compact' ||
        toolViewDetailLevelDefault === 'summary' ||
        toolViewDetailLevelDefault === 'full'
            ? toolViewDetailLevelDefault
            : 'default';

    const normalizedToolViewExpandedDetailLevelDefaultSetting: ToolViewExpandedDetailLevelSetting =
        toolViewExpandedDetailLevelDefault === 'default' ||
        toolViewExpandedDetailLevelDefault === 'summary' ||
        toolViewExpandedDetailLevelDefault === 'full'
            ? toolViewExpandedDetailLevelDefault
            : 'default';

    const resolvedDetailLevelDefault = resolveToolViewDetailLevelDefaultForChromeMode({
        chromeMode: 'activity_feed',
        setting: normalizedToolViewDetailLevelDefaultSetting,
    });
    const resolvedExpandedDetailLevelDefault = resolveToolViewExpandedDetailLevelDefaultForChromeMode({
        chromeMode: 'activity_feed',
        setting: normalizedToolViewExpandedDetailLevelDefaultSetting,
    });

    const collapsedDetailLevel =
        toolForRendering.name.startsWith('mcp__') || shouldCollapseUnknownToolByDefault
            ? 'title'
            : resolveToolViewDetailLevel({
                  toolName: normalizedToolName,
                  toolInput: toolForRendering.input,
                  detailLevelDefault: resolvedDetailLevelDefault,
                  detailLevelDefaultLocalControl: toolViewDetailLevelDefaultLocalControl,
                  detailLevelByToolName: toolViewDetailLevelByToolName as any,
              });

    const expandedDetailLevel: 'summary' | 'full' =
        (toolViewExpandedDetailLevelByToolName as any)?.[normalizedToolName] ?? resolvedExpandedDetailLevelDefault;

    const effectiveIsExpanded = forceExpandedForPendingUserAction || pendingLandingToken !== undefined ? true : isExpanded;

    const transcriptSidechainId = React.useMemo(() => {
        return resolveToolTranscriptSidechainId({ tool: toolForRendering, normalizedToolName });
    }, [normalizedToolName, toolForRendering]);
    const isSubAgentTranscriptTool = isSubAgentTranscriptToolName(normalizedToolName);

    const sidechainHydration = useEnsureSidechainsLoaded({
        enabled:
            effectiveIsExpanded &&
            transcriptSource.loadSidechain !== null &&
            isSubAgentTranscriptTool,
        sessionId: props.sessionId,
        loadSidechain: transcriptSource.loadSidechain,
        sidechainIds: [transcriptSidechainId],
    });
    const toolMessages = props.messages ?? [];
    const sidechainHydrationStatus = transcriptSidechainId
        ? sidechainHydration.bySidechainId[transcriptSidechainId]?.status ?? sidechainHydration.status
        : sidechainHydration.status;
    const showSidechainHydrationStatus =
        effectiveIsExpanded &&
        isSubAgentTranscriptTool &&
        shouldShowSidechainHydrationInlineStatus({
            messageCount: toolMessages.length,
            sidechainId: transcriptSidechainId,
            status: sidechainHydrationStatus,
        });

    const effectiveDetailLevel = effectiveIsExpanded ? (findBodyReveal ? 'full' : expandedDetailLevel) : collapsedDetailLevel;
    const inlineDetailLevel =
        isGenericSubAgentToolName(normalizedToolName) && effectiveDetailLevel === 'full'
            ? 'summary'
            : effectiveDetailLevel;

    // Keep the header density stable across expand/collapse toggles so tool titles don't "jump" in size.
    const headerDensityDetailLevel = initialIsExpandedRef.current ? expandedDetailLevel : collapsedDetailLevel;
    const { density, iconSize } = deriveToolTimelineDensity(headerDensityDetailLevel);
    const icon = React.useMemo(() => {
        if (iconSize === 18) return headerModel.icon;
        return buildToolHeaderModel({
            tool: toolForSession,
            metadata: props.metadata,
            iconSize,
            iconColorPrimary: theme.colors.text.primary,
            iconColorSecondary: theme.colors.text.secondary,
            historicalAgentId,
        }).icon;
    }, [headerModel.icon, historicalAgentId, iconSize, props.metadata, theme.colors.text.primary, theme.colors.text.secondary, toolForSession]);

    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);
    const showTaskRunningIndicator = isSubAgentTranscriptTool;
    const statusKind = resolveToolStatusIndicatorKind(toolForRendering);
    const terminalStatusSummary =
        statusKind === 'error'
            ? (resolveToolErrorSummary(toolForRendering) ?? t('common.error'))
            : statusKind === 'permission_blocked'
                ? (
                    resolveToolPermissionTerminalErrorMessage({
                        tool: toolForRendering,
                        metadata: props.metadata,
                        permissionDisabledReason: interaction.permissionDisabledReason,
                        historicalAgentId,
                    }) ?? t('errors.permissionDenied')
                )
                : null;
    const headerStatusIndicator =
        terminalStatusSummary
            ? (
                <View
                    testID={statusKind === 'permission_blocked' ? 'tool-timeline-row-permission-blocked' : 'tool-timeline-row-error'}
                    accessible={true}
                    accessibilityLabel={terminalStatusSummary}
                    style={styles.headerTerminalStatus}
                >
                    <Icon
                        name={statusKind === 'permission_blocked' ? 'minus-circle' : 'warning-circle'}
                        size={16}
                        color={theme.colors.state.danger.foreground}
                    />
                    <Text style={styles.headerTerminalStatusText} numberOfLines={1}>
                        {terminalStatusSummary}
                    </Text>
                </View>
            )
            : showTaskRunningIndicator && toolForRendering.state === 'running'
                ? <ActivitySpinner size={iconMatchedSpinnerSize(18)} color={theme.colors.text.secondary} />
                : null;
    const headerPrimaryActions = headerActions ?? null;
    const headerRightElements = [headerStatusIndicator, headerPrimaryActions].filter(Boolean);
    const headerRightElement =
        headerRightElements.length > 1 ? (
            <View style={styles.headerRightContent}>
                {headerRightElements.map((element, index) => (
                    <React.Fragment key={index}>{element}</React.Fragment>
                ))}
            </View>
        ) : (headerRightElements[0] ?? null);

    const isBodyVisible = inlineDetailLevel !== 'title' && inlineDetailLevel !== 'compact';
    const bodyDetailLevel: 'summary' | 'full' = inlineDetailLevel === 'full' ? 'full' : 'summary';
    const lastVisibleBodyDetailLevelRef = React.useRef<'summary' | 'full'>(bodyDetailLevel);
    if (isBodyVisible) {
        lastVisibleBodyDetailLevelRef.current = bodyDetailLevel;
    }
    const renderBodyDetailLevel = isBodyVisible ? bodyDetailLevel : lastVisibleBodyDetailLevelRef.current;

    const collapsibleId =
        props.messageId ??
        toolForRendering.id ??
        `${props.sessionId ?? 'no-session'}:${normalizedToolName}:${toolForRendering.createdAt}`;

    const headerSubtitle = effectiveDetailLevel === 'title' ? null : subtitle;
    const disclosure =
        primaryTapAction === 'expand' && !forceExpandedForPendingUserAction
            ? expandedByUser && isExpanded
                ? ({ behavior: 'persistent', state: 'expanded' } as const)
                : !isExpanded
                    ? ({ behavior: 'hover', state: 'collapsed' } as const)
                    : null
            : null;

    const pendingUserActionStatusText = !isPendingUserAction
        ? null
        : isAskUserQuestionToolName(toolForRendering.name)
            ? t('status.waitingForYourResponse')
            : t('status.actionRequired');
    const headerStatusText = effectiveDetailLevel === 'title' ? null : (pendingUserActionStatusText ?? statusText);
    const resolvedPermissionPromptSurface = props.forcePermissionPromptsInTranscript || pendingLandingToken !== undefined
        ? 'transcript'
        : resolvePermissionPromptSurface(permissionPromptSurface);
    const showPermissionPromptsInTranscript = resolvedPermissionPromptSurface === 'transcript';
    const permissionFooter =
        showPermissionPromptsInTranscript &&
        toolForRendering.permission &&
        props.sessionId &&
        isWaitingForPermission &&
        shouldShowGenericPermissionPromptForRequest({
            toolName: toolForRendering.name,
            requestKind: toolForRendering.permission.kind,
        }) ? (
            <PermissionFooter
                permission={toolForRendering.permission}
                messageId={props.messageId}
                sessionId={props.sessionId}
                toolName={normalizedToolName}
                toolInput={toolForRendering.input}
                metadata={props.metadata}
                canApprovePermissions={interaction.canApprovePermissions && sourceInteraction.canApprovePermissions && transcriptSource.actions !== null}
                disabledReason={interaction.permissionDisabledReason}
            />
        ) : null;

    const approvalCards = React.useMemo(() => {
        const approvalRequests = props.approvalRequests ?? [];
        if (approvalRequests.length === 0) return null;
        const location = buildApprovalToolCallLocation({ messageId: props.messageId });
        const matchingRequests = approvalRequests.filter((request) =>
            doesApprovalMatchToolCall({
                request,
                sessionId: props.sessionId,
                messageId: props.messageId,
                tool: toolForRendering,
                normalizedToolName,
            }),
        );
        if (matchingRequests.length === 0) return null;
        return matchingRequests.map((request) => (
            <ApprovalPromptCard
                key={request.artifact.id}
                chrome="inline"
                artifact={request.artifact}
                approval={request.approval}
                location={location}
                sessionId={props.sessionId!}
                metadata={props.metadata}
                canApprovePermissions={interaction.canApprovePermissions && sourceInteraction.canApprovePermissions && transcriptSource.actions !== null}
                disabledReason={interaction.permissionDisabledReason}
            />
        ));
    }, [
        normalizedToolName,
        props.approvalRequests,
        interaction.canApprovePermissions,
        interaction.permissionDisabledReason,
        props.messageId,
        props.metadata,
        props.sessionId,
        toolForRendering,
    ]);

    // An agent's finite Project command or its wait reads its live operation (plan 21 §8); other rows subscribe to nothing.
    const projectCommandCall = React.useMemo(
        () => readTranscriptProjectCommandCall(toolForRendering),
        [toolForRendering],
    );
    const headerProps: React.ComponentProps<typeof ToolTimelineRowHeader> = {
        testID: "tool-timeline-row",
        openActionTestID: "tool-timeline-row-open",
        density: density,
        icon: icon,
        title: title,
        findBlocks: find?.blocks,
        findRevealBlockId: find?.reveal?.blockId,
        subtitle: headerSubtitle,
        statusText: headerStatusText,
        onPress: onPress,
        canOpen: canOpen,
        onOpen: handleOpen,
        rightElement: headerRightElement,
        revealAction: props.headerAction?.node ?? null,
        revealActionSticky: props.headerAction?.pinned === true,
        disclosure: disclosure,
    };

    return (
        <TranscriptRowSeqProvider value={transcriptSeq}>
        <TranscriptJumpAttention
            sessionAddress={transcriptSource.sessionId === props.sessionId ? normalizeSessionAddress(transcriptSource.serverId, props.sessionId) : null}
            routeMessageId={routeMessageId}
            seq={transcriptSeq}
            radius={TOOL_TIMELINE_ROW_HIGHLIGHT_RADIUS}
            style={styles.container}
        >
            {projectCommandCall ? (
                <ProjectCommandToolTimelineRowHeader
                    header={headerProps}
                    call={projectCommandCall}
                    tool={toolForRendering}
                    serverId={props.serverId}
                />
            ) : <ToolTimelineRowHeader {...headerProps} />}

            {shouldHideBodyPermanently ? null : (
                <TranscriptCollapsible id={collapsibleId} createdAt={toolForRendering.createdAt} expanded={isBodyVisible}>
                    <View testID="tool-timeline-body" style={styles.body}>
                        {showSidechainHydrationStatus ? (
                            <SidechainHydrationInlineStatus
                                testID="tool-sidechain-loading"
                                status={sidechainHydrationStatus}
                            />
                        ) : null}
                        <ToolInlineBody
                            mode="timeline"
                            tool={toolForRendering}
                            normalizedToolName={normalizedToolName}
                            metadata={props.metadata}
                            messages={toolMessages}
                            sessionId={props.sessionId}
                            serverId={props.serverId}
                            messageId={props.messageId}
                            interaction={interaction}
                            detailLevel={renderBodyDetailLevel}
                            setHeaderActions={setHeaderActions}
                        />
                    </View>
                </TranscriptCollapsible>
            )}

            {/*
              * The same row-level outcome the card chrome renders: the Board item
              * this call created, mirrored beside the row rather than inside its
              * collapsible body.
              */}
            <SessionBoardActionResultReference
                tool={toolForRendering}
                sessionId={props.sessionId}
                serverId={props.serverId}
            />
            <WorkflowRunActionResultReference
                tool={toolForRendering}
                serverId={props.serverId}
            />
            <WorkflowDefinitionActionResultReference tool={toolForRendering} serverId={props.serverId} />
            <BrowserActionResultReference
                tool={toolForRendering}
                sessionId={props.sessionId}
                serverId={props.serverId}
                mediaPreviewEnabled={'canPreviewMedia' in interaction && interaction.canPreviewMedia === true}
            />
            <ComputerActionResultReference
                tool={toolForRendering}
                sessionId={props.sessionId}
                serverId={props.serverId}
                mediaPreviewEnabled={'canPreviewMedia' in interaction && interaction.canPreviewMedia === true}
            />

            {permissionFooter}
            {approvalCards}
        </TranscriptJumpAttention>
        </TranscriptRowSeqProvider>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 0,
    },
    body: {
        paddingLeft: 24,
        paddingRight: 10,
        paddingBottom: 12,
        paddingTop: 2,
    },
    headerRightContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    headerTerminalStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    headerTerminalStatusText: {
        color: theme.colors.state.danger.foreground,
        fontSize: 12,
        fontWeight: '600',
        maxWidth: 220,
    },
}));
