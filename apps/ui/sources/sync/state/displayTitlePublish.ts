import type { TimestampedFieldStaleBehavior } from '@happier-dev/agents';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { writeUiSessionStateField } from './engine';

export async function publishDisplayTitleToMetadata(params: Readonly<{
    sessionId: string;
    title: string;
    updatedAt?: number;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
    ) => Promise<unknown>;
}>): Promise<void> {
    await publishDisplayTitleMetadataMutation(params);
}

export async function publishDisplayTitleMetadataMutation(params: Readonly<{
    sessionId: string;
    title: string;
    updatedAt?: number;
    staleBehavior?: TimestampedFieldStaleBehavior;
    resolveTitle?: (metadata: Metadata) => string;
    transformAfterTitle?: (metadata: Metadata) => Metadata;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
    ) => Promise<unknown>;
}>): Promise<void> {
    const metadataPreprocess = params.resolveTitle
        ? (metadata: Metadata): Metadata => {
            const resolvedTitle = params.resolveTitle?.(metadata).trim() ?? '';
            if (!resolvedTitle) {
                return metadata;
            }
            return {
                ...metadata,
                summary: {
                    ...metadata.summary,
                    text: resolvedTitle,
                    updatedAt: typeof metadata.summary?.updatedAt === 'number'
                        ? metadata.summary.updatedAt
                        : Date.now(),
                },
            };
        }
        : undefined;
    const result = await writeUiSessionStateField({
        sessionId: params.sessionId,
        fieldId: 'display.title',
        value: {
            title: params.title,
            ...(typeof params.updatedAt === 'number' ? { updatedAt: params.updatedAt } : {}),
            staleBehavior: params.staleBehavior ?? 'drop',
            ...(params.resolveTitle ? { preserveExistingValue: true } : {}),
        },
        metadataReason: 'ui-display-title',
        updateSessionMetadataWithRetry: params.updateSessionMetadataWithRetry,
        ...(metadataPreprocess ? { metadataPreprocess } : {}),
        ...(params.transformAfterTitle ? { metadataPostprocess: params.transformAfterTitle } : {}),
    });
    if (!result.ok) {
        throw new Error(`Session state metadata update failed: ${result.reason}`);
    }
}
