import type {
    SessionMcpElicitRequestV1,
    SessionMcpElicitResultV1,
} from '@happier-dev/plugin-sdk';

import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';

type SessionMcpScope = Readonly<{
    permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
}>;

export type CreateSessionScopedMcpServicesParams = Readonly<{
    owner?: PermissionRequestOwner | null;
    readScope: (signal?: AbortSignal) => Promise<SessionMcpScope | null>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function createAbortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) {
        return reason;
    }
    const error = new Error(typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim()
        : 'Session MCP elicitation was aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createAbortError(signal);
    }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return await operation;
    }
    throwIfAborted(signal);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createAbortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}

function canonicalizeMcpToolName(request: SessionMcpElicitRequestV1): string | null {
    const toolName = readTrimmedString(request.toolName);
    if (!toolName) {
        return null;
    }
    if (toolName.startsWith('mcp__')) {
        return toolName;
    }
    const serverName = readTrimmedString(request.serverName);
    if (!serverName) {
        return toolName;
    }
    return `mcp__${serverName}__${toolName}`;
}

function readContent(value: unknown): Readonly<Record<string, unknown>> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const answers = value.answers;
    if (!isRecord(answers)) {
        return undefined;
    }
    return Object.freeze({ ...answers });
}

function mapPermissionResult(value: unknown): SessionMcpElicitResultV1 {
    const decision = isRecord(value) && typeof value.decision === 'string'
        ? value.decision
        : 'denied';
    const content = readContent(value);
    if (decision === 'approved' || decision === 'approved_for_session') {
        return Object.freeze({
            status: 'accepted',
            decision,
            ...(content ? { content } : {}),
        });
    }
    if (decision === 'denied') {
        return Object.freeze({
            status: 'declined',
            decision: 'denied',
            ...(content ? { content } : {}),
        });
    }
    if (decision === 'abort') {
        return Object.freeze({
            status: 'cancelled',
            decision: 'abort',
            ...(content ? { content } : {}),
        });
    }
    if (decision === 'approved_execpolicy_amendment') {
        return Object.freeze({
            status: 'accepted',
            decision: 'approved',
            ...(content ? { content } : {}),
        });
    }
    return Object.freeze({
        status: 'failed',
        reason: 'mcp_elicitation_result_unrecognized',
        ...(content ? { content } : {}),
    });
}

export function createSessionScopedMcpServices(
    params: CreateSessionScopedMcpServicesParams,
): Readonly<{ elicit: (
    request: SessionMcpElicitRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<SessionMcpElicitResultV1> }> {
    return Object.freeze({
        async elicit(request, options) {
            throwIfAborted(options?.signal);
            const toolName = canonicalizeMcpToolName(request);
            if (!toolName) {
                return Object.freeze({
                    status: 'unavailable',
                    reason: 'mcp_elicitation_tool_unavailable',
                });
            }
            const scope = await params.readScope(options?.signal);
            if (!scope) {
                return Object.freeze({
                    status: 'unavailable',
                    reason: 'mcp_elicitation_session_unavailable',
                });
            }
            const toolCallId = readTrimmedString(request.toolCallId)
                ?? readTrimmedString(request.requestId)
                ?? 'mcp-elicitation';
            try {
                const result = await raceWithAbort(
                    scope.permissionHandler.handleToolCall(
                        toolCallId,
                        toolName,
                        request.input,
                        params.owner ? { owner: params.owner } : undefined,
                    ),
                    options?.signal,
                );
                return mapPermissionResult(result);
            } catch (error) {
                throwIfAborted(options?.signal);
                return Object.freeze({
                    status: 'failed',
                    reason: 'mcp_elicitation_failed',
                    error,
                });
            }
        },
    });
}
