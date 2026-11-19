import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { ToolCall, Message } from "@happier-dev/session-core/messages";
import { CodeView } from '@/components/ui/media/CodeView';
import { Metadata } from '@happier-dev/session-core/state';
import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';
import { getToolViewComponent, usesStructuredToolDetailsPage } from '@/components/tools/renderers/core/_registry';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { ToolCallDetailsSections } from './ToolCallDetailsSections';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { normalizeToolCallForRendering } from "@happier-dev/session-core/tools";
import { renderToolPermissionFooter } from '../permissions/renderToolPermissionFooter';
import { useSetting } from '@/sync/domains/state/storage';
import { TextSelectabilityScope } from '@/components/ui/text/Text';
import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';
import { resolvePermissionPromptSurface } from '@/utils/sessions/permissions/permissionPromptPolicy';
import {
    isSidechainHydrationPendingStatus,
    useEnsureSidechainsLoaded,
} from '@/hooks/session/useEnsureSidechainsLoaded';
import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import { SessionTranscriptSourceProvider, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { toolDetailsTranscriptSource } from '@/components/sessions/transcript/source/toolDetailsTranscriptSource';
import { createAppSidechainHistoryLoader } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { resolveToolTranscriptSidechainId } from './resolveToolTranscriptSidechainId';
import {
    SidechainHydrationInlineStatus,
    shouldShowSidechainHydrationInlineStatus,
} from './SidechainHydrationInlineStatus';
import { isSubAgentTranscriptToolName } from '@happier-dev/protocol/tools/v2';
import { resolveInactiveSessionToolCallFailure } from '../permissions/resolveInactiveSessionToolCallFailure';
import { ToolError } from '@/components/tools/shell/presentation/ToolError';
import { resolveToolPermissionTerminalErrorMessage } from '../permissions/resolveToolPermissionTerminalErrorMessage';
import { formatToolPermissionDecisionLabel } from '@/components/approvals/approvalStatusLabel';
import { ToolOutcomeStatus } from '@/components/tools/shell/presentation/ToolOutcomeStatus';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { DeclinedApprovalDisposition } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';


interface ToolFullViewProps {
    tool: ToolCall;
    owningMessageId: string;
    sessionId?: string;
    /** Exact Home for the sidechain transcript and its pending-message authorship. */
    serverId?: string | null;
    metadata?: Metadata | null;
    messages?: Message[];
    jumpChildId?: string | null;
    forcePermissionFooterInTranscript?: boolean;
    interaction?: TranscriptInteraction;
    /**
     * Exact-target pending/discarded rows for this sidechain, resolved by the
     * canonical pending owner. They render inside the transcript projection with
     * the ordinary pending-to-committed crossover, never as a footer.
     */
    pendingMessages?: readonly PendingMessage[] | null;
    discardedMessages?: readonly DiscardedPendingMessage[] | null;
    /** The exact destination those rows belong to; omitted means the main Session. */
    pendingRecipient?: PendingMessage['recipient'];
    /** The page's own header when this view is the whole tool-details page; hosts with their own header omit it. */
    header?: React.ReactNode;
    /** The same matched Action approval decision that the page header displays. */
    declinedApproval?: DeclinedApprovalDisposition | null;
}

export function ToolFullView(props: ToolFullViewProps) {
    const source = useSessionTranscriptSource();
    // Full detail is already the tool's destination. Keep its Session actions,
    // but do not stack another full-detail destination from nested tool rows.
    const detailSource = React.useMemo(() => toolDetailsTranscriptSource(source), [source]);
    return <SessionTranscriptSourceProvider source={detailSource}><ToolFullViewContent {...props} /></SessionTranscriptSourceProvider>;
}

function ToolFullViewContent({ tool, owningMessageId, sessionId, serverId, metadata, messages = [], jumpChildId, forcePermissionFooterInTranscript = false, pendingMessages, discardedMessages, pendingRecipient, header, declinedApproval }: ToolFullViewProps) {
    const source = useSessionTranscriptSource();
    const interaction = source.useInteraction();
    // This view opens one historical row on its own screen, so the row's own
    // Agent — published by the opener — outranks the Session's current one.
    const historicalAgentId = useHistoricalTranscriptAgentId();
    // Composed at render time: the module-scope stylesheet evaluates once, so a
    // baked-in `layout.maxWidth` would freeze the user's content-width preference.
    const contentMaxWidthStyle = useLayoutMaxWidthStyle();
    const toolForRendering = React.useMemo<ToolCall>(() => {
        return resolveInactiveSessionToolCallFailure({
            tool: normalizeToolCallForRendering(tool),
            permissionDisabledReason: interaction?.permissionDisabledReason,
        });
    }, [interaction?.permissionDisabledReason, tool]);

    const outputExpired = toolForRendering.toolOutputAvailability?.status === 'expired';

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
            {formatToolPermissionDecisionLabel(toolForRendering.permission)
                ? <ToolOutcomeStatus testID="tool-details-permission-decision" label={permissionTerminalErrorMessage} glyph="minus-circle" tone="quiet" />
                : <ToolError message={permissionTerminalErrorMessage} />}
        </TextSelectabilityScope>
    ) : null;

    const normalizedJumpChildId = typeof jumpChildId === 'string' && jumpChildId.length > 0 ? jumpChildId : null;

    const normalizedToolName = React.useMemo(() => {
        return resolveToolHeaderTextPresentation({ tool: toolForRendering, metadata: metadata ?? null }).normalizedToolName;
    }, [metadata, toolForRendering]);

    const transcriptSidechainId = React.useMemo(() => {
        return resolveToolTranscriptSidechainId({ tool: toolForRendering, normalizedToolName });
    }, [normalizedToolName, toolForRendering]);
    const isSubAgentTranscriptTool = isSubAgentTranscriptToolName(normalizedToolName);

    const sidechainHydration = useEnsureSidechainsLoaded({
        enabled:
            typeof sessionId === 'string' &&
            sessionId.length > 0 &&
            isSubAgentTranscriptTool && source.loadSidechain !== null,
        sessionId,
        sidechainIds: [transcriptSidechainId],
        loadSidechain: source.loadSidechain,
    });
    const sidechainHydrationStatus = transcriptSidechainId
        ? sidechainHydration.bySidechainId[transcriptSidechainId]?.status ?? sidechainHydration.status
        : sidechainHydration.status;
    const showSidechainLoading =
        isSubAgentTranscriptTool &&
        messages.length === 0 &&
        isSidechainHydrationPendingStatus(
            transcriptSidechainId ? sidechainHydration.bySidechainId[transcriptSidechainId]?.status : undefined,
        );
    const showSidechainHydrationStatus =
        isSubAgentTranscriptTool &&
        shouldShowSidechainHydrationInlineStatus({
            messageCount: messages.length,
            sidechainId: transcriptSidechainId,
            status: sidechainHydrationStatus,
        });

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
    const transcriptDatasetIdentity = sidechainId ?? normalizedOwningMessageId;
    const transcriptSessionAddress = normalizeSessionAddress(serverId, normalizedSessionId);
    const transcriptDatasetScope = transcriptSessionAddress
        ? sessionAddressKey(transcriptSessionAddress)
        : normalizedSessionId;
    const sidechainDatasetKey = React.useMemo(
        () => JSON.stringify([transcriptDatasetScope, transcriptDatasetIdentity]),
        [transcriptDatasetIdentity, transcriptDatasetScope],
    );
    const canRenderTaskTranscript =
        normalizedSessionId !== null &&
        isSubAgentTranscriptTool &&
        (sidechainId !== null || messages.length > 0);
    const resolvedPermissionPromptSurface =
        forcePermissionFooterInTranscript
            ? 'transcript'
            : resolvePermissionPromptSurface(permissionPromptSurface);

    const transcriptInteraction = interaction;
    const loadOlderSidechain = React.useMemo(
        () => createAppSidechainHistoryLoader(source.sessionId, sidechainId),
        [source.sessionId, sidechainId],
    );

    const showPermissionPromptsInTranscript = resolvedPermissionPromptSurface === 'transcript';

    const permissionFooter = renderToolPermissionFooter({
        tool: toolForRendering, toolName: normalizedToolName, sessionId: normalizedSessionId,
        serverId: serverId ?? undefined, metadata: metadata || null,
        canApprovePermissions: interaction.canApprovePermissions, disabledReason: interaction.permissionDisabledReason,
        showPrompt: showPermissionPromptsInTranscript && isWaitingForPermission,
    });

    // The raw record (with its transport envelope) stays one deliberate press away, as its own quiet section.
    const debugSection = (
        <ItemGroup testID="tool-details-debug">
            <Item
                testID="tool-details-debug-toggle"
                title={t('tools.fullView.debug')}
                detail={showDebug ? t('tools.fullView.hide') : t('tools.fullView.show')}
                accessibilityState={{ expanded: showDebug }}
                onPress={() => setShowDebug((v) => !v)}
                showChevron={false}
            />
            {showDebug ? (
                <SectionContentRow testID="tool-details-debug-body">
                    <CodeView
                        wrap
                        code={JSON.stringify({
                            name: tool.name,
                            normalizedName: normalizedToolName,
                            state: toolForRendering.state,
                            description: toolForRendering.description,
                            input: toolForRendering.input,
                            result: outputExpired ? undefined : toolForRendering.result,
                            createdAt: toolForRendering.createdAt,
                            startedAt: toolForRendering.startedAt,
                            completedAt: toolForRendering.completedAt,
                            permission: toolForRendering.permission,
                            messages,
                            jumpChildId: normalizedJumpChildId,
                        }, null, 2)}
                    />
                </SectionContentRow>
            ) : null}
        </ItemGroup>
    );

    if (canRenderTaskTranscript && normalizedSessionId) {
        const toolTranscriptHeader =
            (messages.length === 0 || normalizedToolName === 'SubAgentRun' && toolForRendering.state !== 'running')
                && (SpecializedFullView || showSidechainHydrationStatus) ? (
                <TextSelectabilityScope selectable>
                    <>
                        {SpecializedFullView ? (
                            <SpecializedFullView
                                tool={toolForRendering}
                                metadata={metadata || null}
                                messages={messages}
                                sessionId={sessionId}
                                detailLevel="full"
                                interaction={interaction}
                            />
                        ) : null}
                        {showSidechainHydrationStatus ? (
                            <SidechainHydrationInlineStatus
                                testID="tool-sidechain-loading"
                                status={sidechainHydrationStatus}
                            />
                        ) : null}
                    </>
                </TextSelectabilityScope>
            ) : null;
        // The page header stands a section apart from the conversation it names.
        const pageHeader = header ? <View style={styles.transcriptPageHeader}>{header}</View> : null;
        const transcriptHeader = pageHeader && toolTranscriptHeader ? <>{pageHeader}{toolTranscriptHeader}</> : pageHeader ?? toolTranscriptHeader;

        return (
            <View style={[styles.container, { paddingHorizontal: screenWidth > 700 ? 16 : 0 }]}>
                <View style={[styles.contentWrapper, contentMaxWidthStyle, { flex: 1, minHeight: 0 }]}>
                    <View style={styles.transcriptSection}>
                        <ChainTranscriptList
                            key={sidechainDatasetKey}
                            sessionId={normalizedSessionId}
                            serverId={serverId ?? null}
                            datasetKey={sidechainDatasetKey}
                            messages={messages}
                            metadata={metadata || null}
                            interaction={transcriptInteraction}
                            forcePermissionPromptsInTranscript={forcePermissionFooterInTranscript}
                            pendingMessages={pendingMessages}
                            discardedMessages={discardedMessages}
                            pendingRecipient={pendingRecipient}
                            isInitialLoadInFlight={showSidechainLoading}
                            loadOlder={sidechainId ? loadOlderSidechain : undefined}
                            jumpToMessageId={normalizedJumpChildId}
                            header={transcriptHeader}
                            footer={
                                <>
                                    {permissionTerminalError}
                                    {permissionFooter}
                                    {/* A conversation page (a Run's or a task's transcript) is the conversation; its raw
                                        record shows only for people who asked for debug details in Settings. */}
                                    {toolViewShowDebugByDefault ? debugSection : null}
                                </>
                            }
                            messageWrapperTestIdPrefix="tool-fullview-transcript-message"
                        />
                    </View>
                </View>
            </View>
        );
    }

    const structuredPage = usesStructuredToolDetailsPage(normalizedToolName);
    return (
        <ItemList testID="tool-details-page">
            {header}
            {outputExpired || structuredPage || !SpecializedFullView ? (
                <TextSelectabilityScope selectable>
                    <ToolCallDetailsSections tool={toolForRendering} serverId={serverId} sessionId={sessionId} declinedApproval={declinedApproval} />
                </TextSelectabilityScope>
            ) : (
                <PageContentColumn style={styles.pageBody}>
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
                </PageContentColumn>
            )}
            {permissionTerminalError || permissionFooter ? (
                <PageContentColumn style={styles.pageBody}>
                    {permissionTerminalError}
                    {permissionFooter}
                </PageContentColumn>
            ) : null}
            {debugSection}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        paddingTop: theme.space.s12,
    },
    contentWrapper: {
        alignSelf: 'center',
        width: '100%',
    },
    // The call's own body stands on the page header's text edge, so its prose lines up with the title above it.
    pageBody: {
        paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    },
    transcriptPageHeader: {
        paddingBottom: HAPPIER_PAGE_METRICS.sectionGapPx,
    },
    transcriptSection: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 0,
    },
}));

// Export styles for use in specialized views
export const toolFullViewStyles = styles;
