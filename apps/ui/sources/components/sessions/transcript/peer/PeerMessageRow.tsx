import * as React from 'react';

import { ThinkingTimelineRow } from '@/components/sessions/transcript/thinking/ThinkingTimelineRow';
import type { PeerMessageSender } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';

/** A teammate message or subagent report delivered into the agent's conversation, collapsed to its first line. */
export const PeerMessageRow = React.memo(function PeerMessageRow(props: {
    id: string;
    createdAt: number;
    peer: PeerMessageSender;
    summary: string;
    children: React.ReactNode;
}) {
    const name = props.peer.name ?? t('sessionInfo.peerUnnamedSender');
    return (
        <ThinkingTimelineRow
            id={props.id}
            createdAt={props.createdAt}
            label={props.peer.handback ? t('sessionInfo.peerReportFrom', { name }) : t('sessionInfo.peerMessageFrom', { name })}
            summary={props.summary}
            expandedByDefault={false}
            pulseEnabled={false}
            chrome="card"
            icon={props.peer.handback ? 'robot' : 'chat-circle'}
            headerTestID="transcript-peer-message-header"
        >
            {props.children}
        </ThinkingTimelineRow>
    );
});
