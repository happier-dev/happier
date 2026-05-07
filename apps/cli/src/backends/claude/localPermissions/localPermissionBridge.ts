import type { AgentState, PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { randomUUID } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { clonePlainObjectToNullProto, cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createPermissionRequestCoordinator } from '@/agent/permissions/permissionRequestCoordinator';
import type { PermissionRequestCoordinatorStore } from '@/agent/permissions/permissionRequestCoordinator';

import type { Session } from '../session';
import type { PermissionHookData, PermissionHookResponse } from '../utils/startHookServer';
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
} from '@happier-dev/agents';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';
import { withAskUserQuestionUiFreeformDefault } from './askUserQuestionFreeformDefault';

type PendingPermissionRequest = {
    id: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
};

type CompletionStatus = 'approved' | 'denied' | 'canceled';

const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
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
    private readonly requestStore: AgentStateRequestStore;
    private readonly permissionCoordinator: ReturnType<typeof createPermissionRequestCoordinator<PermissionHookResponse>>;
    private readonly pendingRequests = new Map<string, PendingPermissionRequest>();
    private readonly localWaitersByRequestId = new Map<string, Set<string>>();
    private readonly localWaiterTimeouts = new Map<string, NodeJS.Timeout>();
    private readonly allowedToolIdentifiers = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private permissionModeUpdatedAt: number = 0;
    private metadataWatcherAbort: AbortController | null = null;
    private localWaiterSequence = 0;

    constructor(session: Session, opts?: { responseTimeoutMs?: number | null }) {
        this.session = session;
        if (opts?.responseTimeoutMs === null) {
            this.responseTimeoutMs = null;
        } else if (typeof opts?.responseTimeoutMs === 'number' && Number.isFinite(opts.responseTimeoutMs) && opts.responseTimeoutMs > 0) {
            this.responseTimeoutMs = opts.responseTimeoutMs;
        } else {
            this.responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;
        }
        this.requestStore = new AgentStateRequestStore({
            session: this.session.client,
            logPrefix: '[claude-local-permissions]',
            pushSender: this.session.pushSender ?? null,
            getAccountSettings: () => this.session.accountSettings ?? null,
            getAccountSettingsSecretsReadKeys: () => this.session.accountSettingsSecretsReadKeys ?? [],
        });
        this.permissionCoordinator = createPermissionRequestCoordinator<PermissionHookResponse>({
            store: this.createCoordinatorStore(),
        });
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

        for (const timeout of this.localWaiterTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.localWaiterTimeouts.clear();

        for (const pending of [...this.pendingRequests.values()]) {
            this.completeRequest({
                requestId: pending.id,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                createdAt: pending.createdAt,
                status: 'canceled',
                reason: 'Local permission bridge stopped',
                hookResponse: DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
            });
            this.permissionCoordinator.cancelRequest(pending.id, 'Local permission bridge stopped');
        }
        this.pendingRequests.clear();
        this.localWaitersByRequestId.clear();
        this.permissionCoordinator.dispose();
        this.requestStore.dispose();
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

        const toolName = this.resolveToolName(data);
        const toolInput = this.resolveToolInput(data);
        const permissionSuggestions = this.resolvePermissionSuggestions(data);
        const existing = this.pendingRequests.get(requestId);
        const createdAt = existing?.createdAt ?? Date.now();

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

        if (!existing) {
            this.pendingRequests.set(requestId, {
                id: requestId,
                toolName,
                toolInput,
                createdAt,
            });
        }

        const waiter = this.createLocalWaiter({
            requestId,
            toolName,
            toolInput,
            createdAt,
        });

        const coordinatorDecision = this.permissionCoordinator.requestDecision({
            requestId,
            toolName,
            toolInput,
            createdAt,
            kind: resolveAgentRequestKind(toolName),
            source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            permissionSuggestions,
        }, {
            signal: waiter.signal,
        });

        return coordinatorDecision.then(
            (response) => {
                const remaining = this.finishLocalWaiter(requestId, waiter.id);
                if (remaining === 0) {
                    this.pendingRequests.delete(requestId);
                }
                return response;
            },
            (error) => {
                const remaining = this.finishLocalWaiter(requestId, waiter.id);
                if (waiter.wasTimedOut()) {
                    if (remaining === 0) {
                        this.completeRequest({
                            requestId,
                            toolName,
                            toolInput,
                            createdAt,
                            status: 'canceled',
                            reason: PERMISSION_TIMED_OUT_REASON,
                            hookResponse: DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
                        });
                        this.permissionCoordinator.cancelRequest(requestId, PERMISSION_TIMED_OUT_REASON);
                    }
                    return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
                }
                throw error;
            },
        );
    }

    private computePolicyDecision(toolName: string): 'prompt' | 'allow' | 'deny' {
        if (isChangeTitleToolLikeName(toolName)) return 'allow';
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

    private createCoordinatorStore(): PermissionRequestCoordinatorStore {
        return {
            publishRequest: (params) => {
                this.requestStore.publishRequest({
                    ...params,
                    toolInput: withAskUserQuestionUiFreeformDefault(params.toolName, params.toolInput),
                    source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    updateState: (state) => ({
                        ...state,
                        capabilities: {
                            ...(state.capabilities ?? {}),
                            askUserQuestionAnswersInPermission: true,
                            localPermissionBridgeInLocalMode: true,
                            permissionsInUiWhileLocal: true,
                        },
                    }),
                });
            },
            completeRequest: (params) => {
                this.requestStore.completeRequest(params);
            },
            cancelAllRequests: (params) => {
                this.cancelLocalOutstandingRequests(params.reason);
            },
            hasOutstandingRequest: (requestId) => this.readLocalOutstandingRequest(requestId) !== null,
            readOutstandingRequest: (requestId) => this.readLocalOutstandingRequest(requestId),
        };
    }

    private createLocalWaiter(params: {
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
    }): { id: string; signal: AbortSignal; wasTimedOut: () => boolean } {
        const waiterId = `local-waiter-${++this.localWaiterSequence}`;
        const controller = new AbortController();
        let timedOut = false;

        let waiters = this.localWaitersByRequestId.get(params.requestId);
        if (!waiters) {
            waiters = new Set();
            this.localWaitersByRequestId.set(params.requestId, waiters);
        }
        waiters.add(waiterId);

        const timeoutMs = this.resolveResponseTimeout(params.toolName);
        if (timeoutMs !== null) {
            const timeout = setTimeout(() => {
                timedOut = true;
                controller.abort(PERMISSION_TIMED_OUT_REASON);
            }, timeoutMs);
            timeout.unref?.();
            this.localWaiterTimeouts.set(waiterId, timeout);
        }

        return {
            id: waiterId,
            signal: controller.signal,
            wasTimedOut: () => timedOut,
        };
    }

    private finishLocalWaiter(requestId: string, waiterId: string): number {
        const timeout = this.localWaiterTimeouts.get(waiterId);
        if (timeout) {
            clearTimeout(timeout);
            this.localWaiterTimeouts.delete(waiterId);
        }

        const waiters = this.localWaitersByRequestId.get(requestId);
        if (!waiters) return 0;
        waiters.delete(waiterId);
        const remaining = waiters.size;
        if (remaining === 0) {
            this.localWaitersByRequestId.delete(requestId);
        }
        return remaining;
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

    private applyPermissionModeFromRpc(mode: PermissionMode, excludeRequestId?: string): void {
        this.permissionMode = mode;
        this.permissionModeUpdatedAt = Math.max(this.permissionModeUpdatedAt, Date.now());
        this.tryAutoCompletePendingRequestsForPermissionMode(excludeRequestId);
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

        const allowedTools = Array.isArray(payload.allowedTools ?? payload.allowTools)
            ? [...(payload.allowedTools ?? payload.allowTools)!]
            : undefined;
        const resolvedMode = typeof payload.mode === 'string'
            ? (normalizePermissionModeToIntent(payload.mode) ?? payload.mode)
            : undefined;

        let shouldApplySideEffects = false;
        const handled = this.permissionCoordinator.handleResponse({
            requestId,
            buildCompletion: (context) => {
                const updatedPermissions = payload.updatedPermissions;
                const hookResponse = this.buildHookResponse({
                    payload,
                    toolName: context.toolName,
                    toolInput: context.toolInput,
                    updatedPermissions,
                });
                shouldApplySideEffects = true;

                return {
                    result: hookResponse,
                    completedRequest: {
                        status: payload.approved ? 'approved' : 'denied',
                        reason: payload.reason,
                        mode: resolvedMode,
                        allowedTools,
                        updatedPermissions,
                    },
                };
            },
        });

        if (!handled) return false;

        this.pendingRequests.delete(requestId);
        if (shouldApplySideEffects) {
            this.applyPermissionRpcState(payload, { allowedTools, resolvedMode, excludeRequestId: requestId });
        }
        return true;
    }

    private buildHookResponse(params: {
        payload: PermissionRpcPayload;
        toolName: string;
        toolInput: unknown;
        updatedPermissions: unknown;
    }): PermissionHookResponse {
        const { payload, toolName, toolInput, updatedPermissions } = params;
        if (payload.approved) {
            return {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: {
                        behavior: 'allow',
                        ...(
                            (toolName === 'AskUserQuestion' || toolName === 'ask_user_question')
                            && payload.answers
                            && typeof payload.answers === 'object'
                            && !Array.isArray(payload.answers)
                                ? {
                                    updatedInput: {
                                        ...(toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
                                            ? toolInput as Record<string, unknown>
                                            : {}),
                                        answers: payload.answers,
                                    },
                                }
                                : {}
                        ),
                        ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
                    },
                },
            };
        }

        return {
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
            this.applyPermissionModeFromRpc(params.resolvedMode, params.excludeRequestId);
        }

        if (payload.approved) {
            this.tryAutoCompletePendingRequests(params.excludeRequestId);
        }
    }

    private readLocalOutstandingRequest(requestId: string) {
        const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
        const requests = snapshot?.requests;
        const request = requests && typeof requests === 'object' ? (requests as Record<string, unknown>)[requestId] : null;
        if (!isClaudeLocalPermissionBridgeAgentStateRequest(request)) return null;
        return this.requestStore.readOutstandingRequest(requestId);
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
        const handledByCoordinator = this.permissionCoordinator.handleResponse({
            requestId: params.requestId,
            buildCompletion: () => ({
                result: params.hookResponse,
                completedRequest: {
                    status: params.status,
                    reason: params.reason,
                    mode: params.mode,
                    allowedTools: params.allowedTools,
                    updatedPermissions: params.updatedPermissions,
                },
            }),
        });

        this.pendingRequests.delete(params.requestId);

        if (!handledByCoordinator) {
            this.requestStore.completeRequest({
                requestId: params.requestId,
                status: params.status,
                reason: params.reason,
                mode: params.mode,
                allowedTools: params.allowedTools,
                updatedPermissions: params.updatedPermissions,
                fallback: {
                    toolName: params.toolName,
                    toolInput: params.toolInput,
                    createdAt: params.createdAt,
                    kind: resolveAgentRequestKind(params.toolName),
                    source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                },
            });
        }
    }

    private cancelLocalOutstandingRequests(reason: string): void {
        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const now = Date.now();

                for (const [id, request] of Object.entries(requests)) {
                    if (!isClaudeLocalPermissionBridgeAgentStateRequest(request)) continue;
                    delete requests[id];
                    const completedEntry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                    completedEntry.completedAt = now;
                    completedEntry.status = 'canceled';
                    completedEntry.reason = reason;
                    completedRequests[id] = completedEntry;
                    this.requestStore.markPermissionRequestCompletedBestEffort(id);
                }

                return {
                    ...currentState,
                    requests,
                    completedRequests,
                };
            },
            '[claude-local-permissions]',
            'cancel_local_requests',
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
