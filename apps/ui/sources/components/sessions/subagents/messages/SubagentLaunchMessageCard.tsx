import React from 'react';

import type { Message } from '@/sync/domains/messages/messageTypes';
import { readStructuredUserMessageText } from '@/components/sessions/transcript/structured/readStructuredUserMessageText';
import { t } from '@/text';
import type { SubagentLaunchV1 } from '@happier-dev/protocol';

import { SubagentStructuredMessageCard } from './SubagentStructuredMessageCard';

function describeLaunchTitle(payload: SubagentLaunchV1): string {
    if (payload.kind === 'agent_team_create') return t('session.subagents.messages.launch.createTeamTitle');
    return t('session.subagents.messages.launch.createMemberTitle');
}

function describeLaunchTarget(payload: SubagentLaunchV1): string {
    if (payload.kind === 'agent_team_create') return t('session.subagents.messages.teamLabel', { teamId: payload.teamId });
    return t('session.subagents.messages.memberLabel', { memberLabel: payload.memberLabel, teamId: payload.teamId });
}

function describeLaunchDetail(payload: SubagentLaunchV1): string | null {
    if (payload.kind === 'agent_team_create') return payload.description?.trim() || null;
    return payload.instructions.trim();
}

export function SubagentLaunchMessageCard(props: Readonly<{ payload: SubagentLaunchV1; message: Message }>) {
    const messageText = readStructuredUserMessageText(props.message);
    if (!messageText) return null;

    return (
        <SubagentStructuredMessageCard
            title={describeLaunchTitle(props.payload)}
            targetLabel={describeLaunchTarget(props.payload)}
            detailText={describeLaunchDetail(props.payload)}
            messageText={messageText}
        />
    );
}
