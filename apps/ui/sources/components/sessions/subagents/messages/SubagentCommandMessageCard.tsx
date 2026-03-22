import React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStructuredUserMessageText } from '@/components/sessions/transcript/structured/readStructuredUserMessageText';
import { t } from '@/text';
import type { SubagentCommandV1 } from '@happier-dev/protocol';

import { SubagentStructuredMessageCard } from './SubagentStructuredMessageCard';

function describeCommandTitle(payload: SubagentCommandV1): string {
    if (payload.kind === 'agent_team_delete') return t('session.subagents.messages.command.deleteTeamTitle');
    return t('session.subagents.messages.command.deleteMemberTitle');
}

function describeCommandTarget(payload: SubagentCommandV1): string {
    if (payload.kind === 'agent_team_delete') return t('session.subagents.messages.teamLabel', { teamId: payload.teamId });
    return t('session.subagents.messages.memberLabel', {
        memberLabel: payload.memberLabel ?? payload.memberId,
        teamId: payload.teamId,
    });
}

export function SubagentCommandMessageCard(props: Readonly<{ payload: SubagentCommandV1; message: Message }>) {
    const messageText = readStructuredUserMessageText(props.message);
    if (!messageText) return null;

    return (
        <SubagentStructuredMessageCard
            title={describeCommandTitle(props.payload)}
            targetLabel={describeCommandTarget(props.payload)}
            messageText={messageText}
        />
    );
}
