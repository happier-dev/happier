import { Buffer } from 'node:buffer';

import type {
    PluginConnectedAccountBindingSummary,
    PluginConnectedAccountMaterialization,
    PluginConnectedAccountMaterializationRequest,
    PluginConnectedAccountsService,
    PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';
import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type {
    QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import type {
    PluginConnectedAccountBindingScope,
    PluginInvocationServicesSeed,
} from './types';
import type { HostCurrentSessionUiServices } from '@/agent/runtime/state/currentSessionUiTypes';
import { clonePluginPlainData } from '../../plainData';

export type StablePluginConnectedAccountsAuthorizedPurpose = Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
}>;

export type StablePluginConnectedAccountsOwner = Readonly<{
    getBinding(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            sessionId?: string;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountBindingSummary | null>;
    requestSelection(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            assertGenerationCurrent(): void;
            currentSession?: HostCurrentSessionUiServices;
            reason: string;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountBindingSummary>;
    materialize(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            sessionId?: string;
            request: PluginConnectedAccountMaterializationRequest;
            signal: AbortSignal;
        }>,
    ): Promise<PluginConnectedAccountMaterialization>;
    watch(
        input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
            sessionId?: string;
            listener(): Promise<void>;
        }>,
    ): Disposable;
}>;

export type StablePluginConnectedAccountsHost = Readonly<{
    bind(
        seed: PluginInvocationServicesSeed,
        scopes: readonly PluginConnectedAccountBindingScope[],
    ): PluginConnectedAccountsService;
    /** Synchronously disposes every watch owned by this executable registry generation. */
    retire(): void;
}>;

export type StablePluginConnectedAccountsHostOptions = Readonly<{
    registerForRedaction(seed: PluginInvocationServicesSeed, value: string): void;
}>;

function generationRetired(): PluginError {
    return new PluginError({
        code: 'plugin_final_generation_retired',
        message: 'Plugin generation is no longer current',
    });
}

function undeclaredPurpose(purpose: string): PluginError {
    return new PluginError({
        code: 'plugin_connected_account_purpose_undeclared',
        message: `Connected Accounts purpose '${purpose}' is not authorized for this invocation`,
    });
}

function operationDenied(purpose: string, operation: 'select' | 'use'): PluginError {
    return new PluginError({
        code: 'plugin_host_access_operation_denied',
        message: `Connected Accounts purpose '${purpose}' does not authorize '${operation}'`,
    });
}

function materializationKindDenied(
    purpose: string,
    kind: PluginConnectedAccountMaterializationRequest['kind'],
): PluginError {
    return new PluginError({
        code: 'plugin_host_access_operation_denied',
        message: `Connected Accounts purpose '${purpose}' does not authorize '${kind}' materialization`,
    });
}

function materializationOutOfScope(): PluginError {
    return new PluginError({
        code: 'plugin_connected_account_binding_out_of_scope',
        message: 'Connected Accounts owner returned materialization outside the request authorization',
    });
}

function assertCurrent(seed: PluginInvocationServicesSeed): void {
    if (seed.signal.aborted || !seed.isGenerationCurrent()) throw generationRetired();
}

function resolveScope(
    scopes: ReadonlyMap<string, PluginConnectedAccountBindingScope>,
    purpose: string,
    operation: 'select' | 'use',
): PluginConnectedAccountBindingScope {
    const scope = scopes.get(purpose);
    if (!scope) throw undeclaredPurpose(purpose);
    if (!scope.operations.includes(operation)) throw operationDenied(purpose, operation);
    return scope;
}

function authorizedPurpose(
    seed: PluginInvocationServicesSeed,
    scope: PluginConnectedAccountBindingScope,
): StablePluginConnectedAccountsAuthorizedPurpose {
    return Object.freeze({
        purpose: Object.freeze({
            consumer: Object.freeze({
                pluginId: seed.plugin.id,
                localId: seed.contribution.id,
            }),
            purpose: scope.purpose,
        }),
        serviceRefs: scope.serviceRefs,
    });
}

function assertAuthorizedSummary(
    scope: PluginConnectedAccountBindingScope,
    summary: PluginConnectedAccountBindingSummary,
): PluginConnectedAccountBindingSummary {
    const serviceAuthorized = scope.serviceRefs.some((service) => (
        service.pluginId === summary.service.pluginId
        && service.localId === summary.service.localId
    ));
    if (summary.purpose !== scope.purpose || !serviceAuthorized) {
        throw new PluginError({
            code: 'plugin_connected_account_binding_out_of_scope',
            message: 'Connected Accounts owner returned a binding outside the invocation authorization',
        });
    }
    return summary;
}

function combineSignals(
    invocationSignal: AbortSignal,
    operationSignal: AbortSignal | undefined,
): Readonly<{ signal: AbortSignal; dispose(): void }> {
    if (!operationSignal || operationSignal === invocationSignal) {
        return Object.freeze({ signal: invocationSignal, dispose() {} });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    invocationSignal.addEventListener('abort', abort, { once: true });
    operationSignal.addEventListener('abort', abort, { once: true });
    if (invocationSignal.aborted || operationSignal.aborted) controller.abort();
    return Object.freeze({
        signal: controller.signal,
        dispose() {
            invocationSignal.removeEventListener('abort', abort);
            operationSignal.removeEventListener('abort', abort);
        },
    });
}

function registerMaterializationForRedaction(
    materialization: PluginConnectedAccountMaterialization,
    seed: PluginInvocationServicesSeed,
    options: StablePluginConnectedAccountsHostOptions | undefined,
): void {
    if (!options) return;
    if (materialization.kind === 'httpHeaders') {
        for (const value of Object.values(materialization.headers)) {
            options.registerForRedaction(seed, value);
        }
        return;
    }
    if (materialization.kind === 'environment') {
        for (const value of Object.values(materialization.env)) {
            options.registerForRedaction(seed, value);
        }
        return;
    }
    for (const bytes of Object.values(materialization.files)) {
        if (bytes.byteLength === 0) continue;
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        options.registerForRedaction(seed, buffer.toString('base64'));
        options.registerForRedaction(seed, buffer.toString('base64url'));
        options.registerForRedaction(seed, buffer.toString('hex'));
        try {
            options.registerForRedaction(
                seed,
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
        } catch {
            // Opaque binary files have no exact UTF-8 string form to redact.
        }
    }
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactOwnKeys(
    value: Readonly<Record<string, unknown>>,
    keys: readonly string[],
): boolean {
    const expected = new Set(keys);
    const actual = Reflect.ownKeys(value);
    return actual.length === expected.size
        && actual.every((key) => typeof key === 'string' && expected.has(key));
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function snapshotMaterializationRequest(
    request: PluginConnectedAccountMaterializationRequest,
): PluginConnectedAccountMaterializationRequest {
    let snapshot: unknown;
    try {
        snapshot = clonePluginPlainData(request, {
            path: 'Connected Accounts materialization request',
            invalid: () => materializationOutOfScope(),
        });
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw materializationOutOfScope();
    }
    if (!isUnknownRecord(snapshot) || typeof snapshot.kind !== 'string') {
        throw materializationOutOfScope();
    }
    if (
        snapshot.kind === 'httpHeaders'
        && hasExactOwnKeys(snapshot, ['kind', 'origin', 'headerNames'])
        && typeof snapshot.origin === 'string'
        && isStringArray(snapshot.headerNames)
    ) {
        return snapshot as PluginConnectedAccountMaterializationRequest;
    }
    if (
        snapshot.kind === 'environment'
        && hasExactOwnKeys(snapshot, ['kind', 'keys'])
        && isStringArray(snapshot.keys)
    ) {
        return snapshot as PluginConnectedAccountMaterializationRequest;
    }
    if (
        snapshot.kind === 'files'
        && hasExactOwnKeys(snapshot, ['kind', 'fileIds'])
        && isStringArray(snapshot.fileIds)
    ) {
        return snapshot as PluginConnectedAccountMaterializationRequest;
    }
    throw materializationOutOfScope();
}

function snapshotMaterialization(
    request: PluginConnectedAccountMaterializationRequest,
    materialization: unknown,
): PluginConnectedAccountMaterialization {
    if (!isUnknownRecord(materialization) || materialization.kind !== request.kind) {
        throw materializationOutOfScope();
    }
    if (request.kind === 'httpHeaders') {
        if (!isUnknownRecord(materialization.headers)) throw materializationOutOfScope();
        const requestedNames = new Set(request.headerNames.map((name) => name.toLowerCase()));
        const headerEntries: Array<readonly [string, string]> = [];
        for (const [name, value] of Object.entries(materialization.headers)) {
            if (typeof value !== 'string' || !requestedNames.has(name.toLowerCase())) {
                throw materializationOutOfScope();
            }
            headerEntries.push([name, value]);
        }
        return Object.freeze({
            kind: 'httpHeaders',
            headers: Object.freeze(Object.fromEntries(headerEntries)),
        });
    }
    if (request.kind === 'environment') {
        if (!isUnknownRecord(materialization.env)) throw materializationOutOfScope();
        const requestedKeys = new Set(request.keys);
        const environmentEntries: Array<readonly [string, string]> = [];
        for (const [key, value] of Object.entries(materialization.env)) {
            if (typeof value !== 'string' || !requestedKeys.has(key)) {
                throw materializationOutOfScope();
            }
            environmentEntries.push([key, value]);
        }
        return Object.freeze({
            kind: 'environment',
            env: Object.freeze(Object.fromEntries(environmentEntries)),
        });
    }
    if (!isUnknownRecord(materialization.files)) throw materializationOutOfScope();
    const requestedFileIds = new Set(request.fileIds);
    const fileEntries: Array<readonly [string, Uint8Array]> = [];
    for (const [fileId, bytes] of Object.entries(materialization.files)) {
        if (!(bytes instanceof Uint8Array) || !requestedFileIds.has(fileId)) {
            throw materializationOutOfScope();
        }
        fileEntries.push([fileId, new Uint8Array(bytes)]);
    }
    return Object.freeze({
        kind: 'files',
        files: Object.freeze(Object.fromEntries(fileEntries)),
    });
}

export function createStablePluginConnectedAccountsHost(
    owner: StablePluginConnectedAccountsOwner,
    hostOptions?: StablePluginConnectedAccountsHostOptions,
): StablePluginConnectedAccountsHost {
    const activeWatchSubscriptions = new Set<Disposable>();
    return Object.freeze({
        retire() {
            for (const subscription of [...activeWatchSubscriptions]) subscription.dispose();
        },
        bind(seed, authorizedScopes): PluginConnectedAccountsService {
            const scopes = new Map(authorizedScopes.map((scope) => [scope.purpose, scope]));
            return Object.freeze<PluginConnectedAccountsService>({
                async getBinding(purpose, options = {}) {
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'use');
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const summary = await owner.getBinding({
                            ...authorizedPurpose(seed, scope),
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        return summary === null ? null : assertAuthorizedSummary(scope, summary);
                    } finally {
                        signals.dispose();
                    }
                },
                async requestSelection(input, options = {}) {
                    assertCurrent(seed);
                    const purpose = input.purpose;
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'select');
                    const reason = input.reason;
                    assertCurrent(seed);
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const summary = await owner.requestSelection({
                            ...authorizedPurpose(seed, scope),
                            assertGenerationCurrent: () => assertCurrent(seed),
                            ...(seed.currentSession ? { currentSession: seed.currentSession } : {}),
                            reason,
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        return assertAuthorizedSummary(scope, summary);
                    } finally {
                        signals.dispose();
                    }
                },
                async materialize(purpose, request, options = {}) {
                    assertCurrent(seed);
                    const requestSnapshot = snapshotMaterializationRequest(request);
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'use');
                    if (scope.materializationKinds?.includes(requestSnapshot.kind) !== true) {
                        throw materializationKindDenied(purpose, requestSnapshot.kind);
                    }
                    const signals = combineSignals(seed.signal, options.signal);
                    assertCurrent(seed);
                    try {
                        const result = await owner.materialize({
                            ...authorizedPurpose(seed, scope),
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                            request: requestSnapshot,
                            signal: signals.signal,
                        });
                        assertCurrent(seed);
                        const snapshot = snapshotMaterialization(requestSnapshot, result);
                        registerMaterializationForRedaction(snapshot, seed, hostOptions);
                        assertCurrent(seed);
                        return snapshot;
                    } finally {
                        signals.dispose();
                    }
                },
                watch(purpose, listener) {
                    assertCurrent(seed);
                    const scope = resolveScope(scopes, purpose, 'use');
                    let disposed = false;
                    let registrationComplete = false;
                    let scheduled = false;
                    let initialDeliveryPending = true;
                    let invalidationPending = false;
                    let deliveryWaiters: Array<() => void> = [];
                    let activeDeliveryWaiters: Array<() => void> = [];
                    const resolveDeliveryWaiters = (waiters: readonly (() => void)[]) => {
                        for (const resolve of waiters) resolve();
                    };
                    const startDelivery = () => {
                        if (
                            disposed
                            || !registrationComplete
                            || scheduled
                            || (!initialDeliveryPending && !invalidationPending)
                        ) return;
                        scheduled = true;
                        queueMicrotask(async () => {
                            const isInitialDelivery = initialDeliveryPending;
                            if (isInitialDelivery) {
                                initialDeliveryPending = false;
                            } else {
                                activeDeliveryWaiters = deliveryWaiters;
                                deliveryWaiters = [];
                                invalidationPending = false;
                            }
                            if (disposed) {
                                resolveDeliveryWaiters(activeDeliveryWaiters);
                                activeDeliveryWaiters = [];
                                scheduled = false;
                                return;
                            }
                            if (seed.signal.aborted || !seed.isGenerationCurrent()) {
                                subscription.dispose();
                                resolveDeliveryWaiters(activeDeliveryWaiters);
                                activeDeliveryWaiters = [];
                                scheduled = false;
                                return;
                            }
                            try {
                                const delivery = (listener as (event: Readonly<{ kind: 'resync' }>) => unknown)(
                                    Object.freeze({ kind: 'resync' }),
                                );
                                if (
                                    delivery
                                    && typeof delivery === 'object'
                                    && 'then' in delivery
                                    && typeof delivery.then === 'function'
                                ) {
                                    await delivery;
                                }
                            } catch {
                                // Plugin listener failures cannot break host invalidation delivery.
                            } finally {
                                resolveDeliveryWaiters(activeDeliveryWaiters);
                                activeDeliveryWaiters = [];
                                scheduled = false;
                                startDelivery();
                            }
                        });
                    };
                    const schedule = (): Promise<void> => {
                        if (disposed) return Promise.resolve();
                        invalidationPending = true;
                        const delivered = new Promise<void>((resolve) => {
                            deliveryWaiters.push(resolve);
                        });
                        startDelivery();
                        return delivered;
                    };
                    const ownerSubscription = owner.watch({
                        ...authorizedPurpose(seed, scope),
                        ...(seed.session ? { sessionId: seed.session.id } : {}),
                        listener: schedule,
                    });
                    const abort = () => subscription.dispose();
                    const subscription: Disposable = Object.freeze({
                        dispose() {
                            if (disposed) return;
                            disposed = true;
                            activeWatchSubscriptions.delete(subscription);
                            seed.signal.removeEventListener('abort', abort);
                            resolveDeliveryWaiters(deliveryWaiters);
                            deliveryWaiters = [];
                            resolveDeliveryWaiters(activeDeliveryWaiters);
                            activeDeliveryWaiters = [];
                            ownerSubscription.dispose();
                        },
                    });
                    activeWatchSubscriptions.add(subscription);
                    seed.signal.addEventListener('abort', abort, { once: true });
                    registrationComplete = true;
                    startDelivery();
                    if (seed.signal.aborted || !seed.isGenerationCurrent()) subscription.dispose();
                    return subscription;
                },
            });
        },
    });
}
