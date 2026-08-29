/** @moduleRealm daemon */
import type {
    PluginResourceContextV1,
    PluginResourceKind,
} from '@happier-dev/protocol';

export type {
    // Named by `PluginResourceDefinition`'s public signature — an author
    // declaring a packaged or dynamic resource must be able to type each arm.
    PluginDynamicResourceContributionV2,
    PluginDynamicResourceScopeV1,
    PluginPackagedResourceContributionV2,
    PluginResourceContextV1,
    PluginResourceContributionV2,
} from '@happier-dev/protocol';

import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef, PluginJsonSchema } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { PluginAccountStorageScope } from '../storage.js';

export type { PluginResourceKind } from '@happier-dev/protocol';
export type PluginResourceDescriptor = Readonly<{ id: string; kind: PluginResourceKind; contentType: string; digest: string; size: number }>;
export interface ResourcesService {
    describe(id: string): PluginResourceDescriptor;
    read(id: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ kind: PluginResourceKind; contentType: string; digest: string; bytes: Uint8Array }>;
    watch(id: string, listener: (change: { digest: string }) => void): Disposable;
}

/**
 * The runtime producer behind one manifest-declared **dynamic** resource
 * (`source: 'dynamic'`, §3.6.1).
 *
 * `read` is the only bytes path — the host wraps it with the same admission,
 * byte bounds, digest and currentness the packaged arm gets, so `readResource`
 * stays the single snapshot authority. `observe` is the invalidation producer:
 * it calls `invalidate()` when the bytes it would return have changed, and the
 * host converts that into one bounded invalidation signal. A producer never
 * sends the new bytes with the signal; the observer re-reads.
 *
 * A packaged resource has no runtime and registers nothing.
 */
export type PluginDynamicResourceInvocationOptionsV1 = Readonly<{
    /** The exact host-owned read or observe lifetime. */
    signal: AbortSignal;
    /** Host-stamped Resource scope; never caller-provided metadata. */
    context: PluginResourceContextV1;
    /** Present only when this dynamic Resource declares an admitted storage.account request. */
    accountStorage?: PluginAccountStorageScope;
}>;

export type PluginDynamicResourceRuntime = Readonly<{
    read(options: PluginDynamicResourceInvocationOptionsV1): Promise<Uint8Array | string> | Uint8Array | string;
    observe(invalidate: () => void, options: PluginDynamicResourceInvocationOptionsV1): Disposable;
}>;

export type PluginMcpContributionRef = PluginContributionRef;
export type PluginMcpServerRef = PluginContributionRef;
export type PluginMcpDiscoverySourceRef = PluginContributionRef;
export type PluginMcpServerSummary = Readonly<{
    ref: PluginMcpServerRef;
    title: string;
    state: 'available' | 'unavailable' | 'denied';
    code?: string;
}>;
export type PluginMcpTool = Readonly<{ name: string; description?: string; inputSchema: PluginJsonSchema; outputSchema?: PluginJsonSchema }>;
export type PluginMcpPageOptions = PluginCancellationOptions & Readonly<{ cursor?: string }>;
export type PluginMcpToolPageOptions = PluginMcpPageOptions & Readonly<{ limit?: number }>;
export type PluginMcpAnnotations = Readonly<{
    audience?: readonly ('user' | 'assistant')[];
    priority?: number;
    lastModified?: string;
}>;
export type PluginMcpIcon = Readonly<{
    src: string;
    mimeType?: string;
    sizes?: readonly string[];
    theme?: 'light' | 'dark';
}>;
export type PluginMcpResource = Readonly<{
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    annotations?: PluginMcpAnnotations;
    icons?: readonly PluginMcpIcon[];
    _meta?: JsonValue;
}>;
export type PluginMcpResourceTemplate = Readonly<{
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    annotations?: PluginMcpAnnotations;
    icons?: readonly PluginMcpIcon[];
    _meta?: JsonValue;
}>;
export type PluginMcpResourcePage = Readonly<{ items: readonly PluginMcpResource[]; nextCursor?: string; _meta?: JsonValue }>;
export type PluginMcpResourceTemplatePage = Readonly<{ items: readonly PluginMcpResourceTemplate[]; nextCursor?: string; _meta?: JsonValue }>;
export type PluginMcpTextResourceContents = Readonly<{ uri: string; mimeType?: string; text: string; _meta?: JsonValue }>;
export type PluginMcpBlobResourceContents = Readonly<{ uri: string; mimeType?: string; blob: string; _meta?: JsonValue }>;
export type PluginMcpResourceContents = PluginMcpTextResourceContents | PluginMcpBlobResourceContents;
export type PluginMcpReadResourceResult = Readonly<{ contents: readonly PluginMcpResourceContents[]; _meta?: JsonValue }>;
export type PluginMcpResourceUpdatedEvent = Readonly<{ uri: string }>;
export type PluginMcpPromptArgument = Readonly<{ name: string; description?: string; required?: boolean }>;
export type PluginMcpPrompt = Readonly<{
    name: string;
    title?: string;
    description?: string;
    arguments?: readonly PluginMcpPromptArgument[];
    icons?: readonly PluginMcpIcon[];
    _meta?: JsonValue;
}>;
export type PluginMcpPromptPage = Readonly<{ items: readonly PluginMcpPrompt[]; nextCursor?: string; _meta?: JsonValue }>;
export type PluginMcpPromptContent =
    | Readonly<{ type: 'text'; text: string; annotations?: PluginMcpAnnotations; _meta?: JsonValue }>
    | Readonly<{ type: 'image' | 'audio'; data: string; mimeType: string; annotations?: PluginMcpAnnotations; _meta?: JsonValue }>
    | Readonly<{ type: 'resource'; resource: PluginMcpResourceContents; annotations?: PluginMcpAnnotations; _meta?: JsonValue }>
    | (PluginMcpResource & Readonly<{ type: 'resource_link' }>);
export type PluginMcpPromptMessage = Readonly<{ role: 'user' | 'assistant'; content: PluginMcpPromptContent }>;
export type PluginMcpGetPromptResult = Readonly<{ description?: string; messages: readonly PluginMcpPromptMessage[]; _meta?: JsonValue }>;
export type PluginMcpDiscoveredServer = Readonly<{ source: PluginMcpDiscoverySourceRef; discoveryId: string; title: string; description?: string; metadata?: JsonValue }>;
export type PluginMcpToolPage = Readonly<{
    items: readonly PluginMcpTool[];
    nextCursor?: string;
}>;
export type PluginMcpElicitationMode =
    | Readonly<{ mode: 'hostMediated'; sessionId: string }>
    | Readonly<{ mode: 'reject' }>;
export interface PluginMcpClient extends Disposable {
    listTools(options?: PluginMcpToolPageOptions): Promise<PluginMcpToolPage>;
    callTool(name: string, input: JsonValue, options?: PluginCancellationOptions): Promise<JsonValue>;
    listResources(options?: PluginMcpPageOptions): Promise<PluginMcpResourcePage>;
    listResourceTemplates(options?: PluginMcpPageOptions): Promise<PluginMcpResourceTemplatePage>;
    readResource(uri: string, options?: PluginCancellationOptions): Promise<PluginMcpReadResourceResult>;
    subscribeResource(
        uri: string,
        listener: (event: PluginMcpResourceUpdatedEvent) => void | Promise<void>,
        options?: PluginCancellationOptions,
    ): Promise<Disposable>;
    listPrompts(options?: PluginMcpPageOptions): Promise<PluginMcpPromptPage>;
    getPrompt(name: string, args?: Readonly<Record<string, string>>, options?: PluginCancellationOptions): Promise<PluginMcpGetPromptResult>;
}
export interface McpService {
    list(query?: { cursor?: string; limit?: number; sessionId?: string; signal?: AbortSignal }): Promise<{ items: readonly PluginMcpServerSummary[]; nextCursor?: string }>;
    connect(ref: PluginMcpServerRef, options: { sessionId?: string; elicitation: PluginMcpElicitationMode; signal?: AbortSignal }): Promise<PluginMcpClient>;
    discover(source: PluginMcpDiscoverySourceRef, query?: { input?: JsonValue; cursor?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<{ items: readonly PluginMcpDiscoveredServer[]; nextCursor?: string }>;
}

export type PluginNotificationSendResult =
    | Readonly<{ deliveryId: string; channelId: string; status: 'accepted'; evidence: 'hostAdapter' | 'provider' | 'authoritativeReceipt' }>
    | Readonly<{ deliveryId: string; channelId: string; status: 'suppressed'; code: string }>
    | Readonly<{ deliveryId: string; channelId: string; status: 'failed'; code: string; retryable?: boolean }>
    | Readonly<{ deliveryId: string; channelId: string; status: 'outcomeUnknown'; code: 'plugin_notification_outcome_unknown' }>;
export type PluginNotificationDeliveryResult = PluginNotificationSendResult;
export type PluginNotificationBatchResult = Readonly<{
    deliveries: readonly PluginNotificationSendResult[];
    replayed: boolean;
}>;
export type PluginNotificationChannelSummary = Readonly<{
    id: string;
    title: string;
    state: 'available' | 'unavailable' | 'denied';
    code?: string;
}>;
export type PluginNotificationCategorySummary = Readonly<{
    id: string;
    title: string;
    description?: string;
    defaultChannelIds: readonly string[];
}>;
export type PluginNotificationPreferences = Readonly<{
    categoryId: string;
    enabled: boolean;
    channelIds: readonly string[];
    revision: string;
}>;
export interface NotificationsService {
    send(request: { clientRequestId: string; categoryId: string; title: string; body?: string; channelIds?: readonly string[]; data?: JsonValue }, options?: { signal?: AbortSignal }): Promise<PluginNotificationBatchResult>;
    listChannels(options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly PluginNotificationChannelSummary[]; nextCursor?: string }>;
    listCategories(options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly PluginNotificationCategorySummary[]; nextCursor?: string }>;
    preferences(categoryId: string, options?: { signal?: AbortSignal }): Promise<PluginNotificationPreferences>;
    watchPreferences(categoryId: string, listener: (preferences: PluginNotificationPreferences) => void): Disposable;
}
