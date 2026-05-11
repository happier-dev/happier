import type { Metadata } from '@/api/types';
import {
    LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
    readAcpSessionModeIntentFromMetadata,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';
import { applyAcpSessionModeIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

export function normalizeLegacySessionModeMetadataCompat<TMetadata extends Metadata | null | undefined>(
    metadata: TMetadata,
): TMetadata {
    if (!metadata) {
        return metadata;
    }

    const record = metadata as Record<string, unknown>;
    const canonicalOverride = record[SESSION_MODE_OVERRIDE_KEY];
    const legacyOverride = record[LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY];

    if (canonicalOverride === undefined && legacyOverride === undefined) {
        return metadata;
    }

    if (canonicalOverride === undefined && legacyOverride !== undefined) {
        const intent = readAcpSessionModeIntentFromMetadata(metadata);
        if (!intent || !intent.modeId) {
            return metadata;
        }
        return applyAcpSessionModeIntentSessionMetadata(metadata, {
            v: 1,
            modeId: intent.modeId,
            updatedAt: intent.updatedAt,
        }) as TMetadata;
    }

    return metadata;
}
