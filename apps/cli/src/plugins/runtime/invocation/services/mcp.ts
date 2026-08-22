import {
    AnnotationsSchema,
    AudioContentSchema,
    BlobResourceContentsSchema,
    EmbeddedResourceSchema,
    GetPromptResultSchema,
    IconSchema,
    ImageContentSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    PromptArgumentSchema,
    PromptMessageSchema,
    PromptSchema,
    ReadResourceResultSchema,
    ResourceLinkSchema,
    ResourceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationParamsSchema,
    TextContentSchema,
    TextResourceContentsSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PluginError, type Disposable, type JsonValue } from '@happier-dev/plugin-sdk';
import {
    type McpClient as PluginMcpClient,
    type McpDiscoveredServer as PluginMcpDiscoveredServer,
    type McpDiscoverySourceRef as PluginMcpDiscoverySourceRef,
    type McpGetPromptResult as PluginMcpGetPromptResult,
    type McpPromptPage as PluginMcpPromptPage,
    type McpReadResourceResult as PluginMcpReadResourceResult,
    type McpResourcePage as PluginMcpResourcePage,
    type McpResourceTemplatePage as PluginMcpResourceTemplatePage,
    type McpResourceUpdatedEvent as PluginMcpResourceUpdatedEvent,
    type McpServerRef as PluginMcpServerRef,
    type McpService as PluginMcpService,
    type McpTool as PluginMcpTool,
} from '@happier-dev/plugin-sdk/mcp';
import {
    cloneStrictPluginJsonValue,
    measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import type {
    ResolvedMcpDiscoverySourceContribution,
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
const MAX_STABLE_PLUGIN_MCP_SCOPED_CURSORS = 100;

type McpRegistrationFamily = 'mcp.servers' | 'mcp.discoverySources';

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
    listResources(
        request: Readonly<{ cursor?: string }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginMcpResourcePage>;
    listResourceTemplates(
        request: Readonly<{ cursor?: string }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginMcpResourceTemplatePage>;
    readResource(
        request: Readonly<{ uri: string }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginMcpReadResourceResult>;
    subscribeResource(
        request: Readonly<{ uri: string }>,
        listener: (event: PluginMcpResourceUpdatedEvent) => void | Promise<void>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Disposable>;
    listPrompts(
        request: Readonly<{ cursor?: string }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginMcpPromptPage>;
    getPrompt(
        request: Readonly<{ name: string; args?: Readonly<Record<string, string>> }>,
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginMcpGetPromptResult>;
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
    discoverySources: readonly ResolvedMcpDiscoverySourceContribution[];
    activateOnDemand(ref: PluginMcpServerRef, family: McpRegistrationFamily): Promise<void>;
    readServer(ref: PluginMcpServerRef): StablePluginMcpServerRegistration | null;
    readDiscoverySource(ref: PluginMcpDiscoverySourceRef): StablePluginMcpDiscoveryRegistration | null;
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

function declarationRef(declaration: ResolvedMcpServerContribution | ResolvedMcpDiscoverySourceContribution): PluginMcpServerRef | null {
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
    let cloned: JsonValue;
    try {
        cloned = cloneStrictPluginJsonValue(value, 'MCP data') as JsonValue;
    } catch (error) {
        fail(code, error instanceof Error ? error.message : 'MCP data must be strict JSON');
    }
    if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(cloned, 'MCP data', maxBytes) > maxBytes) {
        fail(overflowCode, `MCP data exceeds the ${maxBytes} byte limit`);
    }
    return cloned;
}

function assertJsonBytes(value: JsonValue, maxBytes: number, code: string): void {
    if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'MCP data', maxBytes) > maxBytes) {
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

const publicMcpStringSchema = ResourceSchema.shape.uri;
const publicMcpUnknownSchema = TextContentSchema.shape._meta.unwrap().valueType;
// The curated DTO intentionally exposes annotation hints as plain JSON primitives,
// while the MCP wire schema constrains their values further.
const publicMcpFiniteNumberSchema = publicMcpUnknownSchema.refine(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
);
const publicMcpAnnotationsSchema = AnnotationsSchema.extend({
    priority: publicMcpFiniteNumberSchema.optional(),
    lastModified: publicMcpStringSchema.optional(),
}).strict();
const publicMcpIconSchema = IconSchema.strict();
const publicMcpResourceSchema = ResourceSchema.extend({
    annotations: publicMcpAnnotationsSchema.optional(),
    icons: publicMcpIconSchema.array().optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpResourceTemplateSchema = ResourceTemplateSchema.extend({
    annotations: publicMcpAnnotationsSchema.optional(),
    icons: publicMcpIconSchema.array().optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpTextResourceContentsSchema = TextResourceContentsSchema.extend({
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpBlobResourceContentsSchema = BlobResourceContentsSchema.extend({
    blob: publicMcpStringSchema,
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpResourceContentsSchema = publicMcpTextResourceContentsSchema.or(publicMcpBlobResourceContentsSchema);
const publicMcpResourcePageSchema = ListResourcesResultSchema.omit({ resources: true }).extend({
    items: publicMcpResourceSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpResourceTemplatePageSchema = ListResourceTemplatesResultSchema.omit({ resourceTemplates: true }).extend({
    items: publicMcpResourceTemplateSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpReadResourceResultSchema = ReadResourceResultSchema.extend({
    contents: publicMcpResourceContentsSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpPromptSchema = PromptSchema.extend({
    arguments: PromptArgumentSchema.strict().array().optional(),
    icons: publicMcpIconSchema.array().optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpPromptPageSchema = ListPromptsResultSchema.omit({ prompts: true }).extend({
    items: publicMcpPromptSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpPromptContentSchema = TextContentSchema.extend({
    annotations: publicMcpAnnotationsSchema.optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict()
    .or(ImageContentSchema.extend({
        data: publicMcpStringSchema,
        annotations: publicMcpAnnotationsSchema.optional(),
        _meta: publicMcpUnknownSchema.optional(),
    }).strict())
    .or(AudioContentSchema.extend({
        data: publicMcpStringSchema,
        annotations: publicMcpAnnotationsSchema.optional(),
        _meta: publicMcpUnknownSchema.optional(),
    }).strict())
    .or(EmbeddedResourceSchema.extend({
        resource: publicMcpResourceContentsSchema,
        annotations: publicMcpAnnotationsSchema.optional(),
        _meta: publicMcpUnknownSchema.optional(),
    }).strict())
    .or(publicMcpResourceSchema.extend({ type: ResourceLinkSchema.shape.type }).strict());
const publicMcpGetPromptResultSchema = GetPromptResultSchema.extend({
    messages: PromptMessageSchema.extend({ content: publicMcpPromptContentSchema }).strict().array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpResourceUpdatedEventSchema = ResourceUpdatedNotificationParamsSchema.omit({ _meta: true }).strict();

type PublicMcpSchema = Readonly<{
    safeParse(value: unknown): Readonly<{ success: boolean }>;
}>;

function validatePublicMcpDto<T>(
    result: unknown,
    label: string,
    schema: PublicMcpSchema,
    hasCursor = false,
): T {
    const cloned = clonePlainJson(
        result,
        'plugin_mcp_result_invalid',
        MAX_STABLE_PLUGIN_MCP_RESULT_BYTES,
        'plugin_mcp_result_limit_exceeded',
    );
    if (!schema.safeParse(cloned).success) {
        fail('plugin_mcp_result_invalid', `${label} does not match the public MCP contract`);
    }
    if (hasCursor) {
        const record = cloned as Readonly<Record<string, JsonValue>>;
        validateCursor(typeof record.nextCursor === 'string' ? record.nextCursor : undefined);
    }
    return cloned as unknown as T;
}

function validateResourcePage(result: unknown): PluginMcpResourcePage {
    return validatePublicMcpDto(result, 'MCP resource page', publicMcpResourcePageSchema, true);
}

function validateResourceTemplatePage(result: unknown): PluginMcpResourceTemplatePage {
    return validatePublicMcpDto(result, 'MCP resource template page', publicMcpResourceTemplatePageSchema, true);
}

function validateReadResourceResult(result: unknown): PluginMcpReadResourceResult {
    return validatePublicMcpDto(result, 'MCP resource result', publicMcpReadResourceResultSchema);
}

function validatePromptPage(result: unknown): PluginMcpPromptPage {
    return validatePublicMcpDto(result, 'MCP prompt page', publicMcpPromptPageSchema, true);
}

function validateGetPromptResult(result: unknown): PluginMcpGetPromptResult {
    return validatePublicMcpDto(result, 'MCP prompt result', publicMcpGetPromptResultSchema);
}

function validateResourceUpdatedEvent(event: unknown): PluginMcpResourceUpdatedEvent {
    return validatePublicMcpDto(event, 'MCP resource update', publicMcpResourceUpdatedEventSchema);
}

function validateNonEmptyText(value: string, label: string): void {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STABLE_PLUGIN_MCP_CURSOR_LENGTH * 16) {
        fail('plugin_mcp_input_invalid', `${label} is invalid`);
    }
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
    } catch (error) {
        if (typeof error === 'object' && error !== null) {
            const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
            if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'number' && Number.isSafeInteger(descriptor.value)) {
                const mcpCode = descriptor.value;
                throw new PluginError({
                    code: mcpCode === -32601 ? 'plugin_mcp_method_not_found' : 'plugin_mcp_peer_error',
                    message: 'MCP peer request failed',
                    details: { mcpCode },
                });
            }
        }
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
    const discoverySourceDeclarations = new Map<string, ResolvedMcpDiscoverySourceContribution>();
    for (const declaration of params.servers) {
        const ref = declarationRef(declaration);
        if (ref === null) continue;
        const key = qualifiedId(ref);
        if (serverDeclarations.has(key)) fail('plugin_mcp_declaration_duplicate', `Duplicate MCP server declaration: ${key}`);
        serverDeclarations.set(key, declaration);
    }
    for (const declaration of params.discoverySources) {
        const ref = declarationRef(declaration);
        if (ref === null) continue;
        const key = qualifiedId(ref);
        if (discoverySourceDeclarations.has(key)) fail('plugin_mcp_declaration_duplicate', `Duplicate MCP discovery declaration: ${key}`);
        discoverySourceDeclarations.set(key, declaration);
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
        const discoveryCursors = createScopedCursorStore<Readonly<{ source: string; cursor: string }>>(`${bindingId}:discovery`);
        const isAuthorized = (
            ref: PluginMcpServerRef | PluginMcpDiscoverySourceRef,
            operation: 'listTools' | 'callTools' | 'discover',
        ): boolean => authorization === undefined || authorization.some((scope) => {
            const refs = operation === 'discover'
                ? scope.discoverySourceRefs
                : scope.serverRefs;
            return scope.operations.includes(operation)
            && refs.some((candidate) => (
                candidate.pluginId === ref.pluginId && candidate.localId === ref.localId
            ));
        });
        const assertAuthorized = (
            ref: PluginMcpServerRef | PluginMcpDiscoverySourceRef,
            operation: 'listTools' | 'callTools' | 'discover',
        ): void => {
            if (!isAuthorized(ref, operation)) {
                fail('plugin_mcp_access_denied', 'MCP operation was not authorized for this invocation');
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
                    listResources: (request: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) => selected.listResources(request, seed, request.signal === undefined ? undefined : { signal: request.signal }),
                    listResourceTemplates: (request: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) => selected.listResourceTemplates(request, seed, request.signal === undefined ? undefined : { signal: request.signal }),
                    readResource: (uri: string, readOptions?: Readonly<{ signal?: AbortSignal }>) => selected.readResource({ uri }, seed, readOptions),
                    subscribeResource: (
                        uri: string,
                        listener: (event: PluginMcpResourceUpdatedEvent) => void | Promise<void>,
                        subscribeOptions?: Readonly<{ signal?: AbortSignal }>,
                    ) => selected.subscribeResource({ uri }, listener, seed, subscribeOptions),
                    listPrompts: (request: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) => selected.listPrompts(request, seed, request.signal === undefined ? undefined : { signal: request.signal }),
                    getPrompt: (name: string, args?: Readonly<Record<string, string>>, promptOptions?: Readonly<{ signal?: AbortSignal }>) => selected.getPrompt({ name, ...(args === undefined ? {} : { args }) }, seed, promptOptions),
                    dispose: async () => {},
                } satisfies PluginMcpClient);
            }

            let clientDisposed = false;
            let clientDisposePromise: Promise<void> | null = null;
            let runtimeDisposePromise: Promise<void> | null = null;
            let disposeOnInvocationAbort: (() => void) | null = null;
            nextClientId += 1;
            const toolCursors = createScopedCursorStore<string>(`${bindingId}:tools:${nextClientId}`);
            const resourceCursors = createScopedCursorStore<string>(`${bindingId}:resources:${nextClientId}`);
            const resourceTemplateCursors = createScopedCursorStore<string>(`${bindingId}:resourceTemplates:${nextClientId}`);
            const promptCursors = createScopedCursorStore<string>(`${bindingId}:prompts:${nextClientId}`);
            const subscriptions = new Set<Disposable>();
            const disposeRuntime = () => {
                runtimeDisposePromise ??= (async () => {
                    const activeSubscriptions = [...subscriptions];
                    subscriptions.clear();
                    const results = await Promise.allSettled([
                        ...activeSubscriptions.map((subscription) => Promise.resolve().then(() => subscription.dispose())),
                        Promise.resolve().then(() => runtimeClient.dispose()),
                    ]);
                    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 0) throw new AggregateError(failures, 'MCP client cleanup failed');
                })();
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
                async listResources(request: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const peerCursor = request.cursor === undefined ? undefined : resourceCursors.read(request.cursor);
                    const result = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.listResources({
                            ...(peerCursor === undefined ? {} : { cursor: peerCursor }),
                            ...(request.signal === undefined ? {} : { signal: request.signal }),
                        }));
                    }, [seed.signal, request.signal]);
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const validated = validateResourcePage(result);
                    return Object.freeze({
                        items: validated.items,
                        ...(validated.nextCursor === undefined ? {} : { nextCursor: resourceCursors.issue(validated.nextCursor) }),
                        ...(validated._meta === undefined ? {} : { _meta: validated._meta }),
                    });
                },
                async listResourceTemplates(request: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const peerCursor = request.cursor === undefined ? undefined : resourceTemplateCursors.read(request.cursor);
                    const result = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.listResourceTemplates({
                            ...(peerCursor === undefined ? {} : { cursor: peerCursor }),
                            ...(request.signal === undefined ? {} : { signal: request.signal }),
                        }));
                    }, [seed.signal, request.signal]);
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const validated = validateResourceTemplatePage(result);
                    return Object.freeze({
                        items: validated.items,
                        ...(validated.nextCursor === undefined ? {} : { nextCursor: resourceTemplateCursors.issue(validated.nextCursor) }),
                        ...(validated._meta === undefined ? {} : { _meta: validated._meta }),
                    });
                },
                async readResource(uri: string, readOptions: Readonly<{ signal?: AbortSignal }> = {}) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateNonEmptyText(uri, 'MCP resource URI');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const result = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.readResource(uri, readOptions));
                    }, [seed.signal, readOptions.signal]);
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const validated = validateReadResourceResult(result);
                    return Object.freeze({
                        contents: validated.contents,
                        ...(validated._meta === undefined ? {} : { _meta: validated._meta }),
                    });
                },
                async subscribeResource(
                    uri: string,
                    listener: (event: PluginMcpResourceUpdatedEvent) => void | Promise<void>,
                    subscribeOptions: Readonly<{ signal?: AbortSignal }> = {},
                ) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateNonEmptyText(uri, 'MCP resource URI');
                    if (typeof listener !== 'function') fail('plugin_mcp_input_invalid', 'MCP resource listener is invalid');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    let disposeStaleSubscription: (() => Promise<void>) | null = null;
                    let retiredBeforeSubscriptionAvailable = false;
                    let retirementError: unknown;
                    let subscriptionRetired = false;
                    let listenerChain = Promise.resolve();
                    const serializedListener = (event: PluginMcpResourceUpdatedEvent) => {
                        listenerChain = listenerChain.then(async () => {
                            if (subscriptionRetired) return;
                            try {
                                validateActive(seed, disposed, params.generation);
                                if (registration !== null) {
                                    assertRegistrationCurrent(registration, params.generation, ref);
                                }
                                await withCancellation(async () => {
                                    await revalidateFinalPolicy(Object.freeze({
                                        seed,
                                        operation: 'listTools',
                                        ref: frozenRef,
                                    }));
                                }, [seed.signal, subscribeOptions.signal]);
                            } catch (error) {
                                subscriptionRetired = true;
                                if (disposeStaleSubscription === null) {
                                    retiredBeforeSubscriptionAvailable = true;
                                    retirementError = error;
                                } else {
                                    await disposeStaleSubscription();
                                }
                                throw error;
                            }
                            await listener(validateResourceUpdatedEvent(event));
                        }).catch(() => {
                            process.emitWarning('MCP resource subscription listener failed', {
                                code: 'HAPPIER_MCP_RESOURCE_LISTENER_FAILED',
                            });
                        });
                        return listenerChain;
                    };
                    const runtimeSubscription = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.subscribeResource(uri, serializedListener, subscribeOptions));
                    }, [seed.signal, subscribeOptions.signal], (detachedSubscription) => {
                        return Promise.resolve(detachedSubscription.dispose());
                    }, trackDetachedCleanup);
                    let subscriptionDisposePromise: Promise<void> | null = null;
                    let disposeOnCallerAbort: (() => void) | null = null;
                    const subscription: Disposable = Object.freeze({
                        dispose() {
                            if (subscriptionDisposePromise !== null) return subscriptionDisposePromise;
                            if (disposeOnCallerAbort !== null && subscribeOptions.signal !== undefined) {
                                subscribeOptions.signal.removeEventListener('abort', disposeOnCallerAbort);
                                disposeOnCallerAbort = null;
                            }
                            subscriptions.delete(subscription);
                            subscriptionDisposePromise = Promise.resolve().then(() => runtimeSubscription.dispose());
                            return subscriptionDisposePromise;
                        },
                    });
                    disposeStaleSubscription = async () => {
                        await subscription.dispose();
                    };
                    if (retiredBeforeSubscriptionAvailable) {
                        await subscription.dispose();
                        throw retirementError;
                    }
                    subscriptions.add(subscription);
                    if (subscribeOptions.signal !== undefined) {
                        disposeOnCallerAbort = () => {
                            void Promise.resolve(subscription.dispose()).catch(() => {});
                        };
                        if (subscribeOptions.signal.aborted) {
                            await subscription.dispose();
                            fail('plugin_mcp_aborted', 'MCP operation was aborted');
                        }
                        subscribeOptions.signal.addEventListener('abort', disposeOnCallerAbort, { once: true });
                    }
                    try {
                        validateActive(seed, disposed, params.generation);
                        if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    } catch (error) {
                        await subscription.dispose();
                        throw error;
                    }
                    return subscription;
                },
                async listPrompts(request: Readonly<{ cursor?: string; signal?: AbortSignal }> = {}) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const peerCursor = request.cursor === undefined ? undefined : promptCursors.read(request.cursor);
                    const result = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.listPrompts({
                            ...(peerCursor === undefined ? {} : { cursor: peerCursor }),
                            ...(request.signal === undefined ? {} : { signal: request.signal }),
                        }));
                    }, [seed.signal, request.signal]);
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const validated = validatePromptPage(result);
                    return Object.freeze({
                        items: validated.items,
                        ...(validated.nextCursor === undefined ? {} : { nextCursor: promptCursors.issue(validated.nextCursor) }),
                        ...(validated._meta === undefined ? {} : { _meta: validated._meta }),
                    });
                },
                async getPrompt(
                    name: string,
                    args?: Readonly<Record<string, string>>,
                    promptOptions: Readonly<{ signal?: AbortSignal }> = {},
                ) {
                    if (clientDisposed) fail('plugin_mcp_client_disposed', 'MCP client has been disposed');
                    assertAuthorized(ref, 'listTools');
                    validateNonEmptyText(name, 'MCP prompt name');
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const boundedArgs = args === undefined
                        ? undefined
                        : clonePlainJson(args, 'plugin_mcp_input_invalid', MAX_STABLE_PLUGIN_MCP_INPUT_BYTES) as Readonly<Record<string, string>>;
                    if (boundedArgs !== undefined && (
                        typeof boundedArgs !== 'object'
                        || boundedArgs === null
                        || Array.isArray(boundedArgs)
                        || Object.values(boundedArgs).some((value) => typeof value !== 'string')
                    )) {
                        fail('plugin_mcp_input_invalid', 'MCP prompt arguments must be strings');
                    }
                    const result = await withCancellation(async () => {
                        await revalidateFinalPolicy(Object.freeze({ seed, operation: 'listTools', ref: frozenRef }));
                        return invokePeer(() => runtimeClient.getPrompt(name, boundedArgs, promptOptions));
                    }, [seed.signal, promptOptions.signal]);
                    validateActive(seed, disposed, params.generation);
                    if (registration !== null) assertRegistrationCurrent(registration, params.generation, ref);
                    const validated = validateGetPromptResult(result);
                    return Object.freeze({
                        messages: validated.messages,
                        ...(validated.description === undefined ? {} : { description: validated.description }),
                        ...(validated._meta === undefined ? {} : { _meta: validated._meta }),
                    });
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
            source: PluginMcpDiscoverySourceRef,
            query: Readonly<{ input?: JsonValue; cursor?: string; limit?: number }> = {},
            options: Readonly<{ signal?: AbortSignal }> = {},
        ) {
            validateActive(seed, disposed, params.generation);
            assertAuthorized(source, 'discover');
            const sourceKey = qualifiedId(source);
            const cursorState = query.cursor === undefined ? undefined : discoveryCursors.read(query.cursor);
            if (cursorState !== undefined && cursorState.source !== sourceKey) {
                fail('plugin_mcp_cursor_invalid', 'MCP discovery cursor belongs to a different source');
            }
            validateLimit(query.limit);
            const ref = Object.freeze({ ...source });
            if (!discoverySourceDeclarations.has(qualifiedId(ref))) fail('plugin_mcp_discovery_source_undeclared', 'MCP discovery source is not declared');
            const boundedInput = query.input === undefined
                ? undefined
                : clonePlainJson(query.input, 'plugin_mcp_input_invalid', MAX_STABLE_PLUGIN_MCP_INPUT_BYTES);
            await withCancellation(async () => {
                await params.activateOnDemand(ref, 'mcp.discoverySources');
                await revalidateFinalPolicy(Object.freeze({ seed, operation: 'discover', ref }));
            }, [seed.signal, options.signal]);
            const registration = params.readDiscoverySource(ref);
            if (registration === null) fail('plugin_mcp_discovery_source_unavailable', 'MCP discovery source did not register after activation');
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
                    source: ref,
                    discoveryId: record.discoveryId,
                    title: record.title,
                    ...(record.description === undefined ? {} : { description: record.description }),
                    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
                });
            });
            const response = Object.freeze({
                items: Object.freeze(items),
                ...(resultRecord.nextCursor === undefined ? {} : {
                    nextCursor: discoveryCursors.issue(Object.freeze({ source: sourceKey, cursor: resultRecord.nextCursor })),
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
