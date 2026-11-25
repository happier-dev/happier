import { useWorkflowsAvailability } from '@/components/workflows/gating/workflowsAvailability';
import { useActiveServerAccountScope, getStorage } from '@/sync/domains/state/storage';
import { readStoredSessionTranscriptForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

export function useTranscriptWorkflowRunCardsAvailable(serverId: string | null | undefined): boolean {
    const scope = useActiveServerAccountScope();
    const { available } = useWorkflowsAvailability();
    return available && scope !== null && Boolean(serverId)
        && areServerProfileIdentifiersEquivalent(scope.serverId, serverId);
}

export function useTranscriptWorkflowRunStarts(sessionId: string, serverId: string | null | undefined, enabled: boolean) {
    const address = enabled ? normalizeSessionAddress(serverId, sessionId) : null;
    return getStorage()((state) => readStoredSessionTranscriptForAddress(state, address)?.latestWorkerUpdates?.workflowRunStarts,
        { sessionMessages: address ? [address.sessionId] : [] });
}

/** The exact latest notice for one Run in this Session. Other workers cannot notify the card. */
export function useTranscriptWorkflowRunNotice(sessionId: string, serverId: string | null | undefined, runId: string | null) {
    const address = runId === null ? null : normalizeSessionAddress(serverId, sessionId);
    return getStorage()((state) => {
        if (!address || runId === null) return null;
        const transcript = readStoredSessionTranscriptForAddress(state, address);
        const notice = transcript?.latestWorkerUpdates?.workflow_run?.[runId];
        const message = notice ? transcript?.messagesById[notice.messageId] : undefined;
        return message?.kind === 'agent-event' && message.event.type === 'worker-update' ? message.event.update : null;
    }, { sessionMessages: address ? [address.sessionId] : [] });
}
