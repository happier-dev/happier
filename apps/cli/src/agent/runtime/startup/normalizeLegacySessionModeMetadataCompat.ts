import type { Metadata } from '@/api/types';
import { SESSION_MODE_OVERRIDE_KEY } from '@happier-dev/agents';

export function normalizeLegacySessionModeMetadataCompat<TMetadata extends Metadata | null | undefined>(
    metadata: TMetadata,
): TMetadata {
    if (!metadata) {
        return metadata;
    }

    const record = metadata as Record<string, unknown>;
    const canonicalOverride = record[SESSION_MODE_OVERRIDE_KEY];
    const legacyOverride = record.acpSessionModeOverrideV1;

    if (canonicalOverride === undefined && legacyOverride === undefined) {
        return metadata;
    }

    const normalized = { ...record } as Record<string, unknown>;
    if (canonicalOverride === undefined && legacyOverride !== undefined) {
        normalized[SESSION_MODE_OVERRIDE_KEY] = legacyOverride;
    }
    delete normalized.acpSessionModeOverrideV1;
    return normalized as TMetadata;
}
