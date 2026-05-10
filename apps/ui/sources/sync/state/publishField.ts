import {
    type SessionStateFieldWriteValue,
} from '@happier-dev/agents';
import type { SessionStateFieldId } from '@happier-dev/protocol';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { writeUiSessionStateField } from './engine';

export async function publishUiSessionStateFieldToMetadata<F extends SessionStateFieldId>(params: Readonly<{
    sessionId: string;
    fieldId: F;
    value: SessionStateFieldWriteValue<F>;
    reason: string;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
    ) => Promise<unknown>;
}>): Promise<void> {
    const result = await writeUiSessionStateField({
        sessionId: params.sessionId,
        fieldId: params.fieldId,
        value: params.value,
        metadataReason: params.reason,
        updateSessionMetadataWithRetry: params.updateSessionMetadataWithRetry,
    });
    if (!result.ok) {
        throw new Error(`Session state metadata update failed: ${result.reason}`);
    }
}
