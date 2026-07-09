import * as React from 'react';
import { View } from 'react-native';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';

import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import {
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

import {
    resolveToolCallsGroupChromeVariant,
    resolveToolCallsGroupStatus,
    toolCallsGroupChromeModeForVariant,
    ToolCallsGroupHeaderChrome,
    ToolCallsGroupUnitRowFrame,
} from './toolCallsGroupChrome';
import type { ToolCallsGroupUnitRowCommonProps } from './unitRowProps';

type ToolCallsGroupUnitHeaderRowProps = ToolCallsGroupUnitRowCommonProps & Readonly<{
    toolMessages: ToolCallMessage[];
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
}>;

export const ToolCallsGroupUnitHeaderRow = React.memo(function ToolCallsGroupUnitHeaderRow(
    props: ToolCallsGroupUnitHeaderRowProps,
) {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);

    return (
        <ToolCallsGroupUnitHeaderRowWithSessionCommon
            {...props}
            forkCommon={transcriptSessionCommon.fork}
            messageDisplayCommon={transcriptSessionCommon.messageDisplay}
            toolChromeCommon={transcriptSessionCommon.toolChrome}
            toolRouteCommon={transcriptSessionCommon.toolRoute}
        />
    );
});

export const ToolCallsGroupUnitHeaderRowWithSessionCommon = React.memo(function ToolCallsGroupUnitHeaderRowWithSessionCommon(
    props: ToolCallsGroupUnitHeaderRowProps & TranscriptSessionCommonProps,
) {
    const variant = resolveToolCallsGroupChromeVariant(props.toolChromeCommon);
    const chromeMode = toolCallsGroupChromeModeForVariant(variant);
    const { setExpanded } = props;
    const onCollapse = React.useCallback(() => setExpanded(false), [setExpanded]);

    const status = resolveToolCallsGroupStatus({
        toolMessages: props.toolMessages,
        permissionDisabledReason: props.interaction.permissionDisabledReason,
    });

    if (props.toolMessages.length === 0) return null;

    const createdAt = props.toolMessages[0]?.createdAt ?? Date.now();
    const webPrependAnchorId = props.toolMessages[props.toolMessages.length - 1]?.id ?? props.groupId;

    return (
        <View testID={`${TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX}${webPrependAnchorId}`}>
            <TranscriptEnterWrapper id={props.groupId} createdAt={createdAt}>
                <ToolCallsGroupUnitRowFrame
                    variant={variant}
                    position="header"
                    unitTestID="transcript-tool-calls-unit-header"
                >
                    <ToolCallsGroupHeaderChrome
                        chromeMode={chromeMode}
                        status={status}
                        count={props.toolMessages.length}
                        expanded={props.expanded}
                        onCollapse={onCollapse}
                    />
                </ToolCallsGroupUnitRowFrame>
            </TranscriptEnterWrapper>
        </View>
    );
});
