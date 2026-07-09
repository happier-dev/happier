import * as React from 'react';

import {
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

import {
    resolveToolCallsGroupChromeVariant,
    ToolCallsGroupExpandMoreChrome,
    ToolCallsGroupUnitRowFrame,
    ToolCallsGroupUnitRowScaffold,
} from './toolCallsGroupChrome';
import type { ToolCallsGroupUnitRowCommonProps } from './unitRowProps';

type ToolCallsGroupUnitExpandRowProps = ToolCallsGroupUnitRowCommonProps & Readonly<{
    hiddenCount: number;
    setExpanded: (expanded: boolean) => void;
}>;

export const ToolCallsGroupUnitExpandRow = React.memo(function ToolCallsGroupUnitExpandRow(
    props: ToolCallsGroupUnitExpandRowProps,
) {
    const transcriptSessionCommon = useTranscriptSessionCommon(props.sessionId);

    return (
        <ToolCallsGroupUnitExpandRowWithSessionCommon
            {...props}
            forkCommon={transcriptSessionCommon.fork}
            messageDisplayCommon={transcriptSessionCommon.messageDisplay}
            toolChromeCommon={transcriptSessionCommon.toolChrome}
            toolRouteCommon={transcriptSessionCommon.toolRoute}
        />
    );
});

export const ToolCallsGroupUnitExpandRowWithSessionCommon = React.memo(function ToolCallsGroupUnitExpandRowWithSessionCommon(
    props: ToolCallsGroupUnitExpandRowProps & TranscriptSessionCommonProps,
) {
    const variant = resolveToolCallsGroupChromeVariant(props.toolChromeCommon);
    const { setExpanded } = props;
    const onExpand = React.useCallback(() => setExpanded(true), [setExpanded]);

    if (props.hiddenCount <= 0) return null;

    return (
        <ToolCallsGroupUnitRowFrame
            variant={variant}
            position="middle"
            unitTestID="transcript-tool-calls-unit-expand"
        >
            <ToolCallsGroupUnitRowScaffold>
                <ToolCallsGroupExpandMoreChrome hiddenCount={props.hiddenCount} onExpand={onExpand} />
            </ToolCallsGroupUnitRowScaffold>
        </ToolCallsGroupUnitRowFrame>
    );
});
