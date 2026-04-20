import {
    publishTokenCountUsageObservation,
} from '../usagePublishing';
import type { PostSendReactionPort } from './postSendReactionPort';

export function applyCodexPostSendReactions(
    port: PostSendReactionPort,
    params: Readonly<{
        normalizedBody: unknown;
        backendMode: string | null;
        externalKey: string | null;
    }>,
): void {
    if ((params.normalizedBody as { type?: unknown })?.type !== 'token_count') {
        return;
    }

    void publishTokenCountUsageObservation({
        sessionId: port.sessionId,
        publisher: port.usageObservationPublisher,
        provider: 'codex',
        body: params.normalizedBody,
        backendMode: params.backendMode,
        externalKey: params.externalKey,
    });
}
