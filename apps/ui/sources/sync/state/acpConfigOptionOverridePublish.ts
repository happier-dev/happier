import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishUiSessionStateFieldToMetadata } from './publishField';

export type AcpConfigOptionOverrideValueId = string;

export async function publishAcpConfigOptionOverrideToMetadata(params: {
    sessionId: string;
    configId: string;
    value: AcpConfigOptionOverrideValueId;
    updatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, configId, value, updatedAt, updateSessionMetadataWithRetry } = params;

    await publishUiSessionStateFieldToMetadata({
        sessionId,
        fieldId: 'intent.acpConfigOption',
        value: { v: 1, configId, value, updatedAt },
        reason: 'ui-acp-config-option',
        updateSessionMetadataWithRetry,
    });
}
