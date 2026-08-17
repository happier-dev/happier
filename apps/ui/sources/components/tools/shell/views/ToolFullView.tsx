import * as React from 'react';
import { View, ScrollView, Platform, useWindowDimensions } from 'react-native';
import { ToolCall, Message } from '@/sync/domains/messages/messageTypes';
import { CodeView } from '@/components/ui/media/CodeView';
import { Metadata } from '@/sync/domains/state/storageTypes';
import { getToolViewComponent } from '@/components/tools/renderers/core/_registry';
import { layout } from '@/components/ui/layout/layout';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { StructuredResultView } from '@/components/tools/renderers/system/StructuredResultView';
import { normalizeToolCallForRendering } from '@/components/tools/normalization/core/normalizeToolCallForRendering';
import { PermissionFooter } from '../permissions/PermissionFooter';
import { useSetting } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { Text, TextSelectabilityScope } from '@/components/ui/text/Text';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { resolvePermissionPromptSurface, shouldShowGenericPermissionPromptForRequest } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { SidechainTranscriptBody } from '@/components/sessions/transcript/sidechain/SidechainTranscriptBody';
import { resolveToolTranscriptSidechainId } from './resolveToolTranscriptSidechainId';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { resolveInactiveSessionToolCallFailure } from '../permissions/resolveInactiveSessionToolCallFailure';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { resolveToolPermissionTerminalErrorMessage } from '../permissions/resolveToolPermissionTerminalErrorMessage';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { Icon } from '@/components/ui/icons/Icon';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';


interface ToolFullViewProps {
    tool: ToolCall;
    owningMessageId: string;
    sessionId?: string;
    metadata?: Metadata | null;
    messages?: Message[];
    jumpChildId?: string | null;
    forcePermissionFooterInTranscript?: boolean;
    interaction?: TranscriptInteraction;
}

export function ToolFullView({ tool, owningMessageId, sessionId, metadata, messages = [], jumpChildId, forcePermissionFooterInTranscript = false, interaction }: ToolFullViewProps) {
    const { theme } = useUnistyles();
    // This view opens one historical row on its own screen, so the row's own
    // Agent — published by the opener — outranks the Session's current one.
    const historicalAgentId = useHistoricalTranscriptAgentId();
    const toolForRendering = React.useMemo<ToolCall>(() => {
        return resolveInactiveSessionToolCallFailure({
            tool: normalizeToolCallForRendering(tool),
            permissionDisabledReason: interaction?.permissionDisabledReason,
        });
    }, [interaction?.permissionDisabledReason, tool]);

    const permissionTerminalErrorMessage = React.useMemo(() => {
        return resolveToolPermissionTerminalErrorMessage({
            tool: toolForRendering,
            metadata: metadata ?? null,
            permissionDisabledReason: interaction?.permissionDisabledReason,
            historicalAgentId,
        });
    }, [historicalAgentId, interaction?.permissionDisabledReason, metadata, toolForRendering]);

    const permissionTerminalError = permissionTerminalErrorMessage ? (
        <TextSelectabilityScope selectable>
            <ToolError message={permissionTerminalErrorMessage} />
        </TextSelectabilityScope>
    ) : null;

    const normalizedJumpChildId = typeof jumpChildId === 'string' && jumpChildId.length > 0 ? jumpChildId : null;

    const normalizedToolName = React.useMemo(() => {
        return resolveToolHeaderTextPresentation({ tool: toolForRendering, metadata: metadata ?? null }).normalizedToolName;
    }, [metadata, toolForRendering]);

    const transcriptSidechainId = React.useMemo(() => {
        return resolveToolTranscriptSidechainId({ tool: toolForRendering, normalizedToolName });
    }, [normalizedToolName, toolForRendering]);

    // Check if there's a specialized content view for this tool.
    // ToolFullView always renders the same tool renderer in `detailLevel="full"` mode.
    const SpecializedFullView = getToolViewComponent(normalizedToolName);
    const screenWidth = useWindowDimensions().width;
    const toolViewShowDebugByDefault = useSetting('toolViewShowDebugByDefault');
    const permissionPromptSurface = useSetting('permissionPromptSurface');
    const [showDebug, setShowDebug] = React.useState<boolean>(toolViewShowDebugByDefault);
    const isWaitingForPermission =
        toolForRendering.permission?.status === 'pending' && toolForRendering.state !== 'completed';

    const normalizedSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
    const sidechainId = transcriptSidechainId;
    const normalizedOwningMessageId = owningMessageId.trim();
    if (normalizedOwningMessageId.length === 0) {
        throw new Error('ToolFullView requires a non-empty owningMessageId');
    }
    const canRenderTaskTranscript =
        normalizedSessionId !== null &&
        isSubAgentTranscriptToolName(normalizedToolName) &&
        (sidechainId !== null || messages.length > 0);
    const resolvedPermissionPromptSurface =
        forcePermissionFooterInTranscript
            ? 'transcript'
            : resolvePermissionPromptSurface(permissionPromptSurface);

    // The sidechain transcript is a transcript surface and must receive the *whole* interaction
    // contract. Reconstructing it field-by-field silently drops every grant this file does not know
    // about (`canFork`, `canOpenFiles`, `canPreviewMedia`), and those are read with exact-`true`
    // checks downstream — so a dropped grant removes a valid affordance. Only tool navigation is
    // owned here: the full view already *is* the tool detail surface.
    const transcriptInteraction = React.useMemo<TranscriptInteraction>(() => {
        return {
            canSendMessages: true,
            canApprovePermissions: true,
            ...interaction,
            disableToolNavigation: true,
        };
    }, [interaction]);

    const showPermissionPromptsInTranscript = resolvedPermissionPromptSurface === 'transcript';

    const permissionFooter =
        isWaitingForPermission &&
        toolForRendering.permission &&
        normalizedSessionId &&
        showPermissionPromptsInTranscript &&
        shouldShowGenericPermissionPromptForRequest({ toolName: toolForRendering.name, requestKind: toolForRendering.permission.kind }) ? (
            <PermissionFooter
                permission={toolForRendering.permission}
                sessionId={normalizedSessionId}
                toolName={normalizedToolName}
                toolInput={toolForRendering.input}
                metadata={metadata || null}
                canApprovePermissions={interaction?.canApprovePermissions ?? true}
                disabledReason={interaction?.permissionDisabledReason}
            />
        ) : null;

    const debugSection = (
        <View style={styles.section}>
            <View style={styles.sectionHeader}>
                <Icon name="code" size={20} color={theme.colors.accent.orange} />
                <Text style={styles.sectionTitle}>{t('tools.fullView.debug')}</Text>
                <Text
                    style={[styles.toolId, { marginLeft: 8 }]}
                    onPress={() => setShowDebug((v) => !v)}
                >
                    {showDebug ? t('tools.fullView.hide') : t('tools.fullView.show')}
                </Text>
            </View>
            {showDebug && (
                <CodeView
                    code={JSON.stringify({
                        name: tool.name,
                        normalizedName: normalizedToolName,
                        state: toolForRendering.state,
                        description: toolForRendering.description,
                        input: toolForRendering.input,
                        result: toolForRendering.result,
                        createdAt: toolForRendering.createdAt,
                        startedAt: toolForRendering.startedAt,
                        completedAt: toolForRendering.completedAt,
                        permission: toolForRendering.permission,
                        messages,
                        jumpChildId: normalizedJumpChildId,
                    }, null, 2)}
                />
            )}
        </View>
    );

    if (canRenderTaskTranscript && normalizedSessionId) {
        const transcriptHeader = messages.length === 0 && SpecializedFullView ? (
            <TextSelectabilityScope selectable>
                <SpecializedFullView
                    tool={toolForRendering}
                    metadata={metadata || null}
                    messages={messages}
                    sessionId={sessionId}
                    detailLevel="full"
                    interaction={interaction}
                />
            </TextSelectabilityScope>
        ) : null;

        return (
            <View style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
                <View style={[styles.contentWrapper, { flex: 1, minHeight: 0 }]}>
                    <View style={styles.transcriptSection}>
                        {/* The ONE sidechain transcript body. The details pane renders the same
                            one for an imported workflow-agent sidecar, which has no tool call to
                            anchor this view — so hydration, dataset identity, the empty-vs-loading
                            answer and the list itself live there rather than here. */}
                        <SidechainTranscriptBody
                            sessionId={normalizedSessionId}
                            sidechainId={sidechainId}
                            datasetIdentityFallback={normalizedOwningMessageId}
                            messages={messages}
                            metadata={metadata || null}
                            interaction={transcriptInteraction}
                            forcePermissionPromptsInTranscript={forcePermissionFooterInTranscript}
                            jumpToMessageId={normalizedJumpChildId}
                            hydrationStatusTestID="tool-fullview-sidechain-hydration-status"
                            header={transcriptHeader}
                            footer={
                                <>
                                    {permissionTerminalError}
                                    {permissionFooter}
                                    {debugSection}
                                </>
                            }
                            messageWrapperTestIdPrefix="tool-fullview-transcript-message"
                        />
                    </View>
                </View>
            </View>
        );
    }

    return (
        <ScrollView style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
            <View style={styles.contentWrapper}>
                {/* Tool-specific content or generic fallback */}
                {SpecializedFullView ? (
                    <TextSelectabilityScope selectable>
                        <SpecializedFullView
                            tool={toolForRendering}
                            metadata={metadata || null}
                            messages={messages}
                            sessionId={sessionId}
                            detailLevel="full"
                            interaction={interaction}
                        />
                    </TextSelectabilityScope>
                ) : (
                    <TextSelectabilityScope selectable>
                        <>
                            {/* Generic fallback for tools without specialized views */}
                            {/* Tool Description */}
                            {toolForRendering.description && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="info" size={20} color={theme.colors.accent.indigo} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.description')}</Text>
                                    </View>
                                    <Text style={styles.description}>{toolForRendering.description}</Text>
                                </View>
                            )}
                            {/* Input Parameters */}
                            {toolForRendering.input && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="sign-in" size={20} color={theme.colors.accent.indigo} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.inputParams')}</Text>
                                    </View>
                                    <CodeView code={JSON.stringify(toolForRendering.input, null, 2)} />
                                </View>
                            )}

                            {/* Result/Output */}
                            {toolForRendering.state === 'completed' && toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="sign-out" size={20} color={theme.colors.state.success.foreground} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                                    </View>
                                    <CodeView
                                        code={typeof toolForRendering.result === 'string' ? toolForRendering.result : JSON.stringify(toolForRendering.result, null, 2)}
                                    />
                                </View>
                            )}

                            {toolForRendering.state === 'running' && toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="sign-out" size={20} color={theme.colors.state.success.foreground} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.output')}</Text>
                                    </View>
                                    <StructuredResultView tool={toolForRendering} metadata={metadata || null} messages={messages} sessionId={sessionId} />
                                </View>
                            )}

                            {/* Error Details */}
                            {toolForRendering.state === 'error' && toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.sectionHeader}>
                                        <Icon name="x-circle" size={20} color={theme.colors.state.danger.foreground} />
                                        <Text style={styles.sectionTitle}>{t('tools.fullView.error')}</Text>
                                    </View>
                                    <View style={styles.errorContainer}>
                                        <Text style={styles.errorText}>
                                            {typeof toolForRendering.result === 'string'
                                                ? toolForRendering.result
                                                : JSON.stringify(toolForRendering.result, null, 2)}
                                        </Text>
                                    </View>
                                </View>
                            )}

                            {/* No Output Message */}
                            {toolForRendering.state === 'completed' && !toolForRendering.result && (
                                <View style={styles.section}>
                                    <View style={styles.emptyOutputContainer}>
                                        <Icon name="check-circle" size={48} color={theme.colors.state.success.foreground} />
                                        <Text style={styles.emptyOutputText}>{t('tools.fullView.completed')}</Text>
                                        <Text style={styles.emptyOutputSubtext}>{t('tools.fullView.noOutput')}</Text>
                                    </View>
                                </View>
                            )}
                        </>
                    </TextSelectabilityScope>
                )}

                {permissionTerminalError}
                {permissionFooter}
                {debugSection}
            </View>
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        paddingTop: 12,
    },
    contentWrapper: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    section: {
        marginBottom: 28,
        paddingHorizontal: 4,
    },
    sectionFullWidth: {
        marginBottom: 28,
        paddingHorizontal: 0,
    },
    transcriptSection: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 0,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
        gap: 8,
    },
    sectionTitle: {
        fontSize: 17,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    description: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    toolId: {
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
        color: theme.colors.text.secondary,
    },
    errorContainer: {
        backgroundColor: theme.colors.state.danger.background,
        borderRadius: 8,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.colors.state.danger.border,
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.state.danger.foreground,
        lineHeight: 20,
    },
    emptyOutputContainer: {
        alignItems: 'center',
        paddingVertical: 48,
        gap: 12,
    },
    emptyOutputText: {
        fontSize: 16,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    emptyOutputSubtext: {
        fontSize: 14,
        color: theme.colors.text.secondary,
    },
}));

// Export styles for use in specialized views
export const toolFullViewStyles = styles;
