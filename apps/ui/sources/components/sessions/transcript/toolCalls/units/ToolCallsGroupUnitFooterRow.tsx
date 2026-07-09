import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

import {
    resolveToolCallsGroupChromeVariant,
    ToolCallsGroupUnitRowFrame,
} from './toolCallsGroupChrome';
import type { ToolCallsGroupUnitRowCommonProps } from './unitRowProps';

type ToolCallsGroupUnitFooterRowProps = ToolCallsGroupUnitRowCommonProps;

export const ToolCallsGroupUnitFooterRow = React.memo(function ToolCallsGroupUnitFooterRow(
    props: ToolCallsGroupUnitFooterRowProps,
) {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);

    return (
        <ToolCallsGroupUnitFooterRowWithSessionCommon
            {...props}
            forkCommon={transcriptSessionCommon.fork}
            messageDisplayCommon={transcriptSessionCommon.messageDisplay}
            toolChromeCommon={transcriptSessionCommon.toolChrome}
            toolRouteCommon={transcriptSessionCommon.toolRoute}
        />
    );
});

// Bottom cap only: recomposes the grouped card's trailing paddings (cards:
// body 6 + contentRow 6; feed: body 6; feed-background: body 6 + cap padding)
// plus the group bottom margin. No gutter-line segment — the line terminates
// at the footer boundary.
export const ToolCallsGroupUnitFooterRowWithSessionCommon = React.memo(function ToolCallsGroupUnitFooterRowWithSessionCommon(
    props: ToolCallsGroupUnitFooterRowProps & TranscriptSessionCommonProps,
) {
    const variant = resolveToolCallsGroupChromeVariant(props.toolChromeCommon);

    return (
        <ToolCallsGroupUnitRowFrame
            variant={variant}
            position="footer"
            unitTestID="transcript-tool-calls-unit-footer"
        >
            <View style={variant === 'cards' ? styles.footerBodyCards : styles.footerBodyFeed} />
        </ToolCallsGroupUnitRowFrame>
    );
});

const styles = StyleSheet.create(() => ({
    footerBodyCards: {
        height: 12,
    },
    footerBodyFeed: {
        height: 6,
    },
}));
