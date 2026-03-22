import type { Message } from '@/sync/domains/messages/messageTypes';

import { readClaudeIgnoredLifecycleEventType } from '../../../providers/claude/readClaudeIgnoredLifecycleEventType';
import type { SessionSubagentVisibleMessagesResolver } from '../../types';

function shouldKeepMessage(message: Message): boolean {
    if (message.kind !== 'agent-text') return true;
    return readClaudeIgnoredLifecycleEventType(message.text) == null;
}

export const filterClaudeSubagentVisibleMessages: SessionSubagentVisibleMessagesResolver = (context) => {
    if (context.subagent?.kind !== 'agent_team_member') return null;

    return context.focusedMessages.filter(shouldKeepMessage);
};
