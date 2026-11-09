import * as React from 'react';
import type { TranscriptPeerSenderV1 } from '@happier-dev/protocol/sessions/messages/transcriptPeerSenderV1';

import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import { t } from '@/text';

/** A teammate message or subagent report delivered into the agent's conversation, collapsed to its first line. */
export const PeerMessageRow = React.memo(function PeerMessageRow(props: {
    id: string;
    createdAt: number;
    peer: TranscriptPeerSenderV1;
    summary: string;
    /** Changes when transcript find reveals a match in this message; each reveal opens the row. */
    revealRequestId?: number | string;
    children: React.ReactNode;
}) {
    const [expanded, setExpanded] = React.useState(false);
    React.useEffect(() => {
        if (props.revealRequestId !== undefined) setExpanded(true);
    }, [props.revealRequestId]);
    const name = props.peer.name ?? t('sessionInfo.peerUnnamedSender');
    return (
        <ThinkingTimelineRow
            id={props.id}
            createdAt={props.createdAt}
            label={props.peer.handback ? t('sessionInfo.peerReportFrom', { name }) : t('sessionInfo.peerMessageFrom', { name })}
            summary={props.summary}
            expandedByDefault={false}
            expanded={expanded}
            onExpandedChange={setExpanded}
            pulseEnabled={false}
            chrome="card"
            icon={props.peer.handback ? 'robot' : 'chat-circle'}
            headerTestID="transcript-peer-message-header"
        >
            {props.children}
        </ThinkingTimelineRow>
    );
});
