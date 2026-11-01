import type { AgentState, PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { randomUUID } from 'node:crypto';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createPermissionRequestCoordinator } from '@/agent/permissions/permissionRequestCoordinator';
import type { PermissionRequestCoordinatorContext, PermissionRequestCoordinatorStore } from '@/agent/permissions/permissionRequestCoordinator';

import type { Session } from '../session';
import type { PermissionHookData, PermissionHookResponse, SessionHookData } from '../utils/startHookServer';
import type { PermissionRpcConsumerOutcome } from '../utils/permissionRpcRouter';
import { buildClaudePermissionHookResponse } from '../utils/buildClaudePermissionHookResponse';
import { mapToClaudeMode } from '../utils/permissionMode';
import { deepEqual } from '@/utils/deterministicJson';
import type { PermissionRpcPayload } from '../utils/permissionRpc';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist, seedAllowlistFromCompletedRequests } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import { normalizePermissionModeToIntent } from '@/agent/runtime/permission/permissionModeCanonical';
import { waitForSessionMetadataRetryBackoff } from '@/agent/runtime/sessionMetadataWaitRetryBackoff';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import {
    isSafeFirstPartyHappierActionToolCall,
} from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
    isClaudeLocalPermissionBridgeAgentStateRequest,
} from '@happier-dev/agents';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';
import { isAskUserQuestionToolName } from '@happier-dev/protocol';
import { normalizeClaudeAskUserQuestionInputForPublication } from '../utils/normalizeClaudeAskUserQuestionInput';
import { buildAskUserQuestionAnswersForClaude } from '../utils/askUserQuestionAnswersForClaude';
import {
    normalizeLegacyStructuredQuestionAnswers,
    normalizeStructuredQuestionAnswersV1,
    type StructuredQuestionLike,
} from '@/agent/questions/normalizeStructuredQuestionAnswersV1';
import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';
import { resolveClaudePermissionHookTimeoutMs } from '../utils/permissionHookTimeout';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { clearClaudePlanModeMetadataBestEffort } from '../utils/clearPlanModeMetadataBestEffort';
import { getToolDescriptor } from '../utils/getToolDescriptor';
import { readClaudeToolResultPermissionApproval } from '../utils/claudeToolResultPermission';
import { isClaudeSidechainRuntimeEvidence, readSessionHookSidechainAgentId } from '../utils/sessionHookAttribution';

export { DEFAULT_PROVIDER_HOOK_CEILING_MS } from '../utils/permissionHookTimeout';

type PendingPermissionRequest = {
    id: string;
    toolName: string;
    toolInput: unknown;
    hookEventName: ClaudePermissionHookEventName;
    sidechainAgentId: string | null;
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
    agent_id?: unknown;
    agentId?: unknown;
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
    private disposed = false;

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
        void this.requestStore.cancelAllRequests({
            reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            shouldCancel: isClaudeLocalPermissionBridgeAgentStateRequest,
        }).catch(() => undefined); // The store reports admission failures on the default file log.
    }

    dispose(): void {
        this.disposed = true;
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

        const requests = this.session.client.getAgentStateSnapshot?.()?.requests ?? {};
        const stateOnlyRequestIds = Object.keys(requests).filter((requestId) => (
            this.permissionCoordinator.getResponseContext(requestId)?.correlation === 'agent_state'
        ));
        if (stateOnlyRequestIds.length > 0) {
            void this.requestStore.cancelAllRequests({
                reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                requestIds: stateOnlyRequestIds,
                shouldCancel: isClaudeLocalPermissionBridgeAgentStateRequest,
            }).catch(() => undefined); // The store reports admission failures on the default file log.
        }
        const settlements = [...this.pendingRequests.values()].map(async (pending) => {
            const context = this.permissionCoordinator.getResponseContext(pending.id);
            if (!context) return;
            await this.permissionCoordinator.completeCancellationResponse({
                context, result: DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE,
                reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
            });
        });
        void Promise.allSettled(settlements).then((results) => {
            this.localWaitersByRequestId.clear();
            this.requestStore.dispose();
            if (results.some((result) => result.status === 'rejected')) {
                // Failed cancellation retains the coordinator's detached occurrence for
                // another retirement attempt; its local hook has already been rejected.
                logger.infoFile('[claude-local-permissions] Disposal request settlement admission failed');
                return;
            }
            this.pendingRequests.clear();
            this.permissionCoordinator.dispose();
        });
    }

    async handlePermissionHook(data: PermissionHookData, options?: Readonly<{ signal?: AbortSignal }>): Promise<PermissionHookResponse> {
        if (this.disposed || options?.signal?.aborted) return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
        this.syncPermissionModeFromMetadataSnapshot();
        const hookRequestId = this.resolveRequestId(data);
        const inferredRequestId = !hookRequestId ? await this.session.claudeToolHookCorrelation.resolvePermissionRequestId(data, {
            sessionId: this.session.sessionId, transcriptPath: this.session.transcriptPath,
        }) : null;
        if (this.disposed || options?.signal?.aborted) return DEFAULT_LOCAL_PERMISSION_HOOK_RESPONSE;
        const requestId = hookRequestId ?? inferredRequestId ?? this.generateRequestId();

        if (!hookRequestId && inferredRequestId) {
            logger.debug(`[claude-local-permissions] Permission hook missing tool_use_id; correlated ${inferredRequestId}`);
        } else if (!hookRequestId) {
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
            && isSafeFirstPartyHappierActionToolCall({ toolName, input: toolInput })
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
                sidechainAgentId: readSessionHookSidechainAgentId(data),
                createdAt,
                expiresAt: this.computeProviderHookExpiry(createdAt),
            });
        }

        const coordinatorToolInput = normalizeClaudeAskUserQuestionInputForPublication(toolName, toolInput);
        const waiter = this.createLocalWaiter({
            requestId,
            toolName,
            toolInput: coordinatorToolInput,
            createdAt,
            transportSignal: options?.signal,
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
            async (error) => {
                const remaining = this.finishLocalWaiter(requestId, waiter.id);
                if (waiter.wasTimedOut() || options?.signal?.aborted) {
                    if (remaining === 0) {
                        const context = this.permissionCoordinator.getResponseContext(requestId);
                        if (context) await this.expireRequestByContext(context, waiter.wasTimedOut()
                            ? PERMISSION_TIMED_OUT_REASON
                            : 'Provider hook transport closed before a response was delivered');
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
            observedCompletion: true,
            hookResponse: this.buildAllowHookResponse({
                hookEventName: pending.hookEventName,
                toolInput: pending.toolInput,
            }),
        });
    }

    observeTranscript(value: unknown): void {
        if (this.disposed || !value || typeof value !== 'object' || Array.isArray(value)) return;
        const row = value as Record<string, unknown>;
        if (row.type !== 'user' || isClaudeSidechainRuntimeEvidence(row) || typeof this.session.sessionId !== 'string'
            || (row.sessionId ?? row.session_id) !== this.session.sessionId) return;
        const approved = readClaudeToolResultPermissionApproval(row);
        if (approved === null) return;
        const message = row.message;
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const content = (message as Record<string, unknown>).content;
        if (!Array.isArray(content)) return;
        for (const value of content) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const block = value as Record<string, unknown>;
            if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
            const pending = this.pendingRequests.get(block.tool_use_id);
            if (!pending) continue;
            this.completeRequest({
                requestId: pending.id,
                toolName: pending.toolName,
                toolInput: pending.toolInput,
                createdAt: pending.createdAt,
                status: approved ? 'approved' : 'denied',
                reason: approved ? 'Approved in Claude terminal' : 'Denied in Claude terminal',
                observedCompletion: true,
                hookResponse: approved
                    ? this.buildAllowHookResponse({ hookEventName: pending.hookEventName, toolInput: pending.toolInput })
                    : this.buildDefaultHookResponse(pending.hookEventName),
            });
        }
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
        return buildClaudePermissionHookResponse({
            hookEventName: params.hookEventName,
            toolInput: params.toolInput,
            decision: {
                behavior: 'allow',
                updatedInput: params.updatedInput,
                updatedPermissions: params.updatedPermissions,
            },
        });
    }

    private buildDenyHookResponse(params: {
        hookEventName: ClaudePermissionHookEventName;
        reason?: string;
    }): PermissionHookResponse {
        return buildClaudePermissionHookResponse({
            hookEventName: params.hookEventName,
            toolInput: undefined,
            decision: { behavior: 'deny', message: params.reason },
        });
    }

    private computePolicyDecision(toolName: string): 'prompt' | 'allow' | 'deny' {
        if (isChangeTitleToolLikeName(toolName)) return 'allow';
        const mode = this.permissionMode;
        if (mode === 'yolo') return 'allow';
        if (mode === 'safe-yolo') {
            // Claude's Auto classifier owns this decision. PermissionRequest hooks only arrive
            // after Claude leaves a tool unresolved, so reclassifying it here would bypass Auto.
            return 'prompt';
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
                return this.requestStore.completeRequest(params);
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
        transportSignal?: AbortSignal;
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
            signal: params.transportSignal
                ? AbortSignal.any([controller.signal, params.transportSignal])
                : controller.signal,
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
        const sidechainAgentId = readSessionHookSidechainAgentId({ agent_id: data.agent_id, agentId: data.agentId });
        let match: ResolvedPendingPermissionRequest | null = null;
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            if (!requestId.startsWith(GENERATED_PERMISSION_REQUEST_ID_PREFIX)) continue;
            if (pending.sidechainAgentId !== sidechainAgentId) continue;
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

    private async tryHandlePermissionRpc(payload: PermissionRpcPayload): Promise<PermissionRpcConsumerOutcome> {
        const requestId = typeof payload?.id === 'string' ? payload.id : '';
        if (!requestId) {
            return false;
        }
        if (payload.occurrenceId !== undefined
            && !this.permissionCoordinator.getResponseContext(requestId, payload.occurrenceId)) return false;

        const pending = this.pendingRequests.get(requestId);
        if (pending && this.isProviderHookExpired(pending)) {
            await this.expirePendingRequest(pending);
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
                await this.expireRequestByContext(context);
                return { status: 'expired' };
            }
        }

        const hasStructuredAnswers = payload.answers !== undefined || payload.structuredAnswersV1 !== undefined;
        const structuredContext = hasStructuredAnswers
            ? this.permissionCoordinator.getLocallyOwnedLiveResponseContext(requestId, payload.occurrenceId)
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

        const context = this.permissionCoordinator.getResponseContext(requestId);
        if (!context) return false;
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
        const handled = await this.permissionCoordinator.completeRpcResponse({
            context,
            expectedOccurrenceId: payload.occurrenceId,
            completion: {
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
            },
            onAdmitted: () => {
                this.pendingRequests.delete(requestId);
                this.applyPermissionRpcState(normalizedPayload, {
                    allowedTools,
                    resolvedMode,
                    excludeRequestId: requestId,
                    toolName: context.toolName,
                });
            },
        });

        if (!handled) return false;
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
        if (params.payload.approved && getToolDescriptor(params.toolName).exitPlan) {
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

    private async expirePendingRequest(pending: PendingPermissionRequest): Promise<void> {
        const context = this.permissionCoordinator.getResponseContext(pending.id);
        if (context) await this.expireRequestByContext(context);
    }

    /**
     * Expire a request whose bridge-local `pendingRequests` entry is already gone but which is still
     * outstanding in the coordinator/agent_state. Finalizes it `canceled` (provider hook timeout) so a
     * late answer is never approved into a dead socket. Mirrors `expirePendingRequest` but resolves the
     * tool facts and hook-event shape from the coordinator response context.
     */
    private async expireRequestByContext(
        context: PermissionRequestCoordinatorContext,
        reason = PERMISSION_EXPIRED_REASON,
    ): Promise<void> {
        const hookEventName = this.pendingRequests.get(context.requestId)?.hookEventName ?? 'PermissionRequest';
        const handled = await this.permissionCoordinator.completeCancellationResponse({
            context,
            result: this.buildDefaultHookResponse(hookEventName),
            reason,
        });
        if (handled) this.pendingRequests.delete(context.requestId);
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
            getToolDescriptor(toolName).exitPlan
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

        if (payload.approved && typeof params.toolName === 'string' && getToolDescriptor(params.toolName).exitPlan) {
            // Exiting plan mode clears Happier's plan-mode metadata; the follow-up permission mode is applied
            // through the hook response's `updatedPermissions` setMode, not TUI keystrokes.
            clearClaudePlanModeMetadataBestEffort(this.session.client, '[claude-local-permissions]');
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
        observedCompletion?: true;
    }): void {
        if (this.requestStore.isOutstandingRequestClaimed(params.requestId)) return;
        if (params.observedCompletion && params.status === 'approved' && getToolDescriptor(params.toolName).exitPlan) {
            clearClaudePlanModeMetadataBestEffort(this.session.client, '[claude-local-permissions]');
        }
        const handledByCoordinator = this.permissionCoordinator.handleResponse({
            requestId: params.requestId,
            observedCompletion: params.observedCompletion,
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

        if (!handledByCoordinator) {
            void this.requestStore.recordCompletedRequest({
                requestId: params.requestId,
                toolName: params.toolName,
                toolInput: params.toolInput,
                createdAt: params.createdAt,
                kind: resolveAgentRequestKind(params.toolName),
                source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                status: params.status,
                reason: params.reason,
                allowedTools: params.allowedTools,
                updatedPermissions: params.updatedPermissions,
                extraCompletedFields: typeof params.mode === 'string' ? { mode: params.mode } : null,
            });
        }
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
