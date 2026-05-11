import type {
    SessionStateFieldWriteValue,
    TimestampedFieldStaleBehavior,
} from '@happier-dev/agents';
import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { writeUiSessionStateField } from './engine';

type DisplayTitleWriteValue = SessionStateFieldWriteValue<'display.title'>;

type UpdateSessionMetadataWithRetry = (
    sessionId: string,
    updater: (metadata: Metadata) => Metadata,
    opts?: Readonly<{ maxAttempts?: number }>,
) => Promise<unknown>;

function applyResolvedDisplayTitleMetadata(params: Readonly<{
    title: string;
    updatedAt?: number;
    staleBehavior?: TimestampedFieldStaleBehavior;
    resolveTitle?: (metadata: Metadata) => string;
}>, metadata: Metadata): Metadata {
    if (!params.resolveTitle) return metadata;
    const resolvedTitle = params.resolveTitle(metadata).trim();
    return applyDisplayTitleSessionMetadata(metadata, {
        title: resolvedTitle || params.title,
        ...(typeof params.updatedAt === 'number' ? { updatedAt: params.updatedAt } : {}),
        staleBehavior: params.staleBehavior ?? 'drop',
        ...(resolvedTitle ? {} : { preserveExistingValue: true }),
    });
}

export async function publishDisplayTitleToMetadata(params: Readonly<{
    sessionId: string;
    title: string;
    updatedAt?: number;
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
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
    updateSessionMetadataWithRetry: UpdateSessionMetadataWithRetry;
}>): Promise<void> {
    const value: DisplayTitleWriteValue = {
        title: params.title,
        ...(typeof params.updatedAt === 'number' ? { updatedAt: params.updatedAt } : {}),
        staleBehavior: params.staleBehavior ?? 'drop',
        ...(params.resolveTitle
            ? {
                preserveExistingValue: true,
            }
            : {}),
    };
    const result = await writeUiSessionStateField({
        sessionId: params.sessionId,
        fieldId: 'display.title',
        value,
        metadataReason: 'ui-display-title',
        updateSessionMetadataWithRetry: params.updateSessionMetadataWithRetry,
        ...(params.resolveTitle ? { metadataPreprocess: (metadata: Metadata) => applyResolvedDisplayTitleMetadata(params, metadata) } : {}),
        ...(params.transformAfterTitle ? { metadataPostprocess: params.transformAfterTitle } : {}),
    });
    if (!result.ok) {
        throw new Error(`Session state metadata update failed: ${result.reason}`);
    }
}
