import {
    isRuntimeTurnOperations,
    type RuntimeTurnCompletionOptions,
    type RuntimeTurnConfigUpdate,
    type RuntimeTurnMessageHandler,
    type RuntimeTurnOperations,
    type RuntimeTurnSessionIdentity,
    type RuntimeTurnStartOrLoadOptions,
    type RuntimePublicationEvent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { normalizePublishedRuntimeFacetsV1 } from '@/agent/runtime/facets/runtimeFacetsPublication';
import type {
    AgentRuntimeFacetsV1,
    RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol';

import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';

export type NormalizedPluginSessionLaunchResult = Readonly<{
    runtime: RuntimeTurnOperations;
    runtimeDescriptor: RuntimeDescriptorV1 | null;
    runtimeCapabilities: unknown;
    runtimeFacets: AgentRuntimeFacetsV1 | null;
}>;

export type PluginSessionLaunchResultCandidate =
    | RuntimeTurnOperations
    | Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildGenericPluginRuntimeDescriptor(backend: ResolvedBackendContribution): RuntimeDescriptorV1 | null {
    const runtimeKind = normalizeNonEmptyString(backend.runtimeKind);
    if (!runtimeKind) return null;

    return {
        v: 1,
        providerId: backend.providerId,
        provider: {
            backendMode: runtimeKind,
            providerExtra: {
                owner: 'happier',
                schemaId: 'happier.pluginRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: {
                    backendId: backend.id,
                    providerId: backend.providerId,
                    provenance: backend.provenance,
                    source: backend.source,
                },
            },
        },
    };
}

function emitRuntimeMetadataEvent(handler: RuntimeTurnMessageHandler, name: RuntimePublicationEvent['name'], payload: unknown): void {
    if (payload === null || payload === undefined) return;
    handler({
        type: 'event',
        name,
        payload,
    });
}

export function normalizePluginSessionLaunchResult(params: Readonly<{
    result: PluginSessionLaunchResultCandidate;
    backend: ResolvedBackendContribution;
}>): NormalizedPluginSessionLaunchResult {
    if (isRuntimeTurnOperations(params.result)) {
        throw new Error('Plugin terminal runtime launch must return an object payload with RuntimeTurnOperations');
    }

    if (!isRecord(params.result)) {
        throw new Error('Plugin terminal runtime launch must return an object payload with RuntimeTurnOperations');
    }

    const runtimeValue = params.result.runtime;
    if (!isRuntimeTurnOperations(runtimeValue)) {
        throw new Error('Plugin terminal runtime launch payload must include RuntimeTurnOperations');
    }

    return {
        runtime: runtimeValue,
        runtimeDescriptor: readRuntimeDescriptorV1(params.result.runtimeDescriptor)
            ?? buildGenericPluginRuntimeDescriptor(params.backend),
        runtimeCapabilities: params.result.runtimeCapabilities ?? null,
        runtimeFacets: normalizePublishedRuntimeFacetsV1(params.result.runtimeFacets),
    };
}

export function decorateRuntimeTurnOperationsWithMetadata(params: Readonly<{
    runtime: RuntimeTurnOperations;
    runtimeDescriptor: RuntimeDescriptorV1 | null;
    runtimeCapabilities: unknown;
    runtimeFacets: AgentRuntimeFacetsV1 | null;
}>): RuntimeTurnOperations {
    return Object.freeze({
        beginTurnLifecycle() {
            params.runtime.beginTurnLifecycle();
        },
        async startOrLoadSession(opts?: RuntimeTurnStartOrLoadOptions) {
            await params.runtime.startOrLoadSession(opts);
        },
        async sendTurnPrompt(prompt: string) {
            await params.runtime.sendTurnPrompt(prompt);
        },
        async steerInFlightTurn(message: string) {
            await params.runtime.steerInFlightTurn(message);
        },
        async waitForTurnCompletion(opts?: RuntimeTurnCompletionOptions) {
            await params.runtime.waitForTurnCompletion(opts);
        },
        subscribeRuntimeEvents(handler: RuntimeTurnMessageHandler) {
            emitRuntimeMetadataEvent(handler, 'runtime.descriptor', params.runtimeDescriptor);
            emitRuntimeMetadataEvent(handler, 'runtime.capabilities', params.runtimeCapabilities);
            emitRuntimeMetadataEvent(handler, 'runtime.facets', params.runtimeFacets);
            return params.runtime.subscribeRuntimeEvents(handler);
        },
        async respondToPermission(requestId: string, approved: boolean) {
            await params.runtime.respondToPermission(requestId, approved);
        },
        async cancelTurn() {
            await params.runtime.cancelTurn();
        },
        readSessionIdentity(): RuntimeTurnSessionIdentity {
            return params.runtime.readSessionIdentity();
        },
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            await params.runtime.updateSessionRuntimeConfig(update);
        },
        async resetOrDisposeRuntime() {
            await params.runtime.resetOrDisposeRuntime();
        },
    });
}
