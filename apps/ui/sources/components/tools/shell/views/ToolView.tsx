import * as React from 'react';
import { View, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { Message, ToolCall } from '@/sync/domains/messages/messageTypes';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { Metadata } from '@/sync/domains/state/storageTypes';
import { useRouter } from 'expo-router';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveToolViewDetailLevel } from '@/components/tools/normalization/policy/resolveToolViewDetailLevel';
import { Text } from '@/components/ui/text/Text';
import { ToolInlineBody } from './ToolInlineBody';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';
import { buildToolHeaderModel } from '@/components/tools/shell/presentation/buildToolHeaderModel';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import {
    resolveToolViewDetailLevelDefaultForChromeMode,
    resolveToolViewExpandedDetailLevelDefaultForChromeMode,
    type ToolViewDetailLevelSetting,
    type ToolViewExpandedDetailLevelSetting,
} from '@/components/tools/normalization/policy/resolveToolViewDetailDefaultsForChromeMode';
import { deriveToolTimelineDensity } from '@/components/tools/normalization/policy/deriveToolTimelineDensity';
import { resolvePermissionPromptSurface, shouldShowGenericPermissionPromptForRequest } from '@/utils/sessions/permissions/permissionPromptPolicy';


interface ToolViewProps {
    metadata: Metadata | null;
    tool: ToolCall;
    messages?: Message[];
    onPress?: () => void;
    sessionId?: string;
    messageId?: string;
    interaction?: {
        canSendMessages: boolean;
        canApprovePermissions: boolean;
        permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    };
}

export const ToolView = React.memo<ToolViewProps>((props) => {
    const { tool, onPress, sessionId, messageId } = props;
    const router = useRouter();
    const { theme } = useUnistyles();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const toolViewDetailLevelDefault = useSetting('toolViewDetailLevelDefault');
    const toolViewDetailLevelDefaultLocalControl = useSetting('toolViewDetailLevelDefaultLocalControl');
    const toolViewDetailLevelByToolName = useSetting('toolViewDetailLevelByToolName');
    const toolViewTapAction = useSetting('toolViewTapAction');
    const toolViewExpandedDetailLevelDefault = useSetting('toolViewExpandedDetailLevelDefault');
    const toolViewExpandedDetailLevelByToolName = useSetting('toolViewExpandedDetailLevelByToolName');
    const permissionPromptSurface = useSetting('permissionPromptSurface');
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
        chromeMode: 'cards',
        setting: normalizedToolViewDetailLevelDefaultSetting,
    });
    const resolvedExpandedDetailLevelDefault = resolveToolViewExpandedDetailLevelDefaultForChromeMode({
        chromeMode: 'cards',
        setting: normalizedToolViewExpandedDetailLevelDefaultSetting,
    });

    const headerModel = React.useMemo(() => {
        return buildToolHeaderModel({
            tool,
            metadata: props.metadata,
            iconSize: 18,
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        });
    }, [props.metadata, theme.colors.text, theme.colors.textSecondary, tool]);

    const toolForRendering = headerModel.toolForRendering;
    const isWaitingForPermission = headerModel.isWaitingForPermission;

    const handleOpen = React.useCallback(() => {
        if (onPress) {
            onPress();
        } else if (sessionId && messageId) {
            router.push(`/session/${sessionId}/message/${messageId}`);
        }
    }, [onPress, sessionId, messageId, router]);

    const canOpen = !!(onPress || (sessionId && messageId));

    const handleToggleExpanded = React.useCallback(() => {
        setIsExpanded((v) => !v);
    }, []);

    const normalizedToolName = headerModel.normalizedToolName;
    let knownTool = headerModel.knownTool;

    const description: string | null = headerModel.subtitle;
    const status: string | null = headerModel.statusText;
    let minimal = false;
    let noStatus = false;
    let hideDefaultError = false;
    
    // For some agents (e.g. Gemini): unknown tools should be rendered as minimal (hidden)
    // to avoid showing raw INPUT/OUTPUT for internal tools we haven't explicitly supported yet.
    if (headerModel.shouldHideBodyPermanently) {
        minimal = true;
    }

    // Handle optional title and function type
    const toolTitle = headerModel.title;
    if (knownTool && knownTool.minimal !== undefined) {
        if (typeof knownTool.minimal === 'function') {
            minimal = knownTool.minimal({ tool: toolForRendering, metadata: props.metadata, messages: props.messages });
        } else {
            minimal = knownTool.minimal;
        }
    }

    const collapsedDetailLevel = toolForRendering.name.startsWith('mcp__') || headerModel.shouldCollapseUnknownToolByDefault
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

    const effectiveDetailLevel = isExpanded ? expandedDetailLevel : collapsedDetailLevel;
    const inlineDetailLevel =
        normalizedToolName === 'Task' && effectiveDetailLevel === 'full'
            ? 'summary'
            : effectiveDetailLevel;

    const { density: timelineDensity, iconSize } = deriveToolTimelineDensity(effectiveDetailLevel);
    const icon = React.useMemo(() => {
        if (iconSize === 18) return headerModel.icon;
        return buildToolHeaderModel({
            tool,
            metadata: props.metadata,
            iconSize,
            iconColorPrimary: theme.colors.text,
            iconColorSecondary: theme.colors.textSecondary,
        }).icon;
    }, [headerModel.icon, iconSize, props.metadata, theme.colors.text, theme.colors.textSecondary, tool]);

    // Apply the per-tool detail level preference for the timeline card.
    // - title: hide the tool body
    // - compact: hide the tool body, keep a short inline subtitle
    // - summary: default current behavior
    // - full: prefer full-view component when available
    if (effectiveDetailLevel === 'title' || effectiveDetailLevel === 'compact') {
        minimal = true;
    }
    
    if (knownTool && typeof knownTool.noStatus === 'boolean') {
        noStatus = knownTool.noStatus;
    }
    if (knownTool && typeof knownTool.hideDefaultError === 'boolean') {
        hideDefaultError = knownTool.hideDefaultError;
    }

    let statusIcon = null;

    let isToolUseError = false;
    if (toolForRendering.state === 'error' && toolForRendering.result && parseToolUseError(toolForRendering.result).isToolUseError) {
        isToolUseError = true;
    }

    const statusKind = resolveToolStatusIndicatorKind(toolForRendering);
    if (statusKind === 'permission_blocked') {
        statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
    } else if (statusKind === 'permission_pending') {
        statusIcon = <Ionicons name="lock-closed-outline" size={20} color={theme.colors.warning} />;
    } else if (isToolUseError) {
        statusIcon = <Ionicons name="remove-circle-outline" size={20} color={theme.colors.textSecondary} />;
        hideDefaultError = true;
        minimal = true;
    } else {
        switch (toolForRendering.state) {
            case 'running':
                if (!noStatus) {
                    statusIcon = <ActivityIndicator size="small" color={theme.colors.text} style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }} />;
                }
                break;
            case 'completed':
                // if (!noStatus) {
                //     statusIcon = <Ionicons name="checkmark-circle" size={20} color="#34C759" />;
                // }
                break;
            case 'error':
                statusIcon = <Ionicons name="alert-circle-outline" size={20} color={theme.colors.warning} />;
                break;
        }
    }

    const primaryTapAction: 'expand' | 'open' =
        toolViewTapAction === 'open' && canOpen ? 'open' : 'expand';
    const primaryOnPress = primaryTapAction === 'open' ? handleOpen : handleToggleExpanded;

    const secondaryTapAction: 'expand' | 'open' | null =
        primaryTapAction === 'open'
            ? 'expand'
            : canOpen
                ? 'open'
                : null;
    const secondaryOnPress =
        secondaryTapAction === 'open'
            ? handleOpen
            : secondaryTapAction === 'expand'
                ? handleToggleExpanded
                : null;

    const [headerActions, setHeaderActions] = React.useState<React.ReactNode | null>(null);
    const isBodyVisible = effectiveDetailLevel !== 'title' && effectiveDetailLevel !== 'compact';
    const bodyDetailLevel: 'summary' | 'full' = inlineDetailLevel === 'full' ? 'full' : 'summary';
    const lastVisibleBodyDetailLevelRef = React.useRef<'summary' | 'full'>(bodyDetailLevel);
    if (isBodyVisible) {
        lastVisibleBodyDetailLevelRef.current = bodyDetailLevel;
    }
    const renderBodyDetailLevel = isBodyVisible ? bodyDetailLevel : lastVisibleBodyDetailLevelRef.current;

    const collapsibleId =
        messageId ??
        toolForRendering.id ??
        `${sessionId ?? 'no-session'}:${normalizedToolName}:${toolForRendering.createdAt}`;

    const resolvedPermissionPromptSurface = resolvePermissionPromptSurface(permissionPromptSurface);
    const showPermissionPromptsInTranscript = resolvedPermissionPromptSurface === 'transcript';

    const headerDescription = effectiveDetailLevel === 'title' ? null : description;
    const headerStatusText = effectiveDetailLevel === 'title' ? null : status;
    const showSubtitleInline = timelineDensity === 'compact' || effectiveDetailLevel === 'compact';

    return (
        <View style={styles.container}>
            <View style={[styles.header, timelineDensity === 'compact' ? styles.headerCompact : null]}>
                <TouchableOpacity style={styles.headerMain} onPress={primaryOnPress} activeOpacity={0.8}>
                    <View style={[styles.iconContainer, timelineDensity === 'compact' ? styles.iconContainerCompact : null]}>
                        {icon}
                    </View>
                    <View style={styles.titleContainer}>
                        <Text style={styles.toolName} numberOfLines={1}>
                            {toolTitle}
                            {headerStatusText ? <Text style={styles.status}>{` ${headerStatusText}`}</Text> : null}
                            {showSubtitleInline && headerDescription ? (
                                <Text style={styles.compactSubtitle} numberOfLines={1}>
                                    {` · ${headerDescription}`}
                                </Text>
                            ) : null}
                        </Text>
                        {!showSubtitleInline && headerDescription ? (
                            <Text testID="tool-card-subtitle" style={styles.toolDescription} numberOfLines={1}>
                                {headerDescription}
                            </Text>
                        ) : null}
                    </View>
                    {tool.state === 'running' && !isWaitingForPermission && (
                        <View style={styles.elapsedContainer}>
                            <ElapsedView from={toolForRendering.startedAt ?? toolForRendering.createdAt} />
                        </View>
                    )}
                    {statusIcon}
                </TouchableOpacity>

                <View style={styles.headerRight}>
                    {headerActions ? (
                        <View style={styles.headerActionsContainer}>
                            {headerActions}
                        </View>
                    ) : null}

                    {secondaryOnPress ? (
                        <TouchableOpacity
                            onPress={secondaryOnPress}
                            activeOpacity={0.8}
                            style={styles.secondaryAction}
                            hitSlop={15}
                            accessibilityRole="button"
                            accessibilityLabel={secondaryTapAction === 'open' ? t('toolView.open') : t('toolView.expand')}
                        >
                            {secondaryTapAction === 'open' ? (
                                <Ionicons name="open-outline" size={18} color={theme.colors.textSecondary} />
                            ) : (
                                <Ionicons
                                    name={isExpanded ? 'chevron-up-outline' : 'chevron-down-outline'}
                                    size={18}
                                    color={theme.colors.textSecondary}
                                />
                            )}
                        </TouchableOpacity>
                    ) : null}
                </View>
            </View>

            {/* Content area - either custom children or tool-specific view */}
            <TranscriptCollapsible id={collapsibleId} createdAt={toolForRendering.createdAt} expanded={isBodyVisible}>
                <View style={styles.content}>
                    <ToolInlineBody
                        mode="card"
                        tool={toolForRendering}
                        normalizedToolName={normalizedToolName}
                        metadata={props.metadata}
                        messages={props.messages ?? []}
                        sessionId={sessionId}
                        interaction={props.interaction}
                        detailLevel={renderBodyDetailLevel}
                        setHeaderActions={setHeaderActions}
                    />
                </View>
            </TranscriptCollapsible>

            {/* Permission footer - rendered for most tools */}
            {/* AskUserQuestion and ExitPlanMode have custom action UIs */}
            {showPermissionPromptsInTranscript && isWaitingForPermission && toolForRendering.permission && sessionId && shouldShowGenericPermissionPromptForRequest({ toolName: toolForRendering.name, requestKind: toolForRendering.permission.kind }) && (
                <PermissionFooter
                    permission={toolForRendering.permission}
                    sessionId={sessionId}
                    toolName={normalizedToolName}
                    toolInput={toolForRendering.input}
                    metadata={props.metadata}
                    canApprovePermissions={props.interaction?.canApprovePermissions ?? true}
                    disabledReason={props.interaction?.permissionDisabledReason}
                />
            )}
        </View>
    );
});

function ElapsedView(props: { from: number }) {
    const { from } = props;
    const elapsed = useElapsedTime(from);
    return <Text style={styles.elapsedText}>{t('tools.common.elapsedSeconds', { seconds: elapsed.toFixed(1) })}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        marginVertical: 4,
        overflow: 'hidden'
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 12,
        backgroundColor: theme.colors.surfaceHighest,
    },
    headerCompact: {
        paddingHorizontal: 10,
        paddingVertical: 10,
    },
    headerMain: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerActionsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    secondaryAction: {
        marginLeft: 0,
    },
    iconContainer: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    iconContainerCompact: {
        width: 18,
        height: 18,
    },
    titleContainer: {
        flex: 1,
    },
    elapsedContainer: {
        marginLeft: 8,
    },
    elapsedText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
    toolName: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    status: {
        fontWeight: '400',
        opacity: 0.3,
        fontSize: 15,
    },
    toolDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    compactSubtitle: {
        fontSize: 13,
        fontWeight: '400',
        color: theme.colors.textSecondary,
    },
    content: {
        paddingHorizontal: 12,
        paddingTop: 8,
        overflow: 'visible'
    },
}));
