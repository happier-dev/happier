import type { AgentState, Metadata, PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { randomUUID } from 'node:crypto';
import { open as openFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { clonePlainObjectToNullProto, cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { AgentStateRequestStore, hasPermissionResponseClaimV1 } from '@/agent/permissions/agentStateRequestStore';
import { createPermissionRequestCoordinator } from '@/agent/permissions/permissionRequestCoordinator';
import type { PermissionRequestCoordinatorStore } from '@/agent/permissions/permissionRequestCoordinator';

import type { Session } from '../session';
import type { PermissionHookData, PermissionHookResponse, SessionHookData } from '../utils/startHookServer';
import type { PermissionRpcConsumerOutcome } from '../utils/permissionRpcRouter';
import { mapToClaudeMode } from '../utils/permissionMode';
import { deepEqual } from '@/utils/deterministicJson';
import type { PermissionRpcPayload } from '../utils/permissionRpc';
import { computeNextMetadataStringOverrideV1, SESSION_MODE_OVERRIDE_KEY } from '@happier-dev/agents';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist, seedAllowlistFromCompletedRequests } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import { shouldSuppressProviderPermissionForHappierApproval } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
    isClaudeLocalPermissionBridgeAgentStateRequest,
} from '@happier-dev/agents';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';
import { isAskUserQuestionToolName } from '@happier-dev/protocol';
import { withAskUserQuestionUiFreeformDefault } from './askUserQuestionFreeformDefault';
import { buildAskUserQuestionAnswersForClaude } from '../utils/askUserQuestionAnswersForClaude';
import {
    normalizeLegacyStructuredQuestionAnswers,
    normalizeStructuredQuestionAnswersV1,
    type StructuredQuestionLike,
} from '@/agent/questions/normalizeStructuredQuestionAnswersV1';
import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';
import { resolveClaudePermissionHookTimeoutMs } from '../utils/permissionHookTimeout';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export { DEFAULT_PROVIDER_HOOK_CEILING_MS } from '../utils/permissionHookTimeout';

type PendingPermissionRequest = {
    id: string;
    toolName: string;
    toolInput: unknown;
    hookEventName: ClaudePermissionHookEventName;
    createdAt: number;
    /**
     * Wall-clock time after which the provider hook forwarder is assumed dead (Claude killed it once its
     * command `timeout` elapsed). A late UI answer past this point cannot reach Claude, so it is reported
     * as a typed expired result rather than a false success. `null` when no finite bridge timeout is set.
     */
    expiresAt: number | null;
};

type ResolvedPendingPermissionRequest = {
    requestId: string;
    pending: PendingPermissionRequest;
};

type CompletionStatus = 'approved' | 'denied' | 'canceled';
type ClaudePermissionHookEventName = 'PermissionRequest' | 'PreToolUse';
type ClaudeToolHookData = Readonly<{
    hook_event_name?: unknown;
    hookEventName?: unknown;
    tool_use_id?: unknown;
    toolUseId?: unknown;
    tool_name?: unknown;
    toolName?: unknown;
    tool_input?: unknown;
    toolInput?: unknown;
    permission_suggestions?: unknown;
    permissionSuggestions?: unknown;
    permissionSuggestionsV1?: unknown;
}>;

const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const PERMISSION_TIMED_OUT_REASON = 'Timed out waiting for permission response';
const PERMISSION_EXPIRED_REASON = 'Provider hook timeout elapsed before a response was delivered';
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
const GENERATED_PERMISSION_REQUEST_ID_PREFIX = 'perm_';

export const DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE = {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
    },
} as const satisfies PermissionHookResponse;

function readPermissionHookEventName(data: PermissionHookData): ClaudePermissionHookEventName {
    const raw = data.hook_event_name ?? data.hookEventName;
    return raw === 'PreToolUse' ? 'PreToolUse' : 'PermissionRequest';
}

export class ClaudeLocalPermissionBridge {
    private readonly session: Session;
    private readonly responseTimeoutMs: number | null;
    private readonly providerHookCeilingMs: number;
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

    constructor(session: Session, opts?: { responseTimeoutMs?: number | null; providerHookCeilingMs?: number }) {
        this.session = session;
        if (opts?.responseTimeoutMs === null) {
            this.responseTimeoutMs = null;
        } else if (typeof opts?.responseTimeoutMs === 'number' && Number.isFinite(opts.responseTimeoutMs) && opts.responseTimeoutMs > 0) {
            this.responseTimeoutMs = opts.responseTimeoutMs;
        } else {
            this.responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS;
        }
        // The provider hook ceiling is the wall-clock point past which Claude has killed the hook forwarder,
        // so a late answer can no longer be delivered. It is decoupled from `responseTimeoutMs`: when an
        // explicit ceiling is provided it wins, otherwise it tracks any finite response timeout (they are
        // aligned by runtime config), and finally falls back to the provider default. This guarantees an
        // expiry safety-net even in wait-indefinitely mode where `responseTimeoutMs` is null.
        if (typeof opts?.providerHookCeilingMs === 'number' && Number.isFinite(opts.providerHookCeilingMs) && opts.providerHookCeilingMs > 0) {
            this.providerHookCeilingMs = opts.providerHookCeilingMs;
        } else if (typeof this.responseTimeoutMs === 'number') {
            this.providerHookCeilingMs = this.responseTimeoutMs;
        } else {
            // Wait-indefinitely mode (no finite response timeout): use the env-overridable default, kept
            // aligned with the installed hook `timeout` so expiry only fires on a genuinely-dead forwarder.
            this.providerHookCeilingMs = resolveClaudePermissionHookTimeoutMs();
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
        this.retireStaleSourceOwnedRequests();
        this.session.getOrCreatePermissionRpcRouter().registerConsumer({
            name: 'claude-local-permission-bridge',
            tryHandlePermissionRpc: (payload) => this.tryHandlePermissionRpc(payload),
        });
        this.seedAllowlistFromAgentState();
        this.syncPermissionModeFromMetadataSnapshot();
        this.startMetadataWatcher();
    }

    private retireStaleSourceOwnedRequests(): void {
        const requests = this.session.client.getAgentStateSnapshot?.()?.requests ?? {};
        for (const [requestId, request] of Object.entries(requests)) {
            if (!isClaudeLocalPermissionBridgeAgentStateRequest(request)) continue;
            void this.requestStore.completeRequest({
                requestId,
                status: 'canceled',
                reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            });
        }
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
                reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                hookResponse: DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
            });
            this.permissionCoordinator.cancelRequest(pending.id, CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON);
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
        const toolInput = normalizeAskUserQuestionInputForPublication(
            toolName,
            this.resolveToolInput(data),
        );
        const permissionSuggestions = this.resolvePermissionSuggestions(data);
        const existing = this.pendingRequests.get(requestId);
        const hookEventName = existing?.hookEventName ?? readPermissionHookEventName(data);
        const createdAt = existing?.createdAt ?? Date.now();

        if (this.requestStore.isOutstandingRequestClaimed(requestId)) {
            throw new Error(`Permission request ${requestId} is reserved by a newer runtime`);
        }

        // If we already have an allowlist rule for this tool call, respond immediately without surfacing a prompt.
        // This mirrors Claude Code's "don't ask again" behavior, but is enforced by Happier for reliability.
        if (!this.isInteractiveTool(toolName) && isToolAllowedForSession(this.allowedToolIdentifiers, toolName, toolInput)) {
            return this.buildAllowHookResponse({ hookEventName, toolInput });
        }

        const policyDecision = this.computePolicyDecision(toolName);
        if (
            !this.isInteractiveTool(toolName)
            && policyDecision !== 'deny'
            && shouldSuppressProviderPermissionForHappierApproval({
                toolName,
                input: toolInput,
                accountSettings: this.session.accountSettings ?? null,
                surface: 'session_agent',
            }).suppress
        ) {
            const hookResponse = this.buildAllowHookResponse({ hookEventName, toolInput });
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
        if (!this.isInteractiveTool(toolName) && policyDecision === 'allow') {
            const hookResponse = this.buildAllowHookResponse({ hookEventName, toolInput });
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
            const hookResponse = this.buildDenyHookResponse({ hookEventName });
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
                hookEventName,
                createdAt,
                expiresAt: this.computeProviderHookExpiry(createdAt),
            });
        }

        const coordinatorToolInput = withAskUserQuestionUiFreeformDefault(toolName, toolInput);
        const waiter = this.createLocalWaiter({
            requestId,
            toolName,
            toolInput: coordinatorToolInput,
            createdAt,
        });

        const coordinatorDecision = this.permissionCoordinator.requestDecision({
            requestId,
            toolName,
            toolInput: coordinatorToolInput,
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
                            hookResponse: this.buildDefaultHookResponse(hookEventName),
                        });
                        this.permissionCoordinator.cancelRequest(requestId, PERMISSION_TIMED_OUT_REASON);
                    }
                    return this.buildDefaultHookResponse(hookEventName);
                }
                throw error;
            },
        );
    }

    handleSessionHook(data: SessionHookData): void {
        const hookEventName = data.hook_event_name ?? data.hookEventName;
        if (hookEventName !== 'PostToolUse') return;

        const resolvedPending = this.resolvePendingRequestForToolHook(data);
        if (!resolvedPending) return;
        const { requestId, pending } = resolvedPending;

        this.completeRequest({
            requestId,
            toolName: pending.toolName,
            toolInput: pending.toolInput,
            createdAt: pending.createdAt,
            status: 'approved',
            reason: 'Approved in Claude terminal',
            hookResponse: this.buildAllowHookResponse({
                hookEventName: pending.hookEventName,
                toolInput: pending.toolInput,
            }),
        });
    }

    private buildDefaultHookResponse(hookEventName: ClaudePermissionHookEventName): PermissionHookResponse {
        return {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: { hookEventName },
        };
    }

    private buildAllowHookResponse(params: {
        hookEventName: ClaudePermissionHookEventName;
        toolInput: unknown;
        updatedInput?: Record<string, unknown>;
        updatedPermissions?: unknown;
    }): PermissionHookResponse {
        if (params.hookEventName === 'PreToolUse') {
            const baseUpdatedInput =
                params.updatedInput
                ?? (params.toolInput && typeof params.toolInput === 'object' && !Array.isArray(params.toolInput)
                    ? params.toolInput as Record<string, unknown>
                    : undefined);
            return {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    ...(baseUpdatedInput ? { updatedInput: baseUpdatedInput } : {}),
                },
            };
        }

        return {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'allow',
                    ...(params.updatedInput ? { updatedInput: params.updatedInput } : {}),
                    ...(typeof params.updatedPermissions !== 'undefined' ? { updatedPermissions: params.updatedPermissions } : {}),
                },
            },
        };
    }

    private buildDenyHookResponse(params: {
        hookEventName: ClaudePermissionHookEventName;
        reason?: string;
    }): PermissionHookResponse {
        if (params.hookEventName === 'PreToolUse') {
            return {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    ...(typeof params.reason === 'string' && params.reason.length > 0
                        ? { permissionDecisionReason: params.reason }
                        : {}),
                },
                ...(typeof params.reason === 'string' && params.reason.length > 0
                    ? { systemMessage: params.reason }
                    : {}),
            };
        }

        return {
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: {
                hookEventName: 'PermissionRequest',
                decision: {
                    behavior: 'deny',
                    ...(typeof params.reason === 'string' && params.reason.length > 0 ? { message: params.reason } : {}),
                },
            },
            ...(typeof params.reason === 'string' && params.reason.length > 0
                ? { systemMessage: params.reason }
                : {}),
        };
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
                    source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                    updateState: (state) => ({
                        ...state,
                        capabilities: {
                            ...(state.capabilities ?? {}),
                            askUserQuestionAnswersInPermission: true,
                            structuredQuestionAnswersV1Supported: true,
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
            isOutstandingRequestClaimed: (requestId) => {
                const rawRequest = this.session.client.getAgentStateSnapshot?.()?.requests?.[requestId] ?? null;
                return isClaudeLocalPermissionBridgeAgentStateRequest(rawRequest)
                    && this.requestStore.isOutstandingRequestClaimed(requestId);
            },
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
            await waitForSessionMetadataRetryBackoff({ abortSignal: signal });
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
            const hookResponse = this.buildAllowHookResponse({
                hookEventName: pending.hookEventName,
                toolInput: pending.toolInput,
            });
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
            const hookResponse = this.buildDenyHookResponse({ hookEventName: pending.hookEventName });
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
        return `${GENERATED_PERMISSION_REQUEST_ID_PREFIX}${randomUUID()}`;
    }

    private resolvePendingRequestForToolHook(data: ClaudeToolHookData): ResolvedPendingPermissionRequest | null {
        const requestId = this.resolveRequestId(data);
        if (requestId) {
            const pending = this.pendingRequests.get(requestId);
            if (pending) {
                return this.matchesPendingToolHook(data, pending) ? { requestId, pending } : null;
            }
        }

        return this.resolveGeneratedPendingRequestByToolFacts(data);
    }

    private resolveGeneratedPendingRequestByToolFacts(data: ClaudeToolHookData): ResolvedPendingPermissionRequest | null {
        const toolName = this.resolveToolName(data);
        if (toolName === 'unknown_tool' || !this.hasToolInput(data)) return null;

        const toolInput = this.resolveToolInput(data);
        let match: ResolvedPendingPermissionRequest | null = null;
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            if (!requestId.startsWith(GENERATED_PERMISSION_REQUEST_ID_PREFIX)) continue;
            if (pending.toolName !== toolName) continue;
            if (!deepEqual(pending.toolInput, toolInput)) continue;
            if (match) return null;
            match = { requestId, pending };
        }

        return match;
    }

    private matchesPendingToolHook(data: ClaudeToolHookData, pending: PendingPermissionRequest): boolean {
        const toolName = this.resolveToolName(data);
        if (toolName !== 'unknown_tool' && toolName !== pending.toolName) return false;
        if (this.hasToolInput(data) && !deepEqual(this.resolveToolInput(data), pending.toolInput)) return false;
        return true;
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

    private tryHandlePermissionRpc(payload: PermissionRpcPayload): PermissionRpcConsumerOutcome {
        const requestId = typeof payload?.id === 'string' ? payload.id : '';
        if (!requestId) {
            return false;
        }

        const pending = this.pendingRequests.get(requestId);
        if (pending && this.isProviderHookExpired(pending)) {
            this.expirePendingRequest(pending);
            return { status: 'expired' };
        }

        // The bridge's own `pendingRequests` entry can be gone while the request still lives in the
        // coordinator (detached) or only in agent_state — e.g. wait-indefinitely mode (no Happier waiter
        // ever deletes it) or after the hook forwarder died externally. In that case `pending` is absent,
        // so the check above cannot fire. Enforce the provider hook ceiling from the request's recorded
        // `createdAt` so a past-ceiling answer is never approved into a dead socket.
        if (!pending) {
            const context = this.permissionCoordinator.getResponseContext(requestId);
            if (context && this.isProviderHookCeilingExceeded(context.createdAt)) {
                this.expireRequestByContext(context);
                return { status: 'expired' };
            }
        }

        const hasStructuredAnswers = payload.answers !== undefined || payload.structuredAnswersV1 !== undefined;
        const structuredContext = hasStructuredAnswers
            ? this.permissionCoordinator.getLocallyOwnedLiveResponseContext(requestId)
            : null;
        const isAskUserQuestion = isAskUserQuestionToolName(pending?.toolName);
        if (hasStructuredAnswers && (!pending || !structuredContext || !isAskUserQuestion)) return false;
        const structuredAnswersV1 = hasStructuredAnswers && structuredContext
            ? payload.structuredAnswersV1 !== undefined
                ? normalizeStructuredQuestionAnswersV1(
                    payload.structuredAnswersV1,
                    this.readStructuredQuestions(structuredContext.toolInput),
                )
                : normalizeLegacyStructuredQuestionAnswers({
                    answers: payload.answers!,
                    questions: this.readStructuredQuestions(structuredContext.toolInput),
                })
            : undefined;
        const normalizedPayload = structuredAnswersV1 ? { ...payload, structuredAnswersV1 } : payload;

        const allowedTools = Array.isArray(payload.allowedTools ?? payload.allowTools)
            ? [...(payload.allowedTools ?? payload.allowTools)!]
            : undefined;
        const resolvedMode = typeof payload.mode === 'string'
            ? (normalizePermissionModeToIntent(payload.mode) ?? payload.mode)
            : undefined;

        let shouldApplySideEffects = false;
        let resolvedToolName: string | null = null;
        const handled = this.permissionCoordinator.handleResponse({
            requestId,
            buildCompletion: (context) => {
                resolvedToolName = context.toolName;
                const updatedPermissions = this.resolveResponseUpdatedPermissions({
                    payload: normalizedPayload,
                    toolName: context.toolName,
                    resolvedMode,
                });
                const hookResponse = this.buildHookResponse({
                    payload: normalizedPayload,
                    toolName: context.toolName,
                    toolInput: this.pendingRequests.get(requestId)?.toolInput ?? context.toolInput,
                    updatedPermissions,
                    hookEventName: this.pendingRequests.get(requestId)?.hookEventName ?? 'PermissionRequest',
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
                        ...(normalizedPayload.structuredAnswersV1
                            ? { extraCompletedFields: { structuredAnswersV1: normalizedPayload.structuredAnswersV1 } }
                            : {}),
                    },
                };
            },
        });

        if (!handled) return false;

        this.pendingRequests.delete(requestId);
        if (shouldApplySideEffects) {
            this.applyPermissionRpcState(normalizedPayload, {
                allowedTools,
                resolvedMode,
                excludeRequestId: requestId,
                toolName: resolvedToolName,
            });
        }
        return true;
    }

    private readStructuredQuestions(toolInput: unknown): readonly StructuredQuestionLike[] {
        if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return [];
        const questions = (toolInput as { questions?: unknown }).questions;
        return Array.isArray(questions) ? questions as readonly StructuredQuestionLike[] : [];
    }

    /**
     * Resolve the `updatedPermissions` to send back to Claude for a response.
     *
     * For an approved ExitPlanMode answer with no caller-provided `updatedPermissions`, synthesize a
     * `setMode` update so Claude applies the follow-up permission mode through the hook channel instead of
     * TUI keystrokes. A caller-provided `updatedPermissions` is always respected as-is.
     */
    private resolveResponseUpdatedPermissions(params: {
        payload: PermissionRpcPayload;
        toolName: string;
        resolvedMode: PermissionMode | string | undefined;
    }): unknown {
        if (typeof params.payload.updatedPermissions !== 'undefined') {
            return params.payload.updatedPermissions;
        }
        if (params.payload.approved && this.isExitPlanModeTool(params.toolName)) {
            const followupMode = mapToClaudeMode(this.resolveFollowupPermissionMode(params.resolvedMode));
            return [{ type: 'setMode', mode: followupMode }];
        }
        return undefined;
    }

    private resolveFollowupPermissionMode(resolvedMode: PermissionMode | string | undefined): PermissionMode {
        const canonical = typeof resolvedMode === 'string'
            ? normalizePermissionModeToIntent(resolvedMode)
            : null;
        return canonical ?? 'default';
    }

    private isExitPlanModeTool(toolName: string): boolean {
        return toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode';
    }

    private computeProviderHookExpiry(createdAt: number): number {
        // Always finite: the provider hook ceiling applies even when there is no Happier waiter
        // (wait-indefinitely mode). Claude kills the forwarder at its installed hook timeout regardless.
        return createdAt + this.providerHookCeilingMs;
    }

    private isProviderHookExpired(pending: PendingPermissionRequest): boolean {
        return typeof pending.expiresAt === 'number' && Date.now() > pending.expiresAt;
    }

    private isProviderHookCeilingExceeded(createdAt: number): boolean {
        return Date.now() > this.computeProviderHookExpiry(createdAt);
    }

    private expirePendingRequest(pending: PendingPermissionRequest): void {
        this.completeRequest({
            requestId: pending.id,
            toolName: pending.toolName,
            toolInput: pending.toolInput,
            createdAt: pending.createdAt,
            status: 'canceled',
            reason: PERMISSION_EXPIRED_REASON,
            hookResponse: this.buildDefaultHookResponse(pending.hookEventName),
        });
        this.permissionCoordinator.cancelRequest(pending.id, PERMISSION_EXPIRED_REASON);
    }

    /**
     * Expire a request whose bridge-local `pendingRequests` entry is already gone but which is still
     * outstanding in the coordinator/agent_state. Finalizes it `canceled` (provider hook timeout) so a
     * late answer is never approved into a dead socket. Mirrors `expirePendingRequest` but resolves the
     * tool facts and hook-event shape from the coordinator response context.
     */
    private expireRequestByContext(context: { requestId: string; toolName: string; toolInput: unknown; createdAt: number }): void {
        const hookEventName = this.pendingRequests.get(context.requestId)?.hookEventName ?? 'PermissionRequest';
        this.completeRequest({
            requestId: context.requestId,
            toolName: context.toolName,
            toolInput: context.toolInput,
            createdAt: context.createdAt,
            status: 'canceled',
            reason: PERMISSION_EXPIRED_REASON,
            hookResponse: this.buildDefaultHookResponse(hookEventName),
        });
        this.permissionCoordinator.cancelRequest(context.requestId, PERMISSION_EXPIRED_REASON);
    }

    private clearPlanModeMetadataBestEffort(): void {
        updateMetadataBestEffort(
            this.session.client,
            (metadata): Metadata =>
                computeNextMetadataStringOverrideV1({
                    metadata: cloneStringKeyedRecordToNullProto(metadata),
                    overrideKey: SESSION_MODE_OVERRIDE_KEY,
                    valueKey: 'modeId',
                    value: '',
                    updatedAt: Date.now(),
                }) as unknown as Metadata,
            '[claude-local-permissions]',
            'exit_plan_mode_clear_session_mode_override',
        );
    }

    private buildHookResponse(params: {
        payload: PermissionRpcPayload;
        toolName: string;
        toolInput: unknown;
        updatedPermissions: unknown;
        hookEventName: ClaudePermissionHookEventName;
    }): PermissionHookResponse {
        const { payload, toolName, toolInput, updatedPermissions } = params;
        if (payload.approved) {
            const updatedInput =
                isAskUserQuestionToolName(toolName)
                && payload.structuredAnswersV1
                    ? {
                        ...(toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
                            ? toolInput as Record<string, unknown>
                            : {}),
                        answers: buildAskUserQuestionAnswersForClaude(payload.structuredAnswersV1),
                    }
                    : undefined;
            return this.buildAllowHookResponse({
                hookEventName: params.hookEventName,
                toolInput,
                ...(updatedInput ? { updatedInput } : {}),
                updatedPermissions,
            });
        }

        return this.buildDenyHookResponse({
            hookEventName: params.hookEventName,
            reason: payload.reason,
        });
    }

    private isInteractiveTool(toolName: string): boolean {
        return (
            isAskUserQuestionToolName(toolName) ||
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
                hookResponse: this.buildAllowHookResponse({
                    hookEventName: pending.hookEventName,
                    toolInput: pending.toolInput,
                }),
            });
        }
    }

    private applyPermissionRpcState(
        payload: PermissionRpcPayload,
        params: { allowedTools?: string[]; resolvedMode?: PermissionMode; excludeRequestId?: string; toolName?: string | null }
    ): void {
        if (payload.approved) {
            applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, payload.updatedPermissions);
            applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, params.allowedTools);
        }

        if (payload.approved && params.resolvedMode) {
            this.applyPermissionModeFromRpc(params.resolvedMode, params.excludeRequestId);
        }

        if (payload.approved && typeof params.toolName === 'string' && this.isExitPlanModeTool(params.toolName)) {
            // Exiting plan mode clears Happier's plan-mode metadata; the follow-up permission mode is applied
            // through the hook response's `updatedPermissions` setMode, not TUI keystrokes.
            this.clearPlanModeMetadataBestEffort();
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
        if (this.requestStore.isOutstandingRequestClaimed(params.requestId)) return;
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
                    if (hasPermissionResponseClaimV1(request)) continue;
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

    private resolvePermissionSuggestions(data: ClaudeToolHookData): unknown[] | null {
        const raw = data.permission_suggestions ?? data.permissionSuggestions ?? data.permissionSuggestionsV1;
        if (!Array.isArray(raw) || raw.length === 0) {
            return null;
        }
        return raw as unknown[];
    }

    private resolveRequestId(data: ClaudeToolHookData): string | null {
        const id = data.tool_use_id ?? data.toolUseId;
        return readNonBlankOpaqueIdentifier(id);
    }

    private resolveToolName(data: ClaudeToolHookData): string {
        const toolName = data.tool_name ?? data.toolName;
        if (typeof toolName !== 'string') {
            return 'unknown_tool';
        }
        const trimmed = toolName.trim();
        return trimmed.length > 0 ? trimmed : 'unknown_tool';
    }

    private hasToolInput(data: ClaudeToolHookData): boolean {
        return typeof data.tool_input !== 'undefined' || typeof data.toolInput !== 'undefined';
    }

    private resolveToolInput(data: ClaudeToolHookData): unknown {
        if (typeof data.tool_input !== 'undefined') {
            return data.tool_input;
        }
        if (typeof data.toolInput !== 'undefined') {
            return data.toolInput;
        }
        return {};
    }
}
