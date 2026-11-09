import {
    type SessionStateFieldWriteValue,
} from '@happier-dev/agents';
import type { SessionStateFieldId } from '@happier-dev/protocol';

import type { Metadata } from '@happier-dev/session-core/state';
import { writeUiSessionStateField, type UiSessionStateMetadataPreprocess, type UiSessionStateMetadataPostprocess } from './engine';

export async function publishUiSessionStateFieldToMetadata<F extends SessionStateFieldId>(params: Readonly<{
    sessionId: string;
    fieldId: F;
    value: SessionStateFieldWriteValue<F>;
    reason: string;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
    ) => Promise<unknown>;
    metadataPreprocess?: UiSessionStateMetadataPreprocess;
    metadataPostprocess?: UiSessionStateMetadataPostprocess;
}>): Promise<void> {
    let cause: unknown;
    const result = await writeUiSessionStateField({
        sessionId: params.sessionId,
        fieldId: params.fieldId,
        value: params.value,
        metadataReason: params.reason,
        updateSessionMetadataWithRetry: async (...args) => {
            try {
                return await params.updateSessionMetadataWithRetry(...args);
            } catch (error) {
                cause = error;
                throw error;
            }
        },
        ...(params.metadataPreprocess ? { metadataPreprocess: params.metadataPreprocess } : {}),
        ...(params.metadataPostprocess ? { metadataPostprocess: params.metadataPostprocess } : {}),
    });
    if (!result.ok) {
        throw new Error(`Session state metadata update failed: ${result.reason}`, { cause });
    }
}
