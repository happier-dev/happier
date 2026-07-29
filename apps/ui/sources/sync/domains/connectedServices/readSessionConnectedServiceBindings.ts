import {
    readSessionMetadataConnectedServiceBindings,
} from '@happier-dev/agents';
import {
    ConnectedServiceBindingsV1Schema,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/**
 * Canonical UI reader for the Connected Services binding that a session
 * actually runs with. Current spawn metadata wins; provider runtime
 * descriptors are the bounded compatibility fallback for older sessions.
 */
export function readSessionConnectedServiceBindings(params: Readonly<{
    metadata: unknown;
    agentId: string;
}>): ConnectedServiceBindingsV1 | null {
    const metadata = readRecord(params.metadata);
    const explicit = ConnectedServiceBindingsV1Schema.safeParse(
        metadata?.connectedServices,
    );
    if (explicit.success) return explicit.data;

    const agentId = params.agentId.trim();
    if (!agentId) return null;
    const descriptorBindings = readSessionMetadataConnectedServiceBindings(
        params.metadata,
        agentId,
    );
    if (Object.keys(descriptorBindings).length === 0) return null;
    const descriptor = ConnectedServiceBindingsV1Schema.safeParse({
        v: 1,
        bindingsByServiceId: descriptorBindings,
    });
    return descriptor.success ? descriptor.data : null;
}
