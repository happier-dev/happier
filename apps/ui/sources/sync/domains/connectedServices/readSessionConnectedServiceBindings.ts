import {
    readSessionMetadataConnectedServiceBindings,
} from '@happier-dev/agents';
import {
    BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    ConnectedServiceBindingsV1Schema,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { resolveQualifiedConnectedAccountServiceKey } from './connectedServiceRegistry';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

/**
 * Canonical UI reader for the Connected Services binding that a session
 * actually runs with. Resolution order:
 *
 * 1. current qualified writer shape (`ConnectedServiceBindingsV1Schema`);
 * 2. the Protocol-named `BuiltInLegacyConnectedServiceBindingsV1Ingress`
 *    — released bundled Sessions persisted scalar service ids survive only
 *    through that provenance-named compatibility adapter, and are surfaced
 *    under their canonical qualified keys for display;
 * 3. the bounded provider runtime-descriptor fallback for older sessions,
 *    with every legacy scalar key normalized through the same generated
 *    built-in mapping; unknown ids fail closed and are dropped.
 *
 * Readers therefore always observe qualified keys, while new writes are
 * produced qualified by the canonical writers.
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

    const legacyIngress = BuiltInLegacyConnectedServiceBindingsV1IngressSchema.safeParse(
        metadata?.connectedServices,
    );
    if (legacyIngress.success) return legacyIngress.data;

    const agentId = params.agentId.trim();
    if (!agentId) return null;
    const descriptorBindings = readSessionMetadataConnectedServiceBindings(
        params.metadata,
        agentId,
    );
    if (Object.keys(descriptorBindings).length === 0) return null;
    const normalizedBindingsByServiceId: Record<string, ConnectedServiceBindingsV1['bindingsByServiceId'][string]> = {};
    for (const [serviceId, binding] of Object.entries(descriptorBindings)) {
        const qualifiedServiceKey = resolveQualifiedConnectedAccountServiceKey(serviceId);
        if (!qualifiedServiceKey) continue;
        normalizedBindingsByServiceId[qualifiedServiceKey] = binding;
    }
    if (Object.keys(normalizedBindingsByServiceId).length === 0) return null;
    const descriptor = ConnectedServiceBindingsV1Schema.safeParse({
        v: 1,
        bindingsByServiceId: normalizedBindingsByServiceId,
    });
    return descriptor.success ? descriptor.data : null;
}
