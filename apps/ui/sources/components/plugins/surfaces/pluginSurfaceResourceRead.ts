import type {
    PluginResourceContextV1,
} from '@happier-dev/protocol';
import type {
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginUiResourceClient } from '@happier-dev/plugin-ui/advanced';

import {
    machinePluginUiResourceRead,
    mapMachinePluginUiResourceTransportFailure,
} from '@/sync/ops/machineContributionRegistryProjection';
import { decodeBase64 } from '@/encryption/base64';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

/**
 * The mounted `readResource` handler (§3.6).
 *
 * `readResource` is the single snapshot authority for plugin UI. This module is
 * a transport adapter only: admission, generation currentness, path containment,
 * byte bounds and integrity verification all belong to the daemon's declared
 * resource service, which this handler reaches through the canonical machine
 * RPC. It owns no caching, no second resource registry and no invalidation.
 *
 * The reference is **caller-scoped**: a bare local id binds to the plugin that
 * owns the mounted surface, and a structured reference naming a different plugin
 * is rejected. The daemon enforces the same bind, so this is a fast local
 * rejection of an already-invalid request, not the authority.
 */

export type PluginSurfaceResourceReadTransport = typeof machinePluginUiResourceRead;

export type PluginSurfaceResourceBinding = Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedGeneration: string;
    /**
     * Host-stamped contextual Resource authority for this exact mounted
     * consumer. Plugin code cannot supply or rewrite it through a request.
     */
    context?: PluginResourceContextV1;
    timeoutMs?: number;
    read?: PluginSurfaceResourceReadTransport;
}>;

/** A direct host-stamped Resource binding without a public Surface envelope. */
export type PluginContextualResourceBinding = PluginSurfaceResourceBinding;

/**
 * Resource work belongs to the mounted controller as well as its individual
 * caller. A replacement must cancel the old daemon request instead of merely
 * fencing its late delivery; a caller cancellation remains independently
 * observable through the same transport signal.
 */
type JsonRecord = Readonly<Record<string, PluginUiJsonValueV1>>;

function readJsonRecord(value: PluginUiJsonValueV1 | undefined): JsonRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Resolve the public `{ resource }` payload to one qualified reference. A bare
 * string binds to the calling plugin; a structured reference is taken as given
 * so a cross-plugin reference is visible to the rejection below rather than
 * being silently rewritten to the caller.
 */
export function readPluginSurfaceResourceReference(
    callerPluginId: string,
    value: unknown,
): Readonly<{ pluginId: string; localId: string }> | null {
    const bare = readString(value);
    if (bare) return { pluginId: callerPluginId, localId: bare };
    const record = readRecord(value);
    if (!record) return null;
    const pluginId = readString(record.pluginId);
    const localId = readString(record.localId);
    return pluginId && localId ? { pluginId, localId } : null;
}

function resourceClientFailure(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

function assertCurrentContextualResourceClient(
    isCurrent: (() => boolean) | undefined,
    signal: AbortSignal | undefined,
): void {
    if (signal?.aborted) {
        resourceClientFailure('plugin_resource_aborted', 'Resource operation was aborted');
    }
    if (isCurrent?.() === false) {
        resourceClientFailure('plugin_surface_retired', 'Resource surface is retired');
    }
}

/**
 * A direct bound Resource read client for host-owned contextual consumers. It
 * uses the same daemon snapshot authority as a mounted Surface handler while
 * deliberately avoiding a fabricated Surface envelope or author-visible
 * identity. The caller supplies the exact target context from its live host
 * binding; plugin code never writes it.
 */
export function createPluginContextualResourceReadClient(input: Readonly<{
    pluginId: string;
    resource: PluginContextualResourceBinding;
    isCurrent?: () => boolean;
}>): Pick<PluginUiResourceClient, 'readResource'> {
    const read = input.resource.read ?? machinePluginUiResourceRead;
    return Object.freeze({
        async readResource(resource, options) {
            const reference = readPluginSurfaceResourceReference(input.pluginId, resource);
            if (!reference) {
                return resourceClientFailure(
                    'plugin_resource_request_invalid',
                    'Resource reference is invalid',
                );
            }
            if (reference.pluginId !== input.pluginId) {
                return resourceClientFailure('plugin_resource_not_found', 'Resource is not declared for this plugin');
            }
            const signal = options?.signal;
            assertCurrentContextualResourceClient(input.isCurrent, signal);
            const outcome = await read(input.resource.machineId, {
                serverId: input.resource.serverId ?? null,
                expectedGeneration: input.resource.expectedGeneration,
                callerPluginId: input.pluginId,
                resource: reference,
                ...(input.resource.context === undefined ? {} : { context: input.resource.context }),
                ...(input.resource.timeoutMs === undefined ? {} : { timeoutMs: input.resource.timeoutMs }),
                ...(signal === undefined ? {} : { signal }),
            });
            assertCurrentContextualResourceClient(input.isCurrent, signal);
            if (!outcome.supported) {
                const transportFailure = mapMachinePluginUiResourceTransportFailure(outcome.reason);
                return resourceClientFailure(
                    transportFailure.code,
                    'Resource transport is unavailable',
                );
            }
            if (!outcome.result.ok) {
                return resourceClientFailure(outcome.result.code, 'Resource is unavailable');
            }
            try {
                return Object.freeze({
                    contentType: outcome.result.contentType,
                    digest: outcome.result.digest,
                    bytes: decodeBase64(outcome.result.bytesBase64, 'base64'),
                });
            } catch {
                return resourceClientFailure('plugin_resource_payload_invalid', 'Resource response bytes are invalid');
            }
        },
    } satisfies Pick<PluginUiResourceClient, 'readResource'>);
}

function errorPayload(
    code: 'unavailable' | 'invalid_payload',
    reason: string,
): PluginUiJsonValueV1 {
    return createPluginSurfaceHostApiError(code, [reason]);
}

function resourceAbortPayload(isCurrent: (() => boolean) | undefined): PluginUiJsonValueV1 {
    return errorPayload(
        'unavailable',
        isCurrent?.() === false ? 'plugin_surface_retired' : 'plugin_resource_aborted',
    );
}

export function createPluginSurfaceResourceReadHandler(input: Readonly<{
    pluginId: string;
    resource: PluginSurfaceResourceBinding;
    isCurrent?: () => boolean;
    /** The bound controller's one mount lifetime; absent for direct unit composition. */
    lifetimeSignal?: AbortSignal;
}>) {
    const read = input.resource.read ?? machinePluginUiResourceRead;
    return async (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const payload = readJsonRecord(request.payload);
        const reference = payload
            ? readPluginSurfaceResourceReference(input.pluginId, payload.resource)
            : null;
        if (!reference) {
            return errorPayload('invalid_payload', 'plugin_surface_resource_payload_invalid');
        }
        if (reference.pluginId !== input.pluginId) {
            return errorPayload('unavailable', 'plugin_resource_not_found');
        }
        if (input.isCurrent?.() === false) {
            return errorPayload('unavailable', 'plugin_surface_retired');
        }
        const mergedSignal = mergeAbortSignals([input.lifetimeSignal, options?.signal]);
        const signal = mergedSignal.signal;
        try {
        if (signal?.aborted) return resourceAbortPayload(input.isCurrent);

        let outcome: Awaited<ReturnType<PluginSurfaceResourceReadTransport>>;
        try {
            outcome = await read(input.resource.machineId, {
                serverId: input.resource.serverId ?? null,
                expectedGeneration: input.resource.expectedGeneration,
                callerPluginId: input.pluginId,
                resource: reference,
                ...(input.resource.context === undefined ? {} : { context: input.resource.context }),
                ...(input.resource.timeoutMs === undefined ? {} : { timeoutMs: input.resource.timeoutMs }),
                ...(signal === undefined ? {} : { signal }),
            });
        } catch (error) {
            if (signal?.aborted) return resourceAbortPayload(input.isCurrent);
            throw error;
        }
        if (signal?.aborted) return resourceAbortPayload(input.isCurrent);
        if (!outcome.supported) {
            return errorPayload(
                'unavailable',
                mapMachinePluginUiResourceTransportFailure(outcome.reason).code,
            );
        }
        if (!outcome.result.ok) {
            return errorPayload('unavailable', outcome.result.code);
        }
        // Revalidate after the awaited round trip: a surface retired while the
        // daemon was reading must not disclose the bytes it returned.
        if (input.isCurrent?.() === false) {
            return errorPayload('unavailable', 'plugin_surface_retired');
        }
        return {
            contentType: outcome.result.contentType,
            digest: outcome.result.digest,
            bytesBase64: outcome.result.bytesBase64,
        };
        } finally {
            mergedSignal.dispose();
        }
    };
}
