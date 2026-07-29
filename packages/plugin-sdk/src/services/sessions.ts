import type { PluginOperationAvailability } from '../availability.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue } from '../identity.js';
import type { Disposable } from '../lifecycle.js';

export type PluginSessionSummary = Readonly<{
    id: string;
    title?: string;
    machineId: string;
    projectId?: string;
    agentId?: string;
    state: 'active' | 'idle' | 'stopped' | 'archived';
    runtimeAvailability: PluginOperationAvailability;
    storagePolicy: 'required_e2ee' | 'optional' | 'plaintext_only';
    encryptionMode: 'e2ee' | 'plain';
    updatedAtMs: number;
}>;
export type PluginSessionSendRequest =
    | Readonly<{ kind: 'userText'; text: string }>
    | Readonly<{ kind: 'event'; eventId: string; data?: JsonValue }>
    | Readonly<{ kind: 'structuredMessage'; message: JsonValue; delivery: 'ephemeral' | 'committed' }>;
export type PluginSessionSendResult =
    | Readonly<{ status: 'accepted' }>
    | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>;
export type PluginSessionMessagePart =
    | Readonly<{ kind: 'text'; text: string }>
    | Readonly<{ kind: 'structured'; mediaType: string; value: JsonValue }>;
export type PluginSessionEvent =
    | Readonly<{ sequence: number; kind: 'changed'; summary: PluginSessionSummary }>
    | Readonly<{ sequence: number; kind: 'message'; message: { version: 1; messageId: string; sender: 'user' | 'agent' | 'system' | 'tool'; parts: readonly [PluginSessionMessagePart, ...PluginSessionMessagePart[]] } }>
    | Readonly<{ sequence: number; kind: 'activity'; activity: { state: 'active' | 'idle' | 'stopped'; observedAtMs: number } }>
    | Readonly<{ sequence: number; kind: 'removed'; sessionId: string }>;

export type PluginSessionWorkStateItem = Readonly<{
    localId: string;
    kind: 'goal' | 'task' | 'todo';
    origin: 'vendor' | 'happier' | 'derived';
    status: 'pending' | 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown';
    statusReason?: 'blocked' | 'usageLimited' | 'budgetLimited' | 'interrupted';
    title: string;
    summary?: string;
    providerRef?: string;
    order?: number;
    parentProviderRef?: string;
    priority?: string;
    progress?: number;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    createdAtMs?: number;
    startedAtMs?: number;
    completedAtMs?: number;
    updatedAtMs: number;
    providerData?: JsonValue;
}>;
export type PluginSessionWorkStateTruncation =
    | Readonly<{ reason: 'itemLimit'; omittedCount: number }>
    | Readonly<{ reason: 'providerLimit' | 'byteLimit'; omittedCount?: number }>;
export interface PluginCurrentSessionWorkStatePublisher {
    publish(request: { sourceSequence: number; observedAtMs: number; items: readonly PluginSessionWorkStateItem[]; primaryLocalId?: string | null; truncation?: PluginSessionWorkStateTruncation }, options?: { signal?: AbortSignal }): Promise<
        | { status: 'applied' | 'unchanged'; revision: string; sourceSequence: number }
        | { status: 'ignoredStale'; revision: string; currentSourceSequence: number }
        | { status: 'conflict' | 'unavailable'; diagnostic: PluginDiagnosticData }
    >;
}
export interface PluginCurrentSessionWorkStateService { publisher(declaredSourceId: string): PluginCurrentSessionWorkStatePublisher }

export type PluginSessionMediaPublishGeneratedRequest = Readonly<{
    localId: string;
    path: string;
    referencePaths?: readonly string[];
    description?: string;
    toolCallId?: string;
    createdAtMs?: number;
}>;
export interface PluginSessionMediaSourceRoot {
    publishGenerated(request: PluginSessionMediaPublishGeneratedRequest): Promise<Readonly<{ status: 'published' }>>;
    dispose(): void;
}
export interface PluginSessionMediaService {
    registerSourceRoot(request: Readonly<{ rootPath: string }>): Promise<PluginSessionMediaSourceRoot>;
}

export interface PluginSessionService {
    summary(options?: { signal?: AbortSignal }): Promise<PluginSessionSummary>;
    send(request: PluginSessionSendRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionSendResult>;
    watch(listener: (event: PluginSessionEvent) => void): Disposable;
}
export interface PluginCurrentSessionService extends PluginSessionService {
    availability(): PluginOperationAvailability;
    readonly media: PluginSessionMediaService;
}
export type PluginSubagentSummary = Readonly<{ id: string; parentSessionId: string; groupId?: string; status: 'starting' | 'running' | 'completed' | 'failed' | 'aborted'; updatedAtMs: number }>;
export type PluginSubagentObservation = Readonly<{
    observationId: string;
    groupId?: string;
    status: PluginSubagentSummary['status'];
    detail?: JsonValue;
}>;
export interface PluginSubagentsService {
    capabilities(): { list: PluginOperationAvailability; observe: PluginOperationAvailability; watch: PluginOperationAvailability };
    list(query?: { parentSessionId?: string; groupId?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{ items: readonly PluginSubagentSummary[]; nextCursor?: string }>;
    get(id: string, options?: { parentSessionId?: string; signal?: AbortSignal }): Promise<PluginSubagentSummary | null>;
    observe(input: PluginSubagentObservation, options?: { signal?: AbortSignal }): Promise<PluginSubagentSummary>;
    watch(query: { parentSessionId?: string; id?: string }, listener: (event: { kind: 'snapshot' | 'upserted' | 'removed' | 'resyncRequired'; item?: PluginSubagentSummary; id?: string }) => void): Disposable;
}
export type PluginSessionWatchQuery = Readonly<{
    machineId?: string;
    projectId?: string;
    state?: PluginSessionSummary['state'];
}>;
export type PluginSessionWatchEvent =
    | Readonly<{ kind: 'snapshot'; revision: string; items: readonly PluginSessionSummary[] }>
    | Readonly<{ kind: 'upserted'; revision: string; item: PluginSessionSummary }>
    | Readonly<{ kind: 'removed'; revision: string; id: string }>
    | Readonly<{ kind: 'resyncRequired'; revision: string }>;
export interface PluginSessionsService {
    readonly current: PluginCurrentSessionService;
    list(query?: { cursor?: string; limit?: number; machineId?: string; projectId?: string; state?: PluginSessionSummary['state']; signal?: AbortSignal }): Promise<{ items: readonly PluginSessionSummary[]; nextCursor?: string }>;
    get(id: string, options?: { signal?: AbortSignal }): Promise<PluginSessionService | null>;
    watch(query: PluginSessionWatchQuery, listener: (event: PluginSessionWatchEvent) => void): Disposable;
    readonly subagents: PluginSubagentsService;
}

export const MAX_AGENT_WORK_STATE_SOURCES_PER_CONTRIBUTION = 32;
export const MAX_AGENT_WORK_STATE_ITEMS_PER_SOURCE = 100;
export const MAX_AGENT_WORK_STATE_TITLE_CODE_UNITS = 4_000;
export const MAX_AGENT_WORK_STATE_SUMMARY_CODE_UNITS = 8_000;
