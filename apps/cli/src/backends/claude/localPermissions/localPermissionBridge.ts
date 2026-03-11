import type { AgentState, PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { randomUUID } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import { basename } from 'node:path';
import { applyAgentStateRequestPushNotifiedAt, clonePlainObjectToNullProto, cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';

import type { Session } from '../session';
import type { PermissionHookData, PermissionHookResponse } from '../utils/startHookServer';
import { getToolName } from '../utils/getToolName';
import { deepEqual } from '@/utils/deterministicJson';
import type { PermissionRpcPayload } from '../utils/permissionRpc';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist, seedAllowlistFromCompletedRequests } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    isClaudeLocalPermissionBridgeAgentStateRequest,
} from '../utils/permissionRequestSource';

type PendingPermissionRequest = {
    id: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    timeout: NodeJS.Timeout | null;
    resolve: (response: PermissionHookResponse) => void;
    promise: Promise<PermissionHookResponse>;
};

type CompletionStatus = 'approved' | 'denied' | 'canceled';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];

const DEFAULT_RESPONSE_TIMEOUT_MS: number | null = null;
const PERMISSION_TIMED_OUT_REASON = 'Timed out waiting for permission response';
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

export const DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE = {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
    },
} as const satisfies PermissionHookResponse;

export class ClaudeLocalPermissionBridge {
    private readonly session: Session;
    private readonly responseTimeoutMs: number | null;
    private readonly pendingRequests = new Map<string, PendingPermissionRequest>();
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private readonly allowedToolIdentifiers = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private permissionModeUpdatedAt: number = 0;
    private metadataWatcherAbort: AbortController | null = null;

    constructor(session: Session, opts?: { responseTimeoutMs?: number | null }) {
        this.session = session;
        if (opts?.responseTimeoutMs === null) {
            this.responseTimeoutMs = null;
        } else if (typeof opts?.responseTimeoutMs === 'number' && Number.isFinite(opts.responseTimeoutMs) && opts.responseTimeoutMs > 0) {
            this.responseTimeoutMs = opts.responseTimeoutMs;
        } else {
            this.responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;
        }
    }

    activate(): void {
        this.session.getOrCreatePermissionRpcRouter().registerConsumer({
            name: 'claude-local-permission-bridge',
            tryHandlePermissionRpc: (payload) => this.tryHandlePermissionRpc(payload),
        });
        this.seedAllowlistFromAgentState();
        this.syncPermissionModeFromMetadataSnapshot();
        this.startMetadataWatcher();
    }

    dispose(): void {
        if (this.metadataWatcherAbort) {
            try {
                this.metadataWatcherAbort.abort('claude-local-permission-bridge:dispose');
            } catch {
                // ignore
            }
            this.metadataWatcherAbort = null;
        }

        for (const pending of [...this.pendingRequests.values()]) {
            if (pending.timeout) {
                clearTimeout(pending.timeout);
            }
            this.completeRequest({
                requestId: pending.id,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                createdAt: pending.createdAt,
                status: 'canceled',
                reason: 'Local permission bridge stopped',
                hookResponse: DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
            });
        }
        this.pendingRequests.clear();
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
    }

    async handlePermissionHook(data: PermissionHookData): Promise<PermissionHookResponse> {
        this.syncPermissionModeFromMetadataSnapshot();
        const hookRequestId = this.resolveRequestId(data);
        const transcriptRequestId = !hookRequestId ? await this.resolveRequestIdFromTranscript(data) : null;
        const requestId = hookRequestId ?? transcriptRequestId ?? this.generateRequestId();

        if (!hookRequestId && transcriptRequestId) {
            logger.debug(`[claude-local-permissions] Permission hook missing tool_use_id; recovered ${transcriptRequestId} from transcript`);
        } else if (!hookRequestId && !transcriptRequestId) {
            logger.debug(`[claude-local-permissions] Permission hook missing tool_use_id; generated request id ${requestId}`);
        }

        const existing = this.pendingRequests.get(requestId);
        if (existing) {
            return existing.promise;
        }

        const toolName = this.resolveToolName(data);
        const toolInput = this.resolveToolInput(data);
        const permissionSuggestions = this.resolvePermissionSuggestions(data);
        const createdAt = Date.now();

        // If we already have an allowlist rule for this tool call, respond immediately without surfacing a prompt.
        // This mirrors Claude Code's "don't ask again" behavior, but is enforced by Happier for reliability.
        if (!this.isInteractiveTool(toolName) && isToolAllowedForSession(this.allowedToolIdentifiers, toolName, toolInput)) {
            return {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'allow' },
                },
            };
        }

        const policyDecision = this.computePolicyDecision(toolName);
        if (!this.isInteractiveTool(toolName) && policyDecision === 'allow') {
            const hookResponse: PermissionHookResponse = {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'allow' },
                },
            };
            this.completeRequest({
                requestId,
                toolName,
                toolInput,
                createdAt,
                status: 'approved',
                mode: this.permissionMode,
                hookResponse,
            });
            return hookResponse;
        }

        if (!this.isInteractiveTool(toolName) && policyDecision === 'deny') {
            const hookResponse: PermissionHookResponse = {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'deny' },
                },
            };
            this.completeRequest({
                requestId,
                toolName,
                toolInput,
                createdAt,
                status: 'denied',
                mode: this.permissionMode,
                hookResponse,
            });
            return hookResponse;
        }

        this.publishPendingRequest({ requestId, toolName, toolInput, permissionSuggestions, createdAt });

        let resolvePending: (response: PermissionHookResponse) => void = () => {};
        const promise = new Promise<PermissionHookResponse>((resolve) => {
            resolvePending = resolve;
        });

        const timeout = this.resolveResponseTimeout(toolName) === null
            ? null
            : setTimeout(() => {
                this.completeRequest({
                    requestId,
                    toolName,
                    toolInput,
                    createdAt,
                    status: 'canceled',
                    reason: PERMISSION_TIMED_OUT_REASON,
                    hookResponse: DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
                });
            }, this.resolveResponseTimeout(toolName)!);
        timeout?.unref?.();

        this.pendingRequests.set(requestId, {
            id: requestId,
            toolName,
            toolInput,
            createdAt,
            timeout,
            resolve: resolvePending,
            promise,
        });

        return promise;
    }

    private computePolicyDecision(toolName: string): 'prompt' | 'allow' | 'deny' {
        const mode = this.permissionMode;
        if (mode === 'yolo') return 'allow';
        if (mode === 'safe-yolo') {
            return isDefaultWriteLikeToolName(toolName) ? 'prompt' : 'allow';
        }
        if (mode === 'read-only') {
            return isDefaultWriteLikeToolName(toolName) ? 'deny' : 'allow';
        }
        return 'prompt';
    }

    private resolveResponseTimeout(toolName: string): number | null {
        if (this.isInteractiveTool(toolName)) {
            return null;
        }
        return this.responseTimeoutMs;
    }

    private syncPermissionModeFromMetadataSnapshot(): PermissionMode | null {
        const resolved = resolvePermissionIntentFromMetadataSnapshot({
            metadata: this.session.client.getMetadataSnapshot?.() ?? null,
        });
        if (!resolved) return null;
        if (resolved.updatedAt <= this.permissionModeUpdatedAt) return null;

        const canonical = normalizePermissionModeToIntent(resolved.intent) ?? 'default';
        this.permissionModeUpdatedAt = resolved.updatedAt;
        if (canonical === this.permissionMode) return null;

        this.permissionMode = canonical;
        this.tryAutoCompletePendingRequestsForPermissionMode();
        return canonical;
    }

    private startMetadataWatcher(): void {
        if (this.metadataWatcherAbort) return;
        if (typeof this.session.client.waitForMetadataUpdate !== 'function') return;

        const controller = new AbortController();
        this.metadataWatcherAbort = controller;
        const signal = controller.signal;
        const waitForAbortOrBackoff = async (): Promise<void> => {
            const backoffMs = 250;
            if (signal.aborted) return;
            await new Promise<void>((resolve) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup(onAbort);
                    resolve();
                }, backoffMs);
                timer.unref?.();

                const cleanup = (onAbort: () => void) => {
                    signal.removeEventListener('abort', onAbort);
                    clearTimeout(timer);
                };

                const onAbort = () => {
                    if (settled) return;
                    settled = true;
                    cleanup(onAbort);
                    resolve();
                };
                signal.addEventListener('abort', onAbort, { once: true });
            });
        };

        void (async () => {
            while (!signal.aborted) {
                const updated = await this.session.client.waitForMetadataUpdate(signal).catch(() => false);
                if (!updated || signal.aborted) {
                    await waitForAbortOrBackoff();
                    continue;
                }
                this.syncPermissionModeFromMetadataSnapshot();
            }
        })();
    }

    private tryAutoCompletePendingRequestsForPermissionMode(excludeRequestId?: string): void {
        if (this.pendingRequests.size === 0) return;

        const idsToApprove: string[] = [];
        const idsToDeny: string[] = [];
        for (const [id, pending] of this.pendingRequests.entries()) {
            if (id === excludeRequestId) continue;
            if (this.isInteractiveTool(pending.toolName)) continue;
            const decision = this.computePolicyDecision(pending.toolName);
            if (decision === 'allow') idsToApprove.push(id);
            if (decision === 'deny') idsToDeny.push(id);
        }

        for (const id of idsToApprove) {
            const pending = this.pendingRequests.get(id);
            if (!pending) continue;
            const hookResponse: PermissionHookResponse = {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'allow' },
                },
            };
            this.completeRequest({
                requestId: id,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                createdAt: pending.createdAt,
                status: 'approved',
                mode: this.permissionMode,
                hookResponse,
            });
        }

        for (const id of idsToDeny) {
            const pending = this.pendingRequests.get(id);
            if (!pending) continue;
            const hookResponse: PermissionHookResponse = {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'deny' },
                },
            };
            this.completeRequest({
                requestId: id,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                createdAt: pending.createdAt,
                status: 'denied',
                mode: this.permissionMode,
                hookResponse,
            });
        }
    }

    private generateRequestId(): string {
        return `perm_${randomUUID()}`;
    }

    private async resolveRequestIdFromTranscript(data: PermissionHookData): Promise<string | null> {
        // Prefer the session-owned transcriptPath; only fall back to hook payload paths when the session
        // has not yet observed a transcript path.
        const transcriptPath =
            typeof this.session.transcriptPath === 'string' && this.session.transcriptPath.trim().length > 0
                ? this.session.transcriptPath
                : (typeof data.transcript_path === 'string'
                    ? data.transcript_path
                    : (typeof data.transcriptPath === 'string' ? data.transcriptPath : ''));
        const normalizedTranscriptPath = String(transcriptPath ?? '').trim();
        if (!normalizedTranscriptPath) {
            return null;
        }
        // Defensive checks: the hook payload is untrusted input (even if usually local-only).
        // Avoid reading obviously-wrong or surprising files.
        if (normalizedTranscriptPath.length > 4096) return null;
        const fileName = basename(normalizedTranscriptPath).toLowerCase();
        if (!(fileName.endsWith('.jsonl') || fileName.endsWith('.json'))) return null;

        const toolName = this.resolveToolName(data);
        const toolInput = this.resolveToolInput(data);

        try {
            const fileHandle = await openFile(normalizedTranscriptPath, 'r');
            try {
                const stat = await fileHandle.stat();
                const size = typeof stat.size === 'number' ? stat.size : 0;
                if (size <= 0) {
                    return null;
                }

                const bytesToRead = Math.min(size, TRANSCRIPT_TAIL_BYTES);
                const start = Math.max(0, size - bytesToRead);
                const buffer = Buffer.alloc(bytesToRead);
                const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, start);
                const text = buffer.subarray(0, bytesRead).toString('utf8');

                const lines = text.split('\n');
                for (let i = lines.length - 1; i >= 0; i -= 1) {
                    const line = lines[i]?.trim();
                    if (!line) continue;
                    let parsed: any;
                    try {
                        parsed = JSON.parse(line);
                    } catch {
                        continue;
                    }

                    const content = parsed?.message?.content;
                    if (!Array.isArray(content)) {
                        continue;
                    }

                    for (const item of content) {
                        if (item?.type !== 'tool_use') continue;
                        if (item?.name !== toolName) continue;
                        if (typeof item?.id !== 'string' || item.id.trim().length === 0) continue;
                        if (!deepEqual(item?.input, toolInput)) continue;
                        return item.id.trim();
                    }
                }
            } finally {
                await fileHandle.close();
            }
        } catch (error) {
            logger.debug('[claude-local-permissions] Failed to recover tool_use_id from transcript', error);
            return null;
        }

        return null;
    }

    private tryHandlePermissionRpc(payload: PermissionRpcPayload): boolean {
        const requestId = typeof payload?.id === 'string' ? payload.id : '';
        if (!requestId) {
            return false;
        }

        const pending = this.pendingRequests.get(requestId);
        const existingRequest = this.getOutstandingAgentStateRequest(requestId);
        if (!pending && !existingRequest) {
            return false;
        }

        const allowedTools = Array.isArray(payload.allowedTools ?? payload.allowTools)
            ? [...(payload.allowedTools ?? payload.allowTools)!]
            : undefined;
        const resolvedMode = typeof payload.mode === 'string'
            ? (normalizePermissionModeToIntent(payload.mode) ?? payload.mode)
            : undefined;

        const updatedPermissions = payload.updatedPermissions;
        const hookResponse: PermissionHookResponse = payload.approved
            ? {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                        behavior: 'allow',
                        ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
                    },
                },
            }
            : {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                        behavior: 'deny',
                        ...(typeof payload.reason === 'string' && payload.reason.length > 0 ? { message: payload.reason } : {}),
                    },
                },
                ...(typeof payload.reason === 'string' && payload.reason.length > 0
                    ? { systemMessage: payload.reason }
                    : {}),
            };

        this.completeRequest({
            requestId,
            toolName: pending?.toolName ?? existingRequest?.toolName ?? 'unknown_tool',
            toolInput: pending?.toolInput ?? existingRequest?.toolInput ?? {},
            createdAt: pending?.createdAt ?? existingRequest?.createdAt ?? Date.now(),
            status: payload.approved ? 'approved' : 'denied',
            reason: payload.reason,
            mode: resolvedMode,
            allowedTools,
            updatedPermissions,
            hookResponse,
        });

        this.applyPermissionRpcState(payload, { allowedTools, resolvedMode, excludeRequestId: requestId });
        return true;
    }

    private isInteractiveTool(toolName: string): boolean {
        return (
            toolName === 'AskUserQuestion' ||
            toolName === 'ask_user_question' ||
            toolName === 'ExitPlanMode' ||
            toolName === 'exit_plan_mode'
        );
    }

    private tryAutoCompletePendingRequests(excludeRequestId?: string): void {
        if (this.pendingRequests.size === 0) return;

        const idsToApprove: string[] = [];
        for (const [id, pending] of this.pendingRequests.entries()) {
            if (id === excludeRequestId) continue;
            if (this.isInteractiveTool(pending.toolName)) continue;
            if (isToolAllowedForSession(this.allowedToolIdentifiers, pending.toolName, pending.toolInput)) {
                idsToApprove.push(id);
            }
        }

        for (const id of idsToApprove) {
            const pending = this.pendingRequests.get(id);
            if (!pending) continue;
            this.completeRequest({
                requestId: id,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                createdAt: pending.createdAt,
                status: 'approved',
                hookResponse: {
                    continue: true,
                    suppressOutput: true,
                    hookSpecificOutput: {
                        hookEventName: 'PermissionRequest',
                        decision: { behavior: 'allow' },
                    },
                },
            });
        }
    }

    private applyPermissionRpcState(
        payload: PermissionRpcPayload,
        params: { allowedTools?: string[]; resolvedMode?: PermissionMode; excludeRequestId?: string }
    ): void {
        if (payload.approved) {
            applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, payload.updatedPermissions);
            applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, params.allowedTools);
        }

        if (payload.approved && params.resolvedMode) {
            this.permissionMode = params.resolvedMode;
            this.tryAutoCompletePendingRequestsForPermissionMode(params.excludeRequestId);
        }

        if (payload.approved) {
            this.tryAutoCompletePendingRequests(params.excludeRequestId);
        }
    }

    private getOutstandingAgentStateRequest(requestId: string): { toolName: string; toolInput: unknown; createdAt: number } | null {
        const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
        const requests = snapshot?.requests;
        const request = requests && typeof requests === 'object' ? (requests as Record<string, unknown>)[requestId] : null;
        if (!isClaudeLocalPermissionBridgeAgentStateRequest(request)) return null;
        const toolName = typeof (request as any).tool === 'string' ? (request as any).tool : 'unknown_tool';
        const toolInput = typeof (request as any).arguments !== 'undefined' ? (request as any).arguments : {};
        const createdAt = typeof (request as any).createdAt === 'number' ? (request as any).createdAt : Date.now();
        return { toolName, toolInput, createdAt };
    }

    private seedAllowlistFromAgentState(): void {
        try {
            const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;
            seedAllowlistFromCompletedRequests(this.allowedToolIdentifiers, completed);
        } catch {
            // Best-effort only; allowlist seeding is not critical.
        }
    }

    private completeRequest(params: {
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        status: CompletionStatus;
        reason?: string;
        mode?: PermissionMode;
        allowedTools?: string[];
        updatedPermissions?: unknown;
        hookResponse: PermissionHookResponse;
    }): void {
        const pending = this.pendingRequests.get(params.requestId);
        if (pending) {
            if (pending.timeout) {
                clearTimeout(pending.timeout);
            }
            this.pendingRequests.delete(params.requestId);
        }

        this.permissionRequestPushNotifier?.markCompleted(params.requestId);

        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const existing = requests[params.requestId] as unknown;
                delete requests[params.requestId];

                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const completedEntry = clonePlainObjectToNullProto(existing) ?? Object.create(null);
                if (!existing) {
                    completedEntry['tool'] = params.toolName;
                    completedEntry['arguments'] = params.toolInput;
                    completedEntry['createdAt'] = params.createdAt;
                }
                completedEntry['completedAt'] = Date.now();
                completedEntry['status'] = params.status;
                if (typeof params.reason === 'string' && params.reason.length > 0) completedEntry['reason'] = params.reason;
                if (typeof params.mode === 'string') completedEntry['mode'] = params.mode;
                if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) completedEntry['allowedTools'] = params.allowedTools;
                if (typeof params.updatedPermissions !== 'undefined') completedEntry['updatedPermissions'] = params.updatedPermissions;
                completedRequests[params.requestId] = completedEntry;

                return {
                    ...currentState,
                    requests,
                    completedRequests,
                };
            },
            '[claude-local-permissions]',
            'complete_request',
        );

        pending?.resolve(params.hookResponse);
    }

    private getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        if (!this.session.pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;
        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender: this.session.pushSender,
            getSettings: () => this.session.accountSettings ?? null,
            sessionId: this.session.client.sessionId,
            logPrefix: '[claude-local-permissions]',
            onNotifiedAt: (permissionId, notifiedAtMs) => {
                updateAgentStateBestEffort(
                    this.session.client,
                    (currentState) =>
                        applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId, notifiedAtMs }),
                    '[claude-local-permissions]',
                    'permission_request_push_notified_at',
                );
            },
        });
        return this.permissionRequestPushNotifier;
    }

    private publishPendingRequest(params: {
        requestId: string;
        toolName: string;
        toolInput: unknown;
        permissionSuggestions?: unknown[] | null;
        createdAt: number;
    }): void {
        const notifier = this.getOrCreatePermissionRequestPushNotifier();
        if (notifier) {
            try {
                const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
                const existing = snapshot?.requests?.[params.requestId] ?? null;
                const notifiedAt = typeof (existing as any)?.pushNotifiedAt === 'number' ? (existing as any).pushNotifiedAt : null;
                if (typeof notifiedAt === 'number' && Number.isFinite(notifiedAt) && notifiedAt > 0) {
                    notifier.markAlreadyNotified(params.requestId);
                } else {
                    notifier.notify({
                        permissionId: params.requestId,
                        toolName: getToolName(params.toolName),
                        toolInput: params.toolInput,
                        requestKind: resolveAgentRequestKind(params.toolName),
                        createdAtMs: params.createdAt,
                    });
                }
            } catch {
                notifier.notify({
                    permissionId: params.requestId,
                    toolName: getToolName(params.toolName),
                    toolInput: params.toolInput,
                    requestKind: resolveAgentRequestKind(params.toolName),
                    createdAtMs: params.createdAt,
                });
            }
        }

                updateAgentStateBestEffort(
                    this.session.client,
                    (currentState) => {
                        const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                        const entry = Object.create(null) as AgentStateRequestEntry;
                        entry.tool = params.toolName;
                        entry.kind = resolveAgentRequestKind(params.toolName);
                        (entry as AgentStateRequestEntry & { source?: string }).source = CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE;
                        entry.arguments = params.toolInput;
                        entry.createdAt = params.createdAt;
                        if (Array.isArray(params.permissionSuggestions) && params.permissionSuggestions.length > 0) {
                            entry.permissionSuggestions = params.permissionSuggestions;
                        }
                        requests[params.requestId] = entry;
                        return {
                            ...currentState,
                            capabilities: {
                            ...(currentState.capabilities ?? {}),
                        askUserQuestionAnswersInPermission: true,
                        localPermissionBridgeInLocalMode: true,
                        permissionsInUiWhileLocal: true,
                    },
                    requests,
                };
            },
            '[claude-local-permissions]',
            'publish_pending_request',
            );
    }

    private resolvePermissionSuggestions(data: PermissionHookData): unknown[] | null {
        const raw = (data as any).permission_suggestions ?? (data as any).permissionSuggestions ?? (data as any).permissionSuggestionsV1;
        if (!Array.isArray(raw) || raw.length === 0) {
            return null;
        }
        return raw as unknown[];
    }

    private resolveRequestId(data: PermissionHookData): string | null {
        const id = data.tool_use_id ?? data.toolUseId;
        if (typeof id !== 'string') {
            return null;
        }
        const trimmed = id.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    private resolveToolName(data: PermissionHookData): string {
        const toolName = data.tool_name ?? data.toolName;
        if (typeof toolName !== 'string') {
            return 'unknown_tool';
        }
        const trimmed = toolName.trim();
        return trimmed.length > 0 ? trimmed : 'unknown_tool';
    }

    private resolveToolInput(data: PermissionHookData): unknown {
        if (typeof data.tool_input !== 'undefined') {
            return data.tool_input;
        }
        if (typeof data.toolInput !== 'undefined') {
            return data.toolInput;
        }
        return {};
    }
}
