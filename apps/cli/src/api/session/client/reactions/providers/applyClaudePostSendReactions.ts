import type { Usage } from '@/api/types';
import { logger } from '@/ui/logger';

import {
    updateMetadataBestEffort,
} from '../../../sessionWritesBestEffort';
import { publishClaudeAssistantUsage } from '@/backends/claude/usage/publishAssistantUsage';
import type { PostSendReactionPort } from './postSendReactionPort';

type ClaudeDispatchReaction = Readonly<{
    usage?: Readonly<{ usage: Usage; model?: string }>;
    summary?: Readonly<{ text: string; updatedAt: number }>;
}>;

export function applyClaudePostSendReactions(
    port: PostSendReactionPort,
    params: ClaudeDispatchReaction,
): void {
    const usage = params.usage;
    if (usage) {
        try {
            publishClaudeAssistantUsage({
                sessionId: port.sessionId,
                publisher: port.usageObservationPublisher,
                usage: usage.usage,
                model: usage.model,
            });
        } catch (error) {
            logger.debug('[SOCKET] Failed to send usage data:', error);
        }
    }

    const summary = params.summary;
    if (!summary) {
        return;
    }

    updateMetadataBestEffort(
        port,
        (metadata) => ({
            ...metadata,
            summary: {
                text: summary.text,
                updatedAt: summary.updatedAt,
            },
        }),
        '[API]',
        'mirror_claude_summary',
    );
}
