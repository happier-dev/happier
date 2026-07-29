import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { type PluginMcpClient, type PluginMcpDiscoveredServer, type PluginMcpDiscoveryProviderRef, type PluginMcpServerRef, type PluginMcpService, type PluginMcpTool } from '@happier-dev/plugin-sdk/runtime';

import type {
    ResolvedMcpDiscoveryProviderContribution,
    ResolvedMcpServerContribution,
} from '@/plugins/projection/registry/types';

import type {
    PluginInvocationServicesSeed,
    PluginMcpAuthorization,
} from './types';

export const MAX_STABLE_PLUGIN_MCP_ITEMS = 100;

const MAX_STABLE_PLUGIN_MCP_INPUT_BYTES = 256 * 1024;
const MAX_STABLE_PLUGIN_MCP_RESULT_BYTES = 1024 * 1024;
const MAX_STABLE_PLUGIN_MCP_CURSOR_LENGTH = 512;
const MAX_STABLE_PLUGIN_MCP_TOOL_NAME_LENGTH = 256;
const MAX_STABLE_PLUGIN_MCP_JSON_DEPTH = 128;
const MAX_STABLE_PLUGIN_MCP_SCOPED_CURSORS = 100;

type McpRegistrationFamily = 'mcp.servers' | 'mcp.discoveryProviders';

export type StablePluginMcpServerRegistration = Readonly<{
    generation: string;
    qualifiedId: string;
    isCurrent(): boolean;
    listTools(
        request: Readonly<{ cursor?: string; limit?: number }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Readonly<{ items: readonly PluginMcpTool[]; nextCursor?: string }>>;
    callTool(
        request: Readonly<{ name: string; input: JsonValue }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<JsonValue>;
}>;

export type StablePluginMcpDiscoveryRegistration = Readonly<{
    generation: string;
    qualifiedId: string;
    isCurrent(): boolean;
    discover(
        query: Readonly<{ input?: JsonValue; cursor?: string; limit?: number }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Readonly<{ items: readonly PluginMcpDiscoveredServer[]; nextCursor?: string }>>;
}>;

export type StablePluginMcpFinalPolicyEffect =
    | Readonly<{
        seed: PluginInvocationServicesSeed;
        ref: PluginMcpServerRef;
        operation: 'list';
    }>
    | Readonly<{
        seed: PluginInvocationServicesSeed;
        ref: PluginMcpServerRef;
        operation: 'connect' | 'listTools' | 'callTools' | 'discover';
    }>;

export type StablePluginMcpFinalPolicyRevalidator = (
    effect: StablePluginMcpFinalPolicyEffect,
) => void | Promise<void>;

export type DeclaredTransportConnector = (params: Readonly<{
    declaration: ResolvedMcpServerContribution;
    ref: PluginMcpServerRef;
    sessionId?: string;
    elicitation: Readonly<{ mode: 'hostMediated'; sessionId: string } | { mode: 'reject' }>;
    seed: PluginInvocationServicesSeed;
    signal?: AbortSignal;
}>) => Promise<PluginMcpClient>;

export type StablePluginMcpHost = Readonly<{
    bind(
        seed: PluginInvocationServicesSeed,
        authorization?: PluginMcpAuthorization,
    ): PluginMcpService;
    dispose(): Promise<void>;
}>;

export type StablePluginMcpHostParams = Readonly<{
    generation: string;
    servers: readonly ResolvedMcpServerContribution[];
    discoveryProviders: readonly ResolvedMcpDiscoveryProviderContribution[];
    activateOnDemand(ref: PluginMcpServerRef, family: McpRegistrationFamily): Promise<void>;
    readServer(ref: PluginMcpServerRef): StablePluginMcpServerRegistration | null;
    readDiscoveryProvider(ref: PluginMcpDiscoveryProviderRef): StablePluginMcpDiscoveryRegistration | null;
    connectDeclaredTransport?: DeclaredTransportConnector;
    isDeclaredTransportAvailable?: (declaration: ResolvedMcpServerContribution) => boolean;
    revalidateFinalPolicy?: StablePluginMcpFinalPolicyRevalidator;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function qualifiedId(ref: PluginMcpServerRef): string {
    return `${ref.pluginId}/${ref.localId}`;
}

function declarationRef(declaration: ResolvedMcpServerContribution | ResolvedMcpDiscoveryProviderContribution): PluginMcpServerRef | null {
    if (typeof declaration.pluginId !== 'string' || declaration.pluginId.length === 0) return null;
    return Object.freeze({ pluginId: declaration.pluginId, localId: declaration.definition.id });
}

function declarationTitle(declaration: ResolvedMcpServerContribution): string {
    return typeof declaration.definition.title === 'string'
        ? declaration.definition.title
        : declaration.definition.title.fallback;
}

function validateLimit(limit: number | undefined): number {
    if (limit === undefined) return MAX_STABLE_PLUGIN_MCP_ITEMS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STABLE_PLUGIN_MCP_ITEMS) {
        fail('plugin_mcp_limit_invalid', `MCP limit must be between 1 and ${MAX_STABLE_PLUGIN_MCP_ITEMS}`);
    }
    return limit;
}

function validateCursor(cursor: string | undefined): void {
    if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_STABLE_PLUGIN_MCP_CURSOR_LENGTH)) {
        fail('plugin_mcp_cursor_invalid', 'MCP cursor is invalid');
    }
}

type ScopedCursorStore<T> = Readonly<{
    issue(value: T): string;
    read(cursor: string): T;
}>;

function createScopedCursorStore<T>(scope: string): ScopedCursorStore<T> {
    let nextId = 0;
    const entries = new Map<string, T>();
    return Object.freeze({
        issue(value: T): string {
            nextId += 1;
            const cursor = `mcp:${scope}:${nextId}`;
            if (entries.size >= MAX_STABLE_PLUGIN_MCP_SCOPED_CURSORS) {
                const oldest = entries.keys().next().value as string | undefined;
                if (oldest !== undefined) entries.delete(oldest);
            }
            entries.set(cursor, value);
            return cursor;
        },
        read(cursor: string): T {
            validateCursor(cursor);
            const value = entries.get(cursor);
            if (value === undefined) fail('plugin_mcp_cursor_invalid', 'MCP cursor is not valid for this operation');
            return value;
        },
    });
}

function clonePlainJson(value: unknown, code: string, maxBytes: number, overflowCode: string = code): JsonValue {
    const visiting = new Set<object>();
    const clone = (entry: unknown, depth: number): JsonValue => {
        if (depth > MAX_STABLE_PLUGIN_MCP_JSON_DEPTH) fail(code, 'MCP data exceeds the nesting limit');
        if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry;
        if (typeof entry === 'number') {
            if (!Number.isFinite(entry)) fail(code, 'MCP data must contain only finite JSON numbers');
            return entry;
        }
        if (typeof entry !== 'object') fail(code, 'MCP data must be strict JSON');
        if (visiting.has(entry)) fail(code, 'MCP data must not contain cycles');
        visiting.add(entry);
        try {
            if (Array.isArray(entry)) {
                const keys = Object.keys(entry);
                if (keys.length !== entry.length) fail(code, 'MCP arrays must be dense and contain no named properties');
                const result: JsonValue[] = [];
                for (let index = 0; index < entry.length; index += 1) {
                    const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
                    if (descriptor === undefined || !('value' in descriptor)) fail(code, 'MCP data must not contain accessors');
                    result.push(clone(descriptor.value, depth + 1));
                }
                return Object.freeze(result);
            }
            const prototype = Object.getPrototypeOf(entry);
            if (prototype !== Object.prototype && prototype !== null) fail(code, 'MCP data must contain only plain objects');
            const result: Record<string, JsonValue> = {};
            for (const key of Object.keys(entry)) {
                const descriptor = Object.getOwnPropertyDescriptor(entry, key);
                if (descriptor === undefined || !('value' in descriptor)) fail(code, 'MCP data must not contain accessors');
                Object.defineProperty(result, key, {
                    configurable: false,
                    enumerable: true,
                    writable: false,
                    value: clone(descriptor.value, depth + 1),
                });
            }
            return Object.freeze(result);
        } finally {
            visiting.delete(entry);
        }
    };
    const cloned = clone(value, 0);
    const bytes = new TextEncoder().encode(JSON.stringify(cloned)).byteLength;
    if (bytes > maxBytes) fail(overflowCode, `MCP data exceeds the ${maxBytes} byte limit`);
    return cloned;
}

function assertJsonBytes(value: JsonValue, maxBytes: number, code: string): void {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
        fail(code, `MCP data exceeds the ${maxBytes} byte limit`);
    }
}

function assertPeerCollectionWithinLimit(result: unknown, label: string): void {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        fail('plugin_mcp_result_invalid', `${label} must be an object`);
    }
    const prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) {
        fail('plugin_mcp_result_invalid', `${label} must be a plain object`);
    }
    const itemsDescriptor = Object.getOwnPropertyDescriptor(result, 'items');
    if (itemsDescriptor === undefined || !('value' in itemsDescriptor) || !Array.isArray(itemsDescriptor.value)) {
        fail('plugin_mcp_result_invalid', `${label} items must be an array without accessors`);
    }
    if (itemsDescriptor.value.length > MAX_STABLE_PLUGIN_MCP_ITEMS) {
        fail('plugin_mcp_result_limit_exceeded', `${label} exceeds the item limit`);
    }
}

function validateTools(result: unknown): Readonly<{ items: readonly PluginMcpTool[]; nextCursor?: string }> {
    assertPeerCollectionWithinLimit(result, 'MCP tool catalog');
    const cloned = clonePlainJson(
        result,
        'plugin_mcp_result_invalid',
        MAX_STABLE_PLUGIN_MCP_RESULT_BYTES,
        'plugin_mcp_result_limit_exceeded',
    );
    if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned)) {
        fail('plugin_mcp_result_invalid', 'MCP tool catalog must be an object');
    }
    const record = cloned as Readonly<Record<string, JsonValue>>;
    if (!Array.isArray(record.items)) fail('plugin_mcp_result_invalid', 'MCP tool catalog items must be an array');
    if (record.nextCursor !== undefined && typeof record.nextCursor !== 'string') {
        fail('plugin_mcp_result_invalid', 'MCP tool cursor must be a string');
    }
    validateCursor(record.nextCursor);
    const names = new Set<string>();
    const items = record.items.map((tool) => {
        if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) fail('plugin_mcp_result_invalid', 'MCP tool must be an object');
        const toolRecord = tool as Readonly<Record<string, JsonValue>>;
        if (typeof toolRecord.name !== 'string' || toolRecord.name.length === 0 || toolRecord.name.length > MAX_STABLE_PLUGIN_MCP_TOOL_NAME_LENGTH || names.has(toolRecord.name)) {
            fail('plugin_mcp_result_invalid', 'MCP tool names must be non-empty and unique');
        }
        names.add(toolRecord.name);
        if (toolRecord.description !== undefined && typeof toolRecord.description !== 'string') fail('plugin_mcp_result_invalid', 'MCP tool description must be a string');
        const inputSchema = clonePlainJson(toolRecord.inputSchema, 'plugin_mcp_result_invalid', MAX_STABLE_PLUGIN_MCP_RESULT_BYTES) as PluginMcpTool['inputSchema'];
        const outputSchema = toolRecord.outputSchema === undefined
            ? undefined
            : clonePlainJson(toolRecord.outputSchema, 'plugin_mcp_result_invalid', MAX_STABLE_PLUGIN_MCP_RESULT_BYTES) as PluginMcpTool['outputSchema'];
        return Object.freeze({
            name: toolRecord.name,
            ...(toolRecord.description === undefined ? {} : { description: toolRecord.description }),
            inputSchema,
            ...(outputSchema === undefined ? {} : { outputSchema }),
        });
    });
    const validated = Object.freeze({
        items: Object.freeze(items),
        ...(record.nextCursor === undefined ? {} : { nextCursor: record.nextCursor }),
    });
    assertJsonBytes(validated as JsonValue, MAX_STABLE_PLUGIN_MCP_RESULT_BYTES, 'plugin_mcp_result_limit_exceeded');
    return validated;
}

function validateActive(seed: PluginInvocationServicesSeed, hostDisposed: boolean, generation: string): void {
    if (hostDisposed || seed.generation !== generation || seed.signal.aborted || !seed.isGenerationCurrent()) {
        fail('plugin_mcp_generation_retired', 'Plugin generation is no longer current');
    }
}

function assertRegistrationCurrent(
    registration: Readonly<{ generation: string; qualifiedId: string; isCurrent(): boolean }>,
    generation: string,
    ref: PluginMcpServerRef,
): void {
    if (registration.generation !== generation || registration.qualifiedId !== qualifiedId(ref) || !registration.isCurrent()) {
        fail('plugin_mcp_registration_stale', 'MCP registration is no longer current');
    }
}

async function withCancellation<T>(
    operation: () => Promise<T>,
    signals: readonly (AbortSignal | undefined)[],
    onDetachedResolution?: (value: T) => void | Promise<void>,
    trackDetachedOperation?: (operation: Promise<void>) => void,
): Promise<T> {
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (activeSignals.some((signal) => signal.aborted)) fail('plugin_mcp_aborted', 'MCP operation was aborted');
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new PluginError({ code: 'plugin_mcp_aborted', message: 'MCP operation was aborted' }));
    activeSignals.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
    if (activeSignals.some((signal) => signal.aborted)) onAbort();
    const operationPromise = Promise.resolve().then(operation);
    let detached = false;
    if (onDetachedResolution !== undefined && trackDetachedOperation !== undefined) {
        trackDetachedOperation(operationPromise.then(async (value) => {
            if (detached) await onDetachedResolution(value);
        }, () => {}));
    }
    try {
        return await Promise.race([operationPromise, aborted]);
    } catch (error) {
        if (activeSignals.some((signal) => signal.aborted)) {
            detached = true;
        }
        throw error;
    } finally {
        activeSignals.forEach((signal) => signal.removeEventListener('abort', onAbort));
        if (!detached) void operationPromise.catch(() => {});
    }
}

async function invokePeer<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch {
        fail('plugin_mcp_peer_failed', 'MCP peer request failed');
    }
}

function assertSession(
    declaration: ResolvedMcpServerContribution,
    seed: PluginInvocationServicesSeed,
    sessionId: string | undefined,
    elicitation: Readonly<{ mode: 'hostMediated'; sessionId: string } | { mode: 'reject' }>,
): void {
    const boundSessionId = seed.session?.id;
    if (declaration.definition.sessionScope === 'session' && (
        boundSessionId === undefined || sessionId === undefined || sessionId !== boundSessionId
    )) fail('plugin_mcp_session_mismatch', 'Session-scoped MCP server must use the bound session');
    if (elicitation.mode === 'hostMediated' && (
        boundSessionId === undefined || elicitation.sessionId !== boundSessionId || (sessionId !== undefined && sessionId !== boundSessionId)
    )) fail('plugin_mcp_session_mismatch', 'MCP elicitation must use the bound session');
}

export function createStablePluginMcpHost(params: StablePluginMcpHostParams): StablePluginMcpHost {
    const serverDeclarations = new Map<string, ResolvedMcpServerContribution>();
    const discoveryDeclarations = new Map<string, ResolvedMcpDiscoveryProviderContribution>();
    for (const declaration of params.servers) {
        const ref = declarationRef(declaration);
        if (ref === null) continue;
        const key = qualifiedId(ref);
        if (serverDeclarations.has(key)) fail('plugin_mcp_declaration_duplicate', `Duplicate MCP server declaration: ${key}`);
        serverDeclarations.set(key, declaration);
    }
    for (const declaration of params.discoveryProviders) {
        const ref = declarationRef(declaration);
        if (ref === null) continue;
        const key = qualifiedId(ref);
        if (discoveryDeclarations.has(key)) fail('plugin_mcp_declaration_duplicate', `Duplicate MCP discovery declaration: ${key}`);
        discoveryDeclarations.set(key, declaration);
    }

    let disposed = false;
    let nextBindingId = 0;
    let nextClientId = 0;
    const clients = new Set<PluginMcpClient>();
    const clientDisposals = new Set<Promise<void>>();
    const detachedCleanups = new Set<Promise<void>>();
    const detachedCleanupFailures: unknown[] = [];
    let hostDisposePromise: Promise<void> | null = null;

    const trackDetachedCleanup = (cleanup: Promise<void>) => {
        const tracked = cleanup.catch((error: unknown) => {
            detachedCleanupFailures.push(error);
        }).finally(() => {
            detachedCleanups.delete(tracked);
        });
        detachedCleanups.add(tracked);
    };

    const bind = (
        seed: PluginInvocationServicesSeed,
        authorization?: PluginMcpAuthorization,
    ): PluginMcpService => {
        nextBindingId += 1;
        const bindingId = nextBindingId;
        const serverCursors = createScopedCursorStore<number>(`${bindingId}:servers`);
        const discoveryCursors = createScopedCursorStore<Readonly<{ provider: string; cursor: string }>>(`${bindingId}:discovery`);
        const isAuthorized = (
            ref: PluginMcpServerRef,
            operation: 'listTools' | 'callTools' | 'discover',
        ): boolean => authorization === undefined || authorization.some((scope) => (
            scope.operations.includes(operation)
            && scope.serverRefs.some((candidate) => (
                candidate.pluginId === ref.pluginId && candidate.localId === ref.localId
            ))
        ));
        const assertAuthorized = (
            ref: PluginMcpServerRef,
            operation: 'listTools' | 'callTools' | 'discover',
        ): void => {
            if (!isAuthorized(ref, operation)) {
                fail('plugin_mcp_access_denied', 'MCP server operation was not authorized for this invocation');
            }
        };
        const revalidateFinalPolicy = (effect: StablePluginMcpFinalPolicyEffect): void | Promise<void> => (
            params.revalidateFinalPolicy?.(effect)
        );
        return Object.freeze({
        async list(query: Readonly<{ cursor?: string; limit?: number; sessionId?: string; signal?: AbortSignal }> = {}) {
            validateActive(seed, disposed, params.generation);
            if (query.signal?.aborted) fail('plugin_mcp_aborted', 'MCP operation was aborted');
            const limit = validateLimit(query.limit);
            const offset = query.cursor === undefined ? 0 : serverCursors.read(query.cursor);
            if (query.sessionId !== undefined && query.sessionId !== seed.session?.id) {
                fail('plugin_mcp_session_mismatch', 'MCP server list must use the bound session');
            }
            const boundDeclarations = [...serverDeclarations.values()].filter((declaration) => (
                isAuthorized(declarationRef(declaration)!, 'listTools')
            )).sort((left, right) => {
                const leftRef = declarationRef(left)!;
                const rightRef = declarationRef(right)!;
                return qualifiedId(leftRef).localeCompare(qualifiedId(rightRef));
            });
            const declarations: ResolvedMcpServerContribution[] = [];
            for (const declaration of boundDeclarations) {
                const ref = declarationRef(declaration)!;
                try {
                    await withCancellation(
                        async () => await revalidateFinalPolicy(Object.freeze({ seed, ref, operation: 'list' })),
                        [seed.signal, query.signal],
                    );
                    declarations.push(declaration);
                } catch (error) {
                    if (seed.signal.aborted || query.signal?.aborted) throw error;
                    // Listing is a discovery surface: current-policy denial hides a
                    // resource instead of exposing it as an unavailable entry.
                }
            }
            const items = [];
            for (const declaration of declarations.slice(offset, offset + limit)) {
                const ref = declarationRef(declaration)!;
                let state: 'available' | 'unavailable' = 'unavailable';
                let code: string | undefined;
                if (declaration.definition.kind === 'static') {
                    state = params.connectDeclaredTransport !== undefined
                        && (params.isDeclaredTransportAvailable?.(declaration) ?? true)
                        ? 'available'
                        : 'unavailable';
                    code = state === 'unavailable' ? 'plugin_mcp_transport_unavailable' : undefined;
                } else {
                    await withCancellation(() => params.activateOnDemand(ref, 'mcp.servers'), [seed.signal, query.signal]);
                    const registration = params.readServer(ref);
                    if (registration !== null) {
                        try {
                            assertRegistrationCurrent(registration, params.generation, ref);
                            state = 'available';
                        } catch {
                            code = 'plugin_mcp_registration_stale';
                        }
                    } else code = 'plugin_mcp_server_unavailable';
                }
                items.push(Object.freeze({ ref, title: declarationTitle(declaration), state, ...(code === undefined ? {} : { code }) }));
            }
            validateActive(seed, disposed, params.generation);
            const nextOffset = offset + items.length;
            return Object.freeze({
                items: Object.freeze(items),
                ...(nextOffset < declarations.length ? { nextCursor: serverCursors.issue(nextOffset) } : {}),
            });
        },

        async connect(
            ref: PluginMcpServerRef,
            options: Readonly<{
                sessionId?: string;
                elicitation: Readonly<{ mode: 'hostMediated'; sessionId: string } | { mode: 'reject' }>;
                signal?: AbortSignal;
            }>,
        ) {
            validateActive(seed, disposed, params.generation);
            if (!isAuthorized(ref, 'listTools') && !isAuthorized(ref, 'callTools')) {
                fail('plugin_mcp_access_denied', 'MCP server was not authorized for this invocation');
            }
            const declaration = serverDeclarations.get(qualifiedId(ref));
            if (declaration === undefined) fail('plugin_mcp_server_undeclared', 'MCP server is not declared');
            const frozenRef = Object.freeze({ ...ref });
            const elicitation = options.elicitation;
            assertSession(declaration, seed, options.sessionId, elicitation);
            let runtimeClient: PluginMcpClient;
            let registration: StablePluginMcpServerRegistration | null = null;
            if (declaration.definition.kind === 'static') {
                if (
                    params.connectDeclaredTransport === undefined
                    || params.isDeclaredTransportAvailable?.(declaration) === false
                ) fail('plugin_mcp_transport_unavailable', 'Declared MCP transport is unavailable');
                runtimeClient = await withCancellation(async () => {
                    await revalidateFinalPolicy(Object.freeze({ seed, operation: 'connect', ref: frozenRef }));
                    return params.connectDeclaredTransport!({
                    declaration, ref: frozenRef,
                    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                    elicitation, seed,
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                    });
                }, [seed.signal, options.signal], (detachedClient) => {
                    return detachedClient.dispose();
                }, trackDetachedCleanup);
            } else {
                await withCancellation(async () => {
                    await revalidateFinalPolicy(Object.freeze({ seed, operation: 'connect', ref: frozenRef }));
                    await params.activateOnDemand(ref, 'mcp.servers');
                }, [seed.signal, options.signal]);
                await withCancellation(
                    async () => await revalidateFinalPolicy(Object.freeze({ seed, operation: 'connect', ref: frozenRef })),
                    [seed.signal, options.signal],
                );
                registration = params.readServer(ref);
                if (registration === null) fail('plugin_mcp_server_unavailable', 'MCP server did not register after activation');
                assertRegistrationCurrent(registration, params.generation, ref);
                const selected = registration;
                runtimeClient = Object.freeze({
                    listTools: (request: Readonly<{ cursor?: string; limit?: number; signal?: AbortSignal }> = {}) => selected.listTools(request, seed, request.signal === undefined ? undefined : { signal: request.signal }),
                    callTool: (name: string, input: JsonValue, callOptions?: Readonly<{ signal?: AbortSignal }>) => selected.callTool({ name, input }, seed, callOptions),
                    dispose: async () => {},
                } satisfies PluginMcpClient);
            }

            let clientDisposed = false;
            let clientDisposePromise: Promise<void> | null = null;
            let runtimeDisposePromise: Promise<void> | null = null;
            let disposeOnInvocationAbort: (() => void) | null = null;
            nextClientId += 1;
            const toolCursors = createScopedCursorStore<string>(`${bindingId}:tools:${nextClientId}`);
            const disposeRuntime = () => {
                runtimeDisposePromise ??= Promise.resolve().then(() => runtimeClient.dispose());
                return runtimeDisposePromise;
            };
            const client: PluginMcpClient = Object.freeze({
                async listTools(request: Readonly<{ cursor?: string; limit?: number; signal?: AbortSignal }> = {}) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const peerCursor = request.cursor === undefined ? undefined : toolCursors.read(request.cursor);
                    validateLimit(request.limit);
                    const result = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.listTools({
                        ...(peerCursor === undefined ? {} : { cursor: peerCursor }),
                        ...(request.limit === undefined ? {} : { limit: request.limit }),
                        ...(request.signal === undefined ? {} : { signal: request.signal }),
                        }));
                    }, [seed.signal, request.signal]);
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const validated = validateTools(result);
                    return Object.freeze({
                        items: validated.items,
                        ...(validated.nextCursor === undefined ? {} : { nextCursor: toolCursors.issue(validated.nextCursor) }),
                    });
                },
                async callTool(name: string, input: JsonValue, callOptions: Readonly<{ signal?: AbortSignal }> = {}) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'callTools');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_STABLE_PLUGIN_MCP_TOOL_NAME_LENGTH) {
                        fail('plugin_mcp_tool_name_invalid', 'MCP tool name is invalid');
                    }
                    const boundedInput = clonePlainJson(input, 'plugin_mcp_input_invalid', MAX_STABLE_PLUGIN_MCP_INPUT_BYTES);
                    const result = await withCancellation(
                        async () => {
                            await revalidateFinalPolicy(Object.freeze({ seed, operation: 'callTools', ref: frozenRef }));
                            return invokePeer(() => runtimeClient.callTool(name, boundedInput, callOptions));
                        },
                        [seed.signal, callOptions.signal],
                    );
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    return clonePlainJson(result, 'plugin_mcp_result_invalid', MAX_STABLE_PLUGIN_MCP_RESULT_BYTES);
                },
                dispose() {
                    if (clientDisposePromise !== null) return clientDisposePromise;
                    clientDisposed = true;
                    if (disposeOnInvocationAbort !== null) {
                        seed.signal.removeEventListener('abort', disposeOnInvocationAbort);
                        disposeOnInvocationAbort = null;
                    }
                    clients.delete(client);
                    const disposal = disposeRuntime();
                    clientDisposePromise = disposal;
                    clientDisposals.add(disposal);
                    void disposal.then(
                        () => { clientDisposals.delete(disposal); },
                        () => {},
                    );
                    return disposal;
                },
            });
            clients.add(client);
            disposeOnInvocationAbort = () => {
                void Promise.resolve(client.dispose()).catch(() => {});
            };
            if (seed.signal.aborted) disposeOnInvocationAbort();
            else seed.signal.addEventListener('abort', disposeOnInvocationAbort, { once: true });
            try {
                validateActive(seed, disposed, params.generation);
            } catch (error) {
                await Promise.allSettled([client.dispose()]);
                throw error;
            }
            return client;
        },

        async discover(
            provider: PluginMcpDiscoveryProviderRef,
            query: Readonly<{ input?: JsonValue; cursor?: string; limit?: number }> = {},
            options: Readonly<{ signal?: AbortSignal }> = {},
        ) {
            validateActive(seed, disposed, params.generation);
            assertAuthorized(provider, 'discover');
            const providerKey = qualifiedId(provider);
            const cursorState = query.cursor === undefined ? undefined : discoveryCursors.read(query.cursor);
            if (cursorState !== undefined && cursorState.provider !== providerKey) {
                fail('plugin_mcp_cursor_invalid', 'MCP discovery cursor belongs to a different provider');
            }
            validateLimit(query.limit);
            const ref = Object.freeze({ ...provider });
            if (!discoveryDeclarations.has(qualifiedId(ref))) fail('plugin_mcp_discovery_provider_undeclared', 'MCP discovery provider is not declared');
            const boundedInput = query.input === undefined
                ? undefined
                : clonePlainJson(query.input, 'plugin_mcp_input_invalid', MAX_STABLE_PLUGIN_MCP_INPUT_BYTES);
            await withCancellation(async () => {
                await params.activateOnDemand(ref, 'mcp.discoveryProviders');
                await revalidateFinalPolicy(Object.freeze({ seed, operation: 'discover', ref }));
            }, [seed.signal, options.signal]);
            const registration = params.readDiscoveryProvider(ref);
            if (registration === null) fail('plugin_mcp_discovery_provider_unavailable', 'MCP discovery provider did not register after activation');
            assertRegistrationCurrent(registration, params.generation, ref);
            const result = await withCancellation(async () => {
                await revalidateFinalPolicy(Object.freeze({ seed, operation: 'discover', ref }));
                return invokePeer(() => registration.discover({
                ...(boundedInput === undefined ? {} : { input: boundedInput }),
                ...(cursorState === undefined ? {} : { cursor: cursorState.cursor }),
                ...(query.limit === undefined ? {} : { limit: query.limit }),
                }, seed, options));
            }, [seed.signal, options.signal]);
            assertRegistrationCurrent(registration, params.generation, ref);
            assertPeerCollectionWithinLimit(result, 'MCP discovery result');
            const clonedResult = clonePlainJson(
                result,
                'plugin_mcp_result_invalid',
                MAX_STABLE_PLUGIN_MCP_RESULT_BYTES,
                'plugin_mcp_result_limit_exceeded',
            );
            if (typeof clonedResult !== 'object' || clonedResult === null || Array.isArray(clonedResult)) {
                fail('plugin_mcp_result_invalid', 'MCP discovery result must be an object');
            }
            const resultRecord = clonedResult as Readonly<Record<string, JsonValue>>;
            if (!Array.isArray(resultRecord.items)) fail('plugin_mcp_result_invalid', 'MCP discovery items must be an array');
            if (resultRecord.nextCursor !== undefined && typeof resultRecord.nextCursor !== 'string') {
                fail('plugin_mcp_result_invalid', 'MCP discovery cursor must be a string');
            }
            validateCursor(resultRecord.nextCursor);
            const items = resultRecord.items.map((item) => {
                if (typeof item !== 'object' || item === null || Array.isArray(item)) {
                    fail('plugin_mcp_result_invalid', 'MCP discovery result is invalid');
                }
                const record = item as Readonly<Record<string, JsonValue>>;
                if (typeof record.discoveryId !== 'string' || record.discoveryId.length === 0 || typeof record.title !== 'string' || record.title.length === 0) {
                    fail('plugin_mcp_result_invalid', 'MCP discovery result is invalid');
                }
                if (record.description !== undefined && typeof record.description !== 'string') {
                    fail('plugin_mcp_result_invalid', 'MCP discovery description must be a string');
                }
                return Object.freeze({
                    provider: ref,
                    discoveryId: record.discoveryId,
                    title: record.title,
                    ...(record.description === undefined ? {} : { description: record.description }),
                    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
                });
            });
            const response = Object.freeze({
                items: Object.freeze(items),
                ...(resultRecord.nextCursor === undefined ? {} : {
                    nextCursor: discoveryCursors.issue(Object.freeze({ provider: providerKey, cursor: resultRecord.nextCursor })),
                }),
            });
            assertJsonBytes(response as JsonValue, MAX_STABLE_PLUGIN_MCP_RESULT_BYTES, 'plugin_mcp_result_limit_exceeded');
            validateActive(seed, disposed, params.generation);
            return response;
        },
        });
    };

    return Object.freeze({
        bind,
        dispose() {
            if (hostDisposePromise !== null) return hostDisposePromise;
            disposed = true;
            const activeClients = [...clients];
            clients.clear();
            hostDisposePromise = (async () => {
                const cleanupOperations = new Set<Promise<void>>([
                    ...activeClients.map((client) => Promise.resolve(client.dispose())),
                    ...clientDisposals,
                    ...detachedCleanups,
                ]);
                const cleanupResults = await Promise.allSettled(cleanupOperations);
                clientDisposals.clear();
                const failures = [
                    ...detachedCleanupFailures,
                    ...cleanupResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
                ];
                if (failures.length > 0) throw new AggregateError(failures, 'MCP cleanup failed');
            })();
            return hostDisposePromise;
        },
    });
}
