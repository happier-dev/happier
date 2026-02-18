import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { randomUUID } from 'node:crypto';
import { sendPermissionRequestPushNotificationForActiveAccount } from '@/settings/notifications/permissionRequestPush';
import { open as openFile } from 'node:fs/promises';

import type { Session } from '../session';
import type { PermissionHookData, PermissionHookResponse } from '../utils/startHookServer';
import { getToolName } from '../utils/getToolName';
import { deepEqual } from '@/utils/deterministicJson';
import type { PermissionRpcPayload } from '../utils/permissionRpc';

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
    private readonly pendingRequests = new Map<string, PendingPermissionRequest>();

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
    }

    dispose(): void {
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
    }

    async handlePermissionHook(data: PermissionHookData): Promise<PermissionHookResponse> {
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
        const createdAt = Date.now();

        this.publishPendingRequest({ requestId, toolName, toolInput, createdAt });

        let resolvePending: (response: PermissionHookResponse) => void = () => {};
        const promise = new Promise<PermissionHookResponse>((resolve) => {
            resolvePending = resolve;
        });

        const timeout = this.responseTimeoutMs === null
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
            }, this.responseTimeoutMs);
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

    private generateRequestId(): string {
        return `perm_${randomUUID()}`;
    }

    private async resolveRequestIdFromTranscript(data: PermissionHookData): Promise<string | null> {
        const transcriptPath =
            typeof data.transcript_path === 'string'
                ? data.transcript_path
                : (typeof data.transcriptPath === 'string' ? data.transcriptPath : '');
        if (!transcriptPath) {
            return null;
        }

        const toolName = this.resolveToolName(data);
        const toolInput = this.resolveToolInput(data);

        try {
            const fileHandle = await openFile(transcriptPath, 'r');
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
        if (!pending) {
            return false;
        }

        const allowedTools = Array.isArray(payload.allowedTools ?? payload.allowTools)
            ? [...(payload.allowedTools ?? payload.allowTools)!]
            : undefined;

        const hookResponse: PermissionHookResponse = payload.approved
            ? {
                continue: true,
                suppressOutput: true,
                hookSpecificOutput: {
                    hookEventName: 'PermissionRequest',
                    decision: { behavior: 'allow' },
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
            toolName: pending.toolName,
            toolInput: pending.toolInput,
            createdAt: pending.createdAt,
            status: payload.approved ? 'approved' : 'denied',
            reason: payload.reason,
            mode: payload.mode,
            allowedTools,
            hookResponse,
        });
        return true;
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
        hookResponse: PermissionHookResponse;
    }): void {
        const pending = this.pendingRequests.get(params.requestId);
        if (pending) {
            if (pending.timeout) {
                clearTimeout(pending.timeout);
            }
            this.pendingRequests.delete(params.requestId);
        }

        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const requests = {
                    ...(currentState.requests ?? {}),
                };
                const existing = requests[params.requestId];
                delete requests[params.requestId];

                const completedEntry = {
                    ...(existing ?? {
                        tool: params.toolName,
                        arguments: params.toolInput,
                        createdAt: params.createdAt,
                    }),
                    completedAt: Date.now(),
                    status: params.status,
                    ...(typeof params.reason === 'string' && params.reason.length > 0 ? { reason: params.reason } : {}),
                    ...(typeof params.mode === 'string' ? { mode: params.mode } : {}),
                    ...(Array.isArray(params.allowedTools) && params.allowedTools.length > 0
                        ? { allowedTools: params.allowedTools }
                        : {}),
                };

                return {
                    ...currentState,
                    requests,
                    completedRequests: {
                        ...(currentState.completedRequests ?? {}),
                        [params.requestId]: completedEntry,
                    },
                };
            },
            '[claude-local-permissions]',
            'complete_request',
        );

        pending?.resolve(params.hookResponse);
    }

    private publishPendingRequest(params: {
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
    }): void {
        if (this.session.pushSender) {
            try {
                sendPermissionRequestPushNotificationForActiveAccount({
                    pushSender: this.session.pushSender,
                    sessionId: this.session.client.sessionId,
                    permissionId: params.requestId,
                    toolName: getToolName(params.toolName),
                });
            } catch (error) {
                logger.debug('[claude-local-permissions] Failed to broadcast permission request', error);
            }
        }

        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => ({
                ...currentState,
                capabilities: {
                    ...(currentState.capabilities ?? {}),
                    askUserQuestionAnswersInPermission: true,
                    localPermissionBridgeInLocalMode: true,
                    permissionsInUiWhileLocal: true,
                },
                requests: {
                    ...(currentState.requests ?? {}),
                    [params.requestId]: {
                        tool: params.toolName,
                        arguments: params.toolInput,
                        createdAt: params.createdAt,
                    },
                },
            }),
            '[claude-local-permissions]',
            'publish_pending_request',
        );
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
