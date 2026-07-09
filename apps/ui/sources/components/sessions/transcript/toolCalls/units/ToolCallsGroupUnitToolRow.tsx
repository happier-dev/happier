import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';

import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import {
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';
import { ToolCallPinAction } from '@/components/sessions/transcript/toolCalls/ToolCallPinAction';
import { resolveMessagePinAvailability } from '@/components/sessions/transcript/messageActions/resolveMessagePinAvailability';
import { resolveMessageRouteIdForDisplay } from '@/sync/domains/messages/messageRouteIds';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';

import {
    renderGroupedToolCallRowContent,
    resolveGroupedPreviewSidechainIds,
} from './groupedToolCallRowContent';
import {
    resolveToolCallMessageForSession,
    resolveToolCallsGroupChromeVariant,
    toolCallsGroupChromeModeForVariant,
    ToolCallsGroupUnitRowFrame,
    ToolCallsGroupUnitRowScaffold,
} from './toolCallsGroupChrome';
import type { ToolCallsGroupUnitRowCommonProps } from './unitRowProps';

type ToolCallsGroupUnitToolRowProps = ToolCallsGroupUnitRowCommonProps & Readonly<{
    message: ToolCallMessage;
    expanded: boolean;
    forcePermissionPromptsInTranscript?: boolean;
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    messagePins?: readonly PersistedSessionMessagePinV1[];
    onToggleToolPin?: (pin: PersistedSessionMessagePinV1) => void;
}>;

export const ToolCallsGroupUnitToolRow = React.memo(function ToolCallsGroupUnitToolRow(
    props: ToolCallsGroupUnitToolRowProps,
) {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);

    return (
        <ToolCallsGroupUnitToolRowWithSessionCommon
            {...props}
            forkCommon={transcriptSessionCommon.fork}
            messageDisplayCommon={transcriptSessionCommon.messageDisplay}
            toolChromeCommon={transcriptSessionCommon.toolChrome}
            toolRouteCommon={transcriptSessionCommon.toolRoute}
        />
    );
});

// NOTE: the whole-card view wraps its expanded body in TranscriptCollapsible. That
// wrapper cannot span FlashList rows, so unit rows intentionally drop it: expansion
// becomes row insertion/removal at the list level (per-row TranscriptEnterWrapper kept).
export const ToolCallsGroupUnitToolRowWithSessionCommon = React.memo(function ToolCallsGroupUnitToolRowWithSessionCommon(
    props: ToolCallsGroupUnitToolRowProps & TranscriptSessionCommonProps,
) {
    const variant = resolveToolCallsGroupChromeVariant(props.toolChromeCommon);
    const chromeMode = toolCallsGroupChromeModeForVariant(variant);
    const { messagesById, reducerState } = props.toolRouteCommon;

    const message = React.useMemo(
        () => resolveToolCallMessageForSession(props.message, props.interaction.permissionDisabledReason),
        [props.interaction.permissionDisabledReason, props.message],
    );

    // Collapsed-preview sidechain eager-loading lives here in unit mode: the
    // collapsed preview tail IS rendered as tool rows with expanded === false.
    const previewSidechainIds = React.useMemo(() => {
        if (props.expanded) return [] as readonly string[];
        return resolveGroupedPreviewSidechainIds({ chromeMode, previewMessages: [message] });
    }, [chromeMode, message, props.expanded]);

    useEnsureSidechainsLoaded({
        enabled: !props.expanded && previewSidechainIds.length > 0 && props.interaction.disableToolNavigation !== true,
        sessionId: props.sessionId,
        sidechainIds: previewSidechainIds,
    });

    const nestedMessageId = props.interaction.disableToolNavigation
        ? undefined
        : resolveMessageRouteIdForDisplay({ message, messagesById, reducerState });
    const toolPinAvailability = React.useMemo(() => resolveMessagePinAvailability({
        sessionId: props.sessionId,
        seq: message.seq ?? null,
        transcriptBlockIndex: message.transcriptBlockIndex ?? null,
        routeMessageId: nestedMessageId ?? null,
        role: 'tool',
        pins: props.messagePins ?? [],
        readOnlyContext: props.interaction.permissionDisabledReason === 'readOnly',
    }), [message.seq, message.transcriptBlockIndex, nestedMessageId, props.interaction.permissionDisabledReason, props.messagePins, props.sessionId]);
    const toolPinAction = props.onToggleToolPin && toolPinAvailability.status === 'available' ? (
        <ToolCallPinAction
            availability={toolPinAvailability}
            onTogglePin={props.onToggleToolPin}
            testID={`transcript-tool-call-pin:${message.id}`}
        />
    ) : null;

    return (
        <ToolCallsGroupUnitRowFrame
            variant={variant}
            position="middle"
            unitTestID="transcript-tool-calls-unit-tool"
        >
            <ToolCallsGroupUnitRowScaffold>
                <TranscriptEnterWrapper id={message.id} createdAt={message.createdAt}>
                    <View testID={`${TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX}${message.id}`}>
                        <View
                            testID="transcript-tool-calls-tool-row"
                            style={variant === 'cards' ? styles.toolRowCards : styles.toolRowFeed}
                        >
                            {renderGroupedToolCallRowContent({
                                message,
                                chromeMode,
                                groupExpanded: props.expanded,
                                metadata: props.metadata,
                                sessionId: props.sessionId,
                                nestedMessageId,
                                forcePermissionPromptsInTranscript: props.forcePermissionPromptsInTranscript,
                                approvalRequests: props.approvalRequests,
                                messagePins: props.messagePins,
                                onToggleToolPin: props.onToggleToolPin,
                                toolPinAction,
                                interaction: props.interaction,
                                forkCommon: props.forkCommon,
                                messageDisplayCommon: props.messageDisplayCommon,
                                toolChromeCommon: props.toolChromeCommon,
                                toolRouteCommon: props.toolRouteCommon,
                            })}
                        </View>
                    </View>
                </TranscriptEnterWrapper>
            </ToolCallsGroupUnitRowScaffold>
        </ToolCallsGroupUnitRowFrame>
    );
});

const styles = StyleSheet.create(() => ({
    // Consecutive grouped tools share one continuous unit-card inset background. The
    // row adds no spacing and the embedded ToolView card drops its own vertical margin
    // (see ToolView `embedded`), so no page background shows between tools — they stack
    // contiguously as a single list.
    toolRowCards: {
        marginHorizontal: 0,
        paddingBottom: 0,
    },
    toolRowFeed: {
        marginHorizontal: 0,
        paddingBottom: 0,
    },
}));
