import { randomUUID } from 'node:crypto';

import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/runtime';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';

import type { ActivationTarget } from '../activation/targets';
import {
    clonePluginPlainData,
    PLUGIN_RUNTIME_JSON_VALUE_LIMITS,
} from '../../plainData';
import { createPluginInvocationUi } from '../../invocation/services/ui';
import type {
    CreatePluginInvocationServices,
    PluginInvocationServiceBinding,
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
    createOrdinaryServiceBinding(generation: string, id: string): PluginInvocationServiceBinding;
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
            limits: PLUGIN_RUNTIME_JSON_VALUE_LIMITS,
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

export function createTargetHookHandlerRegistry(params: Readonly<{
    generation: number;
    activationTargets: readonly ActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    isGenerationActive(): boolean;
    invocationServices?: TargetInvocationServiceOwner;
}>): ReadonlyMap<string, readonly ResolvedPluginHookHandler[]> {
    const handlersByHookId = new Map<string, ResolvedPluginHookHandler[]>();
    let registrationIndex = 0;

    for (const entry of params.targetRegistrations) {
        if (entry.registration.family !== 'hooks') continue;
        if (entry.generation !== String(params.generation)) {
            throw new Error(`Target hook '${entry.pluginId}/hooks/${entry.registration.localId}' was published for the wrong generation`);
        }
        const target = params.activationTargets.find((candidate) => candidate.pluginId === entry.pluginId);
        const declaration = target?.manifest.contributes.hooks.find((hook) => hook.id === entry.registration.localId);
        if (!target || !declaration) {
            throw new Error(`Target hook registration '${entry.pluginId}/hooks/${entry.registration.localId}' has no matching manifest hook`);
        }
        const daemonEntryPath = target.daemonEntryPath ?? target.devDaemonEntryPath;
        if (!daemonEntryPath) {
            throw new Error(`Target hook registration '${entry.pluginId}/hooks/${entry.registration.localId}' has no executable daemon entry`);
        }
        const registration: ResolvedActivatedHookRegistration = Object.freeze({
            provenance: target.provenance,
            source: target.source,
            pluginId: target.pluginId,
            manifestPath: target.manifestPath,
            manifestDigest: target.manifestDigest,
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
            manifestDigest: target.manifestDigest,
            daemonEntryPath,
            registration,
            handler: async (event, context) => {
                if (!params.isGenerationActive()) {
                    throw new Error(`Plugin '${target.pluginId}' hook handler is no longer active`);
                }
                const dispatcherContext = readTargetHookDispatcherContext(context);
                const signal = dispatcherContext.signal ?? new AbortController().signal;
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
                            isGenerationCurrent: params.isGenerationActive,
                        });
                        const serviceBinding = hostAccessRequests.length === 0
                            ? invocationServices.createOrdinaryServiceBinding(
                                entry.generation,
                                `${contribution.qualifiedId}:binding`,
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
                    signal,
                    services,
                    ui: createPluginInvocationUi({
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
            },
        });
        const existing = handlersByHookId.get(declaration.on);
        if (existing) existing.push(resolved);
        else handlersByHookId.set(declaration.on, [resolved]);
    }

    return new Map([...handlersByHookId.entries()].map(([hookId, handlers]) => [
        hookId,
        Object.freeze([...handlers].sort((left, right) => (
            left.priority - right.priority
            || left.pluginId.localeCompare(right.pluginId)
            || left.registrationIndex - right.registrationIndex
        ))),
    ]));
}
