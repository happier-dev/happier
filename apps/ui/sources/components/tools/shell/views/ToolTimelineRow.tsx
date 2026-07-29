import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import { useSetting } from '@/sync/domains/state/storage';
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
import type { ToolRowPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { resolveToolTranscriptSidechainId } from './resolveToolTranscriptSidechainId';
import {
    SidechainHydrationInlineStatus,
    shouldShowSidechainHydrationInlineStatus,
} from './SidechainHydrationInlineStatus';
import { isGenericSubAgentToolName, isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { ApprovalPromptCard } from '../approvals/ApprovalPromptCard';
import { resolveInactiveSessionToolCallFailure } from '../permissions/resolveInactiveSessionToolCallFailure';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { Text } from '@/components/ui/text/Text';
import { resolveToolErrorSummary } from '@/components/tools/shell/presentation/resolveToolErrorSummary';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { buildApprovalToolCallLocation, doesApprovalMatchToolCall } from './toolApprovalPromptMatching';
import { isAskUserQuestionToolName } from '@happier-dev/protocol';
import { resolveToolPermissionTerminalErrorMessage } from '@/components/tools/shell/permissions/resolveToolPermissionTerminalErrorMessage';

const TOOL_TIMELINE_ROW_HIGHLIGHT_RADIUS = 10;

export const ToolTimelineRow = React.memo((props: {
    tool: ToolCall;
    metadata: Metadata | null;
    messages?: Message[];
    sessionId?: string;
    messageId?: string;
    /** Row seq, so a seq-targeted transcript jump can land its highlight here. */
    jumpHighlightSeq?: number | null;
    headerAction?: ToolRowPinAction | null;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    forcePermissionPromptsInTranscript?: boolean;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
        disableToolNavigation?: boolean;
    };
}) => {
    const { theme } = useUnistyles();
    const router = useRouter();

    const toolForSession = React.useMemo(() => {
        return resolveInactiveSessionToolCallFailure({
            tool: props.tool,
            permissionDisabledReason: props.interaction?.permissionDisabledReason,
        });
    }, [props.interaction?.permissionDisabledReason, props.tool]);

    const headerModel = React.useMemo(() => {
        return buildToolHeaderModel({
            tool: toolForSession,
            metadata: props.metadata,
            iconSize: 18,
            iconColorPrimary: theme.colors.text.primary,
            iconColorSecondary: theme.colors.text.secondary,
        });
    }, [props.metadata, theme.colors.text.primary, theme.colors.text.secondary, toolForSession]);
    const toolForRendering = headerModel.toolForRendering;

    const toolViewDetailLevelDefault = useSetting('toolViewDetailLevelDefault');
    const toolViewDetailLevelDefaultLocalControl = useSetting('toolViewDetailLevelDefaultLocalControl');
    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');
    const toolViewExpandedDetailLevelDefault = useSetting('toolViewExpandedDetailLevelDefault');
    const toolViewExpandedDetailLevelByToolName = useSetting('toolViewExpandedDetailLevelByToolName');
    const toolViewTimelineFeedDefaultExpanded = useSetting('toolViewTimelineFeedDefaultExpanded');
    const toolViewTapAction = useSetting('toolViewTapAction');
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const isWaitingForPermission = headerModel.isWaitingForPermission;
    const isPendingUserAction = isPendingUserActionRequest({
        toolName: toolForRendering.name,
        requestKind: toolForRendering.permission?.kind,
        permissionStatus: toolForRendering.permission?.status,
    });
    const forceExpandedForPendingUserAction = isPendingUserAction;

    const initialIsExpandedRef = React.useRef<boolean>(toolViewTimelineFeedDefaultExpanded === true || forceExpandedForPendingUserAction);
    const [isExpanded, setIsExpanded] = React.useState<boolean>(initialIsExpandedRef.current);
    const [expandedByUser, setExpandedByUser] = React.useState<boolean>(false);

    React.useEffect(() => {
        if (!forceExpandedForPendingUserAction) return;
        setIsExpanded(true);
    }, [forceExpandedForPendingUserAction]);

    const routeMessageId = React.useMemo(() => {
        if (props.interaction?.disableToolNavigation === true) return null;
        return buildToolCallMessageRouteId({
            toolId: typeof toolForRendering.id === 'string' ? toolForRendering.id : null,
            fallbackMessageId: props.messageId,
        });
    }, [props.interaction?.disableToolNavigation, props.messageId, toolForRendering.id]);

    const handleOpen = React.useCallback(() => {
        const sessionId = props.sessionId;
        if (!sessionId || !routeMessageId) return;
        navigateWithBlurOnWeb(() => {
            router.push(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(routeMessageId)}`);
        });
    }, [props.sessionId, routeMessageId, router]);

    const canOpen = !!(props.sessionId && routeMessageId);
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

    const effectiveIsExpanded = forceExpandedForPendingUserAction ? true : isExpanded;

    const transcriptSidechainId = React.useMemo(() => {
        return resolveToolTranscriptSidechainId({ tool: toolForRendering, normalizedToolName });
    }, [normalizedToolName, toolForRendering]);
    const isSubAgentTranscriptTool = isSubAgentTranscriptToolName(normalizedToolName);

    const sidechainHydration = useEnsureSidechainsLoaded({
        enabled:
            effectiveIsExpanded &&
            props.interaction?.disableToolNavigation !== true &&
            isSubAgentTranscriptTool,
        sessionId: props.sessionId,
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

    const effectiveDetailLevel = effectiveIsExpanded ? expandedDetailLevel : collapsedDetailLevel;
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
        }).icon;
    }, [headerModel.icon, iconSize, props.metadata, theme.colors.text.primary, theme.colors.text.secondary, toolForSession]);

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
                        permissionDisabledReason: props.interaction?.permissionDisabledReason,
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
                    <Ionicons
                        name={statusKind === 'permission_blocked' ? 'remove-circle-outline' : 'alert-circle'}
                        size={18}
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
    const resolvedPermissionPromptSurface = props.forcePermissionPromptsInTranscript
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
                sessionId={props.sessionId}
                toolName={normalizedToolName}
                toolInput={toolForRendering.input}
                metadata={props.metadata}
                canApprovePermissions={props.interaction?.canApprovePermissions ?? true}
                disabledReason={props.interaction?.permissionDisabledReason}
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
                canApprovePermissions={props.interaction?.canApprovePermissions ?? true}
                disabledReason={props.interaction?.permissionDisabledReason}
            />
        ));
    }, [
        normalizedToolName,
        props.approvalRequests,
        props.interaction?.canApprovePermissions,
        props.interaction?.permissionDisabledReason,
        props.messageId,
        props.metadata,
        props.sessionId,
        toolForRendering,
    ]);

    return (
        <TranscriptJumpAttention
            sessionId={props.sessionId ?? ''}
            routeMessageId={routeMessageId}
            seq={props.jumpHighlightSeq ?? null}
            radius={TOOL_TIMELINE_ROW_HIGHLIGHT_RADIUS}
            style={styles.container}
        >
            <ToolTimelineRowHeader
                testID="tool-timeline-row"
                openActionTestID="tool-timeline-row-open"
                density={density}
                icon={icon}
                title={title}
                subtitle={headerSubtitle}
                statusText={headerStatusText}
                onPress={onPress}
                canOpen={canOpen}
                onOpen={handleOpen}
                rightElement={headerRightElement}
                revealAction={props.headerAction?.node ?? null}
                revealActionSticky={props.headerAction?.pinned === true}
                disclosure={disclosure}
            />

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
                            messageId={props.messageId}
                            interaction={props.interaction}
                            detailLevel={renderBodyDetailLevel}
                            setHeaderActions={setHeaderActions}
                        />
                    </View>
                </TranscriptCollapsible>
            )}

            {permissionFooter}
            {approvalCards}
        </TranscriptJumpAttention>
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
