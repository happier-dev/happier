import {
    isRuntimeTurnOperations,
    type RuntimeTurnCompletionOptions,
    type RuntimeTurnConfigUpdate,
    type RuntimeTurnMessageHandler,
    type RuntimeTurnOperations,
    type RuntimeTurnPromptMeta,
    type RuntimeTurnSessionIdentity,
    type RuntimePublicationEvent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import { normalizePublishedRuntimeFacetsV1 } from '@/agent/runtime/facets/runtimeFacetsPublication';
import type {
    AgentRuntimeFacetsV1,
    RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import { readRuntimeDescriptorV1 } from '@happier-dev/protocol';

import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';
import type { PluginRuntimeHookOperations } from './sessionRuntimeHooks';

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

function buildGenericPluginRuntimeDescriptor(backend: ResolvedAgentRuntimeContribution): RuntimeDescriptorV1 | null {
    const runtimeKind = normalizeNonEmptyString(backend.runtimeKind);
    if (!runtimeKind) return null;

    return {
        v: 1,
        agentId: backend.agentId,
        agent: {
            backendMode: runtimeKind,
            agentExtra: {
                owner: 'happier',
                schemaId: 'happier.pluginRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: {
                    backendId: backend.id,
                    agentId: backend.agentId,
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
    backend: ResolvedAgentRuntimeContribution;
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
    const runtime = params.runtime as PluginRuntimeHookOperations;
    return Object.freeze({
        ...(runtime.permissionCapability ? { permissionCapability: runtime.permissionCapability } : {}),
        beginTurnLifecycle() {
            runtime.beginTurnLifecycle();
        },
        async sendTurnPrompt(prompt: string, meta?: RuntimeTurnPromptMeta) {
            await runtime.sendTurnPrompt(prompt, meta);
        },
        ...(runtime.compactContext
            ? {
                async compactContext(command: string) {
                    await runtime.compactContext?.(command);
                },
            }
            : {}),
        ...(runtime.supportsInFlightSteer
            ? { supportsInFlightSteer: () => runtime.supportsInFlightSteer?.() ?? false }
            : {}),
        ...(runtime.isTurnInFlight
            ? { isTurnInFlight: () => runtime.isTurnInFlight?.() ?? false }
            : {}),
        ...(runtime.canSteerPrompt
            ? { canSteerPrompt: () => runtime.canSteerPrompt?.() ?? false }
            : {}),
        ...(runtime.steerPrompt
            ? {
                async steerPrompt(message: string, options?: RuntimeTurnPromptMeta) {
                    await runtime.steerPrompt?.(message, options);
                },
            }
            : {}),
        ...(runtime.setOnPromptAcceptedByProvider
            ? {
                setOnPromptAcceptedByProvider(handler: Parameters<NonNullable<typeof runtime.setOnPromptAcceptedByProvider>>[0]) {
                    runtime.setOnPromptAcceptedByProvider?.(handler);
                },
            }
            : {}),
        ...(runtime.setOnPromptDeliveryOutcome
            ? {
                setOnPromptDeliveryOutcome(handler: Parameters<NonNullable<typeof runtime.setOnPromptDeliveryOutcome>>[0]) {
                    runtime.setOnPromptDeliveryOutcome?.(handler);
                },
            }
            : {}),
        ...(runtime.setOnPromptTerminallyRejectedBeforeProvider
            ? {
                setOnPromptTerminallyRejectedBeforeProvider(
                    handler: Parameters<NonNullable<typeof runtime.setOnPromptTerminallyRejectedBeforeProvider>>[0],
                ) {
                    runtime.setOnPromptTerminallyRejectedBeforeProvider?.(handler);
                },
            }
            : {}),
        ...(runtime.clearTerminalComposer
            ? {
                clearTerminalComposer(request: Parameters<NonNullable<typeof runtime.clearTerminalComposer>>[0]) {
                    return runtime.clearTerminalComposer?.(request);
                },
            }
            : {}),
        ...(runtime.interruptPendingInputAndRun
            ? {
                interruptPendingInputAndRun(
                    request: Parameters<NonNullable<typeof runtime.interruptPendingInputAndRun>>[0],
                ) {
                    return runtime.interruptPendingInputAndRun?.(request);
                },
            }
            : {}),
        async steerInFlightTurn(message: string, meta?: RuntimeTurnPromptMeta) {
            await runtime.steerInFlightTurn(message, meta);
        },
        async waitForTurnCompletion(opts?: RuntimeTurnCompletionOptions) {
            await runtime.waitForTurnCompletion(opts);
        },
        subscribeRuntimeEvents(handler: RuntimeTurnMessageHandler) {
            emitRuntimeMetadataEvent(handler, 'runtime.descriptor', params.runtimeDescriptor);
            emitRuntimeMetadataEvent(handler, 'runtime.capabilities', params.runtimeCapabilities);
            emitRuntimeMetadataEvent(handler, 'runtime.facets', params.runtimeFacets);
            return runtime.subscribeRuntimeEvents(handler);
        },
        ...(runtime.respondToPermission
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    return await runtime.respondToPermission?.(requestId, approved) ?? {
                        delivered: false,
                        reason: 'unknown_request',
                    };
                },
            }
            : {}),
        async cancelTurn() {
            await runtime.cancelTurn();
        },
        readSessionIdentity(): RuntimeTurnSessionIdentity {
            return runtime.readSessionIdentity();
        },
        async updateSessionRuntimeConfig(update: RuntimeTurnConfigUpdate) {
            await runtime.updateSessionRuntimeConfig(update);
        },
        async resetOrDisposeRuntime(reason, nextSessionOpenIntent) {
            await runtime.resetOrDisposeRuntime(reason, nextSessionOpenIntent);
        },
    });
}
