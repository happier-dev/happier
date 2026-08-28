import { randomUUID } from 'node:crypto';

import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';
import { createPluginContributionIdentity, getPluginHookDefinitionV1 } from '@happier-dev/protocol';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import type { ActivationTarget } from '../activation/targets';
import { clonePluginPlainData } from '../../plainData';
import { createPluginInvocationPresentation } from '../../invocation/services/interactions';
import { createPluginInvocationLifetime } from '../../invocation/lifetime';
import type {
    CreatePluginInvocationServiceBinding,
    CreatePluginInvocationServices,
    PluginInvocationServicesSeed,
} from '../../invocation/services/types';
import type {
    ResolvePluginInvocationHostPolicy,
    TargetActionHostAccessRequest,
} from '../../hostAccess/resolve';
import { resolveManifestHostAccessRequests } from '../../hostAccess/manifestRequests';
import { createUnavailablePluginServices } from '../../invocation/services/unavailable';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

type TargetHookDispatcherContext = Readonly<{
    signal?: AbortSignal;
    tools?: unknown;
}>;

type TargetHookInvocationContext = PluginInvocationContext & Readonly<{
    tools?: unknown;
}>;

export type TargetInvocationServiceOwner = Readonly<{
    createOrdinaryServiceBinding: CreatePluginInvocationServiceBinding;
    resolveInvocationHostPolicy?: ResolvePluginInvocationHostPolicy;
    createServices: CreatePluginInvocationServices;
}>;

function readTargetHookDispatcherContext(context: unknown): TargetHookDispatcherContext {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
    const record = context as Readonly<Record<string, unknown>>;
    return {
        ...(record.signal instanceof AbortSignal ? { signal: record.signal } : {}),
        ...(Object.prototype.hasOwnProperty.call(record, 'tools') ? { tools: record.tools } : {}),
    };
}

function readHookPayload(event: unknown): JsonValue {
    const raw = event && typeof event === 'object' && !Array.isArray(event) && 'payload' in event
        ? (event as Readonly<{ payload?: unknown }>).payload
        : event;
    try {
        return clonePluginPlainData(raw, {
            path: 'hook payload',
            invalid: (message) => new Error(message),
        }) as JsonValue;
    } catch {
        throw new Error('Plugin hook payload must be JSON-safe');
    }
}

function hookCancellationError(): Error {
    const error = new Error('Plugin hook invocation was cancelled');
    error.name = 'AbortError';
    return error;
}

async function invokeHookWithCancellation<TResult>(
    invoke: () => TResult | Promise<TResult>,
    signal: AbortSignal,
): Promise<TResult> {
    if (signal.aborted) throw hookCancellationError();
    const operation = Promise.resolve(invoke());
    let rejectCancellation!: (error: unknown) => void;
    const onAbort = () => rejectCancellation(hookCancellationError());
    const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
        signal.addEventListener('abort', onAbort, { once: true });
    });
    if (signal.aborted) onAbort();
    try {
        const result = await Promise.race([operation, cancellation]);
        if (signal.aborted) throw hookCancellationError();
        return result;
    } finally {
        signal.removeEventListener('abort', onAbort);
        void operation.catch(() => {});
    }
}

export type TargetHookHandlerRegistry = Readonly<{
    handlersByHookId: ReadonlyMap<string, readonly ResolvedPluginHookHandler[]>;
    /**
     * Author-actionable refusals, keyed by the plugin that owns the refused
     * registration. Every correctly-authored hook handler still projects.
     */
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}>;

/**
 * Joins activation-owned hook handlers onto their manifest declarations.
 *
 * A declaration that contradicts the canonical hook contract is a defect in
 * exactly one plugin, so it fails that hook closed with the same
 * `plugin_activation_failed` diagnostic the activation owner uses to isolate a
 * throwing `activate()`. It must never take every other plugin's hooks down.
 */
export function createTargetHookHandlerRegistry(params: Readonly<{
    generation: number;
    activationTargets: readonly ActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    isGenerationActive(): boolean;
    invocationServices?: TargetInvocationServiceOwner;
}>): TargetHookHandlerRegistry {
    const handlersByHookId = new Map<string, ResolvedPluginHookHandler[]>();
    const diagnosticsByPluginId: Record<string, readonly PluginCompatibilityDiagnostic[]> = {};
    let registrationIndex = 0;

    function refuse(pluginId: string, localId: string, message: string): void {
        const diagnostic: PluginCompatibilityDiagnostic = Object.freeze({
            code: 'plugin_activation_failed',
            message,
            contribution: createPluginContributionIdentity({ pluginId, localId }),
        });
        const existing = diagnosticsByPluginId[pluginId] ?? [];
        if (existing.some((entry) => (
            entry.code === diagnostic.code && entry.message === diagnostic.message
        ))) return;
        diagnosticsByPluginId[pluginId] = Object.freeze([...existing, diagnostic]);
    }

    for (const entry of params.targetRegistrations) {
        if (entry.registration.family !== 'hooks') continue;
        const localId = entry.registration.localId;
        if (entry.generation !== String(params.generation)) {
            refuse(entry.pluginId, localId, `Target hook '${entry.pluginId}/hooks/${localId}' was published for the wrong generation`);
            continue;
        }
        const target = params.activationTargets.find((candidate) => candidate.pluginId === entry.pluginId);
        const declaration = target?.manifest.contributes.hooks.find((hook) => hook.id === localId);
        if (!target || !declaration) {
            refuse(entry.pluginId, localId, `Target hook registration '${entry.pluginId}/hooks/${localId}' has no matching manifest hook`);
            continue;
        }
        const canonicalDefinition = getPluginHookDefinitionV1(declaration.on);
        if (!canonicalDefinition
            || declaration.category !== canonicalDefinition.category
            || declaration.scope !== canonicalDefinition.scope
            || declaration.executionKind !== canonicalDefinition.executionKind) {
            refuse(
                entry.pluginId,
                localId,
                `Target hook registration '${entry.pluginId}/hooks/${localId}' does not match the canonical hook contract`
                + (canonicalDefinition
                    ? `: hook '${declaration.on}' is `
                      + `category '${canonicalDefinition.category}', scope '${canonicalDefinition.scope}', `
                      + `executionKind '${canonicalDefinition.executionKind}'`
                    : `: hook '${declaration.on}' has no canonical definition`),
            );
            continue;
        }
        const daemonEntryPath = target.daemonEntryPath ?? target.devDaemonEntryPath;
        if (!daemonEntryPath) {
            refuse(entry.pluginId, localId, `Target hook registration '${entry.pluginId}/hooks/${localId}' has no executable daemon entry`);
            continue;
        }
        const registration: ResolvedActivatedHookRegistration = Object.freeze({
            provenance: target.provenance,
            source: target.source,
            pluginId: target.pluginId,
            manifestPath: target.manifestPath,
            daemonEntryPath,
            devDaemonEntryPath: target.devDaemonEntryPath,
            sourceSpec: target.sourceSpec,
            definition: Object.freeze({
                hookApiVersion: 1,
                id: declaration.on,
                category: declaration.category,
                scope: declaration.scope,
                ...(declaration.filters ? { filters: declaration.filters } : {}),
                executionKind: declaration.executionKind,
                priority: declaration.priority,
                ...(declaration.compatibility ? { compatibility: declaration.compatibility } : {}),
                ...(declaration.metadata ? { metadata: declaration.metadata } : {}),
            }),
        });
        const handler: HookHandler = entry.registration.value;
        const hostAccessRequests: readonly TargetActionHostAccessRequest[] =
            resolveManifestHostAccessRequests({
                manifest: target.manifest,
                pluginId: target.pluginId,
                contribution: {
                    family: 'hooks',
                    localId: declaration.id,
                },
                ...(declaration.hostAccess ? { requestIds: declaration.hostAccess } : {}),
            });
        const resolved: ResolvedPluginHookHandler = Object.freeze({
            pluginId: target.pluginId,
            localId: declaration.id,
            hookId: declaration.on,
            priority: declaration.priority ?? 0,
            registrationIndex: registrationIndex++,
            manifestPath: target.manifestPath,
            daemonEntryPath,
            registration,
            handler: async (event, context) => {
                if (!params.isGenerationActive()) {
                    throw new Error(`Plugin '${target.pluginId}' hook handler is no longer active`);
                }
                const dispatcherContext = readTargetHookDispatcherContext(context);
                const lifetime = createPluginInvocationLifetime(dispatcherContext.signal);
                try {
                    const signal = lifetime.signal;
                    const plugin = Object.freeze({ id: target.pluginId, version: target.manifest.version });
                    const contribution = Object.freeze({
                        id: declaration.id,
                        qualifiedId: `${target.pluginId}/hooks/${declaration.id}`,
                    });
                    const invocationServices = params.invocationServices;
                    const services = invocationServices
                        ? (() => {
                            const seed: PluginInvocationServicesSeed = Object.freeze({
                                plugin,
                                contribution,
                                generation: entry.generation,
                                correlationId: randomUUID(),
                                surface: 'agent',
                                signal,
                                bypassActionInterception: true,
                                redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
                                isGenerationCurrent: params.isGenerationActive,
                            });
                            const serviceBinding = hostAccessRequests.length === 0
                                ? invocationServices.createOrdinaryServiceBinding(
                                    entry.generation,
                                    `${contribution.qualifiedId}:binding`,
                                    [],
                                    contribution.qualifiedId,
                                )
                                : invocationServices.resolveInvocationHostPolicy?.({
                                    pluginId: plugin.id,
                                    generation: entry.generation,
                                    qualifiedId: contribution.qualifiedId,
                                }, {
                                    hostAccessRequests,
                                    surface: 'agent',
                                    signal,
                                }).serviceBinding;
                            if (!serviceBinding) {
                                throw new Error(`Target hook '${contribution.qualifiedId}' has no HostAccess policy resolver`);
                            }
                            return invocationServices.createServices(seed, serviceBinding);
                        })()
                        : createUnavailablePluginServices();
                    const invocationContext: TargetHookInvocationContext = Object.freeze({
                        ...(Object.prototype.hasOwnProperty.call(dispatcherContext, 'tools')
                            ? { tools: dispatcherContext.tools }
                            : {}),
                        plugin,
                        contribution,
                        surface: 'agent',
                        invokedAtMs: lifetime.invokedAtMs,
                        signal,
                        services,
                        ui: createPluginInvocationPresentation({
                            currentSession: null,
                            signal,
                            isGenerationCurrent: params.isGenerationActive,
                        }),
                    });
                    const result = await invokeHookWithCancellation(
                        () => handler(readHookPayload(event), invocationContext),
                        signal,
                    );
                    if (!params.isGenerationActive()) {
                        throw new Error(`Plugin '${target.pluginId}' hook handler is no longer active`);
                    }
                    return result;
                } finally {
                    lifetime.complete();
                }
            },
        });
        const existing = handlersByHookId.get(declaration.on);
        if (existing) existing.push(resolved);
        else handlersByHookId.set(declaration.on, [resolved]);
    }

    return Object.freeze({
        handlersByHookId: new Map([...handlersByHookId.entries()].map(([hookId, handlers]) => [
            hookId,
            Object.freeze([...handlers].sort((left, right) => (
                left.priority - right.priority
                || left.pluginId.localeCompare(right.pluginId)
                || left.registrationIndex - right.registrationIndex
            ))),
        ])),
        diagnosticsByPluginId: Object.freeze({ ...diagnosticsByPluginId }),
    });
}
