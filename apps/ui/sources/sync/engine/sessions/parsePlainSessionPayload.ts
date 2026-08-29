import { AgentStateSchema, MetadataSchema, type AgentState, type Metadata } from '@/sync/domains/state/storageTypes';
import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol';

export function readSessionMetadataLayoutVersion(value: unknown): number {
    if (value === undefined) return 0;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : -1;
}

export function compareSessionMetadataRevisions(params: Readonly<{
    incomingLayoutVersion: unknown;
    incomingMetadataVersion: unknown;
    storedLayoutVersion: unknown;
    storedMetadataVersion: unknown;
}>): number {
    const incomingLayoutVersion = readSessionMetadataLayoutVersion(params.incomingLayoutVersion);
    const storedLayoutVersion = readSessionMetadataLayoutVersion(params.storedLayoutVersion);
    if (incomingLayoutVersion < 0 || storedLayoutVersion < 0) {
        return 0;
    }
    if (incomingLayoutVersion !== storedLayoutVersion) {
        return incomingLayoutVersion - storedLayoutVersion;
    }
    const incomingMetadataVersion =
        typeof params.incomingMetadataVersion === 'number' && Number.isFinite(params.incomingMetadataVersion)
            ? params.incomingMetadataVersion
            : 0;
    const storedMetadataVersion =
        typeof params.storedMetadataVersion === 'number' && Number.isFinite(params.storedMetadataVersion)
            ? params.storedMetadataVersion
            : 0;
    return incomingMetadataVersion - storedMetadataVersion;
}

/**
 * Canonical post-decrypt metadata boundary. Layout v1 is a recipient-safe wire
 * envelope and must never fall back to the permissive legacy metadata parser.
 */
export function tryParseDecryptedSessionMetadata(
    value: unknown,
    metadataLayoutVersion?: unknown,
): Metadata | undefined {
    const normalizedLayoutVersion = readSessionMetadataLayoutVersion(metadataLayoutVersion);
    if (normalizedLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
        const shared = SessionSharedMetadataV1Schema.safeParse(value);
        // Session state still carries the historical Metadata type. The strict
        // parse above is the authority boundary; this cast does not add fields.
        return shared.success ? shared.data as unknown as Metadata : undefined;
    }
    if (normalizedLayoutVersion !== 0) return undefined;
    const parsed = MetadataSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

export function parseDecryptedSessionMetadata(
    value: unknown,
    metadataLayoutVersion?: unknown,
): Metadata | null {
    return tryParseDecryptedSessionMetadata(value, metadataLayoutVersion) ?? null;
}

export function tryParsePlainSessionMetadata(
    value: string,
    metadataLayoutVersion?: unknown,
): Metadata | undefined {
    try {
        const parsedJson = JSON.parse(value);
        return tryParseDecryptedSessionMetadata(parsedJson, metadataLayoutVersion);
    } catch {
        return undefined;
    }
}

export function parsePlainSessionMetadata(
    value: string,
    metadataLayoutVersion?: unknown,
): Metadata | null {
    return tryParsePlainSessionMetadata(value, metadataLayoutVersion) ?? null;
}

export function tryParsePlainSessionAgentState(value: string | null): AgentState | undefined {
    if (!value) return {};
    try {
        const parsedJson = JSON.parse(value);
        const parsed = AgentStateSchema.safeParse(parsedJson);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export function parsePlainSessionAgentState(value: string | null): AgentState {
    return tryParsePlainSessionAgentState(value) ?? {};
}
