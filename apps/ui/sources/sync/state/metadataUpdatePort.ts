import type { MetadataUpdatePort } from '@happier-dev/agents';
import type { SessionMetadata } from '@happier-dev/protocol';
import type { Metadata } from '@/sync/domains/state/storageTypes';

function isForbiddenMetadataUpdateError(error: unknown): boolean {
    const record = error && typeof error === 'object'
        ? error as Record<string, unknown>
        : null;
    const code = typeof record?.code === 'string' ? record.code : '';
    if (code === 'forbidden' || code === 'not_authenticated' || code === 'unauthorized') {
        return true;
    }
    if (record?.status === 403 || record?.statusCode === 403) {
        return true;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return message.includes('forbidden')
        || message.includes('not authenticated')
        || message.includes('unauthorized')
        || message.includes('403');
}

export function createUiSessionStateMetadataUpdatePort(params: Readonly<{
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
        opts?: Readonly<{ maxAttempts?: number }>,
    ) => Promise<unknown>;
}>): MetadataUpdatePort {
    return {
        update: async (sessionId, updater, opts) => {
            try {
                const result = await params.updateSessionMetadataWithRetry(
                    sessionId,
                    (metadata) => updater(metadata as SessionMetadata) as Metadata,
                    typeof opts?.maxAttempts === 'number' ? { maxAttempts: opts.maxAttempts } : undefined,
                );
                const version = typeof (result as { version?: unknown } | null)?.version === 'number'
                    ? (result as { version: number }).version
                    : 0;
                return { ok: true, version };
            } catch (error) {
                if (isForbiddenMetadataUpdateError(error)) {
                    return { ok: false, reason: 'forbidden' };
                }
                const code = typeof (error as { code?: unknown } | null)?.code === 'string'
                    ? (error as { code: string }).code
                    : 'unknown_error';
                if (code === 'unsupported' || code === 'conflict' || code === 'forbidden' || code === 'unknown_error') {
                    return { ok: false, reason: code };
                }
                return { ok: false, reason: 'unknown_error' };
            }
        },
    };
}
