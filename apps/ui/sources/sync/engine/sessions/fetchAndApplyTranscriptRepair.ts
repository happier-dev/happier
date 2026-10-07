import { buildSessionMessagesPath } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { repairSessionMessagesTargets } from '@happier-dev/sync-client';
import { runSessionMessagesPagePipeline } from './sessionMessagesPagePipeline';

type PagePipelineParams = Parameters<typeof runSessionMessagesPagePipeline>[0];

/** Repairs bounded ranges without taking ownership of the visible window or tail cursor. */
export async function fetchAndApplyTranscriptRepair(params: Omit<
    PagePipelineParams,
    'purpose' | 'page' | 'lifecyclePolicy' | 'onMessagesPage' | 'onTaskLifecycleEvent'
    | 'messageIds' | 'authoritativeUpdateMessageIds'
> & {
    targets: readonly Readonly<{ messageId: string; seq: number }>[];
    pageSize: number;
    onResolvedMessageIds?: (messageIds: ReadonlySet<string>) => void;
}): Promise<ReadonlySet<string>> {
    return repairSessionMessagesTargets({
        targets: params.targets,
        pageSize: params.pageSize,
        signal: new AbortController().signal,
        fetchPage: async (afterSeq, _signal, targetIds) => {
            // Coalesced AccountChange hints are not identity-complete. Keep the old
            // first page's known-neighbor refresh, with unseen spill excluded by the
            // pipeline and equal-revision overwrite authority restricted to targets.
            const limit = params.pageSize;
            const result = await runSessionMessagesPagePipeline({
                ...params,
                messageIds: targetIds,
                authoritativeUpdateMessageIds: targetIds,
                purpose: 'target-window',
                page: {
                    direction: 'newer', scope: 'all', afterSeq, limit,
                    requestPath: buildSessionMessagesPath({ sessionId: params.sessionId, scope: 'all', afterSeq, limit }),
                },
                lifecyclePolicy: 'suppress',
            });
            return result.page;
        },
        onPage: (messages, targetIds) => {
            // The pipeline commits revisions only after application. Already-current
            // targets also settle even when normalization was skipped by dedupe.
            const received = params.sessionReceivedMessages.get(params.sessionId);
            const resolvedMessageIds = new Set<string>();
            for (const message of messages) {
                if (!targetIds.has(message.id)) continue;
                const revision = received?.get(message.id);
                if (revision !== undefined && revision >= (message.updatedAt ?? message.createdAt)) {
                    resolvedMessageIds.add(message.id);
                }
            }
            return resolvedMessageIds;
        },
        onResolvedMessageIds: params.onResolvedMessageIds,
    });
}
