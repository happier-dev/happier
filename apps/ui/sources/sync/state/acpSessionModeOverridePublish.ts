import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishUiSessionStateFieldToMetadata } from './publishField';

export async function publishAcpSessionModeOverrideToMetadata(params: {
    sessionId: string;
    modeId: string;
    updatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, modeId, updatedAt, updateSessionMetadataWithRetry } = params;

    await publishUiSessionStateFieldToMetadata({
        sessionId,
        fieldId: 'intent.acpSessionMode',
        value: { v: 1, modeId: modeId || null, updatedAt },
        reason: 'ui-acp-session-mode',
        updateSessionMetadataWithRetry,
    });
}
