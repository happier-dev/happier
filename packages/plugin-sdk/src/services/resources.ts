import type { PluginResourceKind } from '@happier-dev/protocol';

import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef, PluginJsonSchema } from '../identity.js';
import type { Disposable } from '../lifecycle.js';

export type { PluginResourceKind } from '@happier-dev/protocol';
export type PluginResourceDescriptor = Readonly<{ id: string; kind: PluginResourceKind; contentType: string; digest: string; size: number }>;
export interface PluginResourcesService {
    describe(id: string): PluginResourceDescriptor;
    read(id: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<{ kind: PluginResourceKind; contentType: string; digest: string; bytes: Uint8Array }>;
    watch(id: string, listener: (change: { digest: string }) => void): Disposable;
}

export type PluginMcpContributionRef = PluginContributionRef;
export type PluginMcpServerRef = PluginMcpContributionRef;
export type PluginMcpDiscoveryProviderRef = PluginMcpContributionRef;
export type PluginMcpServerSummary = Readonly<{
    ref: PluginMcpServerRef;
    title: string;
    state: 'available' | 'unavailable' | 'denied';
    code?: string;
}>;
export type PluginMcpTool = Readonly<{ name: string; description?: string; inputSchema: PluginJsonSchema; outputSchema?: PluginJsonSchema }>;
export type PluginMcpDiscoveredServer = Readonly<{ provider: PluginMcpDiscoveryProviderRef; discoveryId: string; title: string; description?: string; metadata?: JsonValue }>;
export type PluginMcpElicitationMode =
    | Readonly<{ mode: 'hostMediated'; sessionId: string }>
    | Readonly<{ mode: 'reject' }>;
export interface PluginMcpClient extends Disposable {
    listTools(options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly PluginMcpTool[]; nextCursor?: string }>;
    callTool(name: string, input: JsonValue, options?: { signal?: AbortSignal }): Promise<JsonValue>;
}
export interface PluginMcpService {
    list(query?: { cursor?: string; limit?: number; sessionId?: string; signal?: AbortSignal }): Promise<{ items: readonly PluginMcpServerSummary[]; nextCursor?: string }>;
    connect(ref: PluginMcpServerRef, options: { sessionId?: string; elicitation: PluginMcpElicitationMode; signal?: AbortSignal }): Promise<PluginMcpClient>;
    discover(provider: PluginMcpDiscoveryProviderRef, query?: { input?: JsonValue; cursor?: string; limit?: number }, options?: { signal?: AbortSignal }): Promise<{ items: readonly PluginMcpDiscoveredServer[]; nextCursor?: string }>;
}

export type PluginNotificationDeliveryResult =
    | Readonly<{ deliveryId: string; channelId: string; status: 'accepted'; evidence: 'hostAdapter' | 'provider' | 'authoritativeReceipt' }>
    | Readonly<{ deliveryId: string; channelId: string; status: 'suppressed'; code: string }>
    | Readonly<{ deliveryId: string; channelId: string; status: 'failed'; code: string; retryable?: boolean }>
    | Readonly<{ deliveryId: string; channelId: string; status: 'outcomeUnknown'; code: 'plugin_notification_outcome_unknown' }>;
export type PluginNotificationBatchResult = Readonly<{ deliveries: readonly PluginNotificationDeliveryResult[]; replayed: boolean }>;
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
export interface PluginNotificationsService {
    send(request: { clientRequestId: string; categoryId: string; title: string; body?: string; channelIds?: readonly string[]; data?: JsonValue }, options?: { signal?: AbortSignal }): Promise<PluginNotificationBatchResult>;
    listChannels(options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly PluginNotificationChannelSummary[]; nextCursor?: string }>;
    listCategories(options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly PluginNotificationCategorySummary[]; nextCursor?: string }>;
    preferences(categoryId: string, options?: { signal?: AbortSignal }): Promise<PluginNotificationPreferences>;
    watchPreferences(categoryId: string, listener: (preferences: PluginNotificationPreferences) => void): Disposable;
}

export const PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
