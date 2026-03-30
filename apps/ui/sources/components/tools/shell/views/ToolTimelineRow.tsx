import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

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
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import { resolveToolTranscriptSidechainId } from './resolveToolTranscriptSidechainId';
import { isGenericSubAgentToolName, isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { buildToolCallMessageRouteId } from '@/sync/domains/messages/messageRouteIds';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { resolveInactiveSessionToolCallFailure } from '../permissions/resolveInactiveSessionToolCallFailure';
import { Text } from '@/components/ui/text/Text';
import { resolveToolErrorSummary } from '@/components/tools/shell/presentation/resolveToolErrorSummary';

export const ToolTimelineRow = React.memo((props: {
    tool: ToolCall;
    metadata: Metadata | null;
    messages?: Message[];
    sessionId?: string;
    messageId?: string;
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
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        });
    }, [props.metadata, theme.colors.text, theme.colors.textSecondary, toolForSession]);
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
        if (props.sessionId && routeMessageId) {
            router.push(`/session/${encodeURIComponent(props.sessionId)}/message/${encodeURIComponent(routeMessageId)}`);
        }
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

    useEnsureSidechainsLoaded({
        enabled:
            effectiveIsExpanded &&
            isSubAgentTranscriptToolName(normalizedToolName),
        sessionId: props.sessionId,
        sidechainIds: [transcriptSidechainId],
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
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        }).icon;
    }, [headerModel.icon, iconSize, props.metadata, theme.colors.text, theme.colors.textSecondary, toolForSession]);

    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);
    const showTaskRunningIndicator = isSubAgentTranscriptToolName(normalizedToolName);
    const statusKind = resolveToolStatusIndicatorKind(toolForRendering);
    const errorSummary = statusKind === 'error' ? (resolveToolErrorSummary(toolForRendering) ?? t('common.error')) : null;
    const headerStatusIndicator =
        statusKind === 'error'
            ? (
                <View style={styles.headerError}>
                    <Ionicons testID="tool-timeline-row-error" name="alert-circle" size={18} color={theme.colors.textDestructive} />
                    <Text style={styles.headerErrorText} numberOfLines={1}>
                        {errorSummary}
                    </Text>
                </View>
            )
            : showTaskRunningIndicator && toolForRendering.state === 'running'
                ? <ActivityIndicator size="small" />
                : null;
    const headerPrimaryActions = headerActions ?? null;
    const headerRightElement =
        headerStatusIndicator && headerPrimaryActions ? (
            <View style={styles.headerRightContent}>
                {headerStatusIndicator}
                {headerPrimaryActions}
            </View>
        ) : (headerStatusIndicator ?? headerPrimaryActions);

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

    const actionRequiredStatusText = isPendingUserAction ? t('status.actionRequired') : null;
    const headerStatusText = effectiveDetailLevel === 'title' ? null : (actionRequiredStatusText ?? statusText);
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

    return (
        <View style={styles.container}>
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
                disclosure={disclosure}
            />

            {shouldHideBodyPermanently ? null : (
                <TranscriptCollapsible id={collapsibleId} createdAt={toolForRendering.createdAt} expanded={isBodyVisible}>
                    <View testID="tool-timeline-body" style={styles.body}>
                        <ToolInlineBody
                            mode="timeline"
                            tool={toolForRendering}
                            normalizedToolName={normalizedToolName}
                            metadata={props.metadata}
                            messages={props.messages ?? []}
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
        </View>
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
    headerError: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    headerErrorText: {
        color: theme.colors.textDestructive,
        fontSize: 12,
        fontWeight: '600',
        maxWidth: 220,
    },
}));
