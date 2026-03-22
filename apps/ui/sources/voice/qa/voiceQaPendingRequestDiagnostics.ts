import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import {
    listPendingPermissionRequests,
    listPendingTranscriptRequests,
    listPendingUserActionRequests,
} from '@/utils/sessions/sessionUtils';

import { useVoiceQaStore } from './voiceQaStore';

function formatPendingRequestDebugLabel(ids: ReadonlyArray<string>): string {
    return ids.length > 0 ? ids.join(',') : 'none';
}

export function formatVoiceQaPendingRequestBreakdown(targetSessionId: string): string | null {
    if (!targetSessionId || targetSessionId === '__voice_agent__') return null;
    const session = (storage.getState() as any)?.sessions?.[targetSessionId] ?? null;
    if (!session) return null;
    const messages = readStoredSessionMessages(storage.getState(), targetSessionId) as ReadonlyArray<any>;
    const userActionIds = listPendingUserActionRequests(session, messages).map((request) => request.id);
    const permissionIds = listPendingPermissionRequests(session, messages).map((request) => request.id);
    const transcriptIds = listPendingTranscriptRequests(session, messages).map((request) => request.id);
    return `Pending request breakdown: user_action=${userActionIds.length}(${formatPendingRequestDebugLabel(userActionIds)}) permission=${permissionIds.length}(${formatPendingRequestDebugLabel(permissionIds)}) transcript=${transcriptIds.length}(${formatPendingRequestDebugLabel(transcriptIds)})`;
}

export function appendVoiceQaPendingRequestContextDiagnostics(
    qaStore: typeof useVoiceQaStore,
    hasPendingRequestsInTargetContext: boolean,
    pendingRequestBreakdown: string | null,
    options?: Readonly<{ refreshed?: boolean }>,
): void {
    const suffix = options?.refreshed === true ? ' after refresh' : '';
    qaStore
        .getState()
        .appendSystem(
            `Pending requests detected in target-session context${suffix}: ${hasPendingRequestsInTargetContext ? 'yes' : 'no'}`,
        );
    if (pendingRequestBreakdown) {
        qaStore.getState().appendSystem(pendingRequestBreakdown);
    }
}
