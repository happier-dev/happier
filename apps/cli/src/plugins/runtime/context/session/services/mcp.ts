import { randomUUID } from 'node:crypto';

import type {
    SessionMcpElicitRequestV1,
    SessionMcpElicitResultV1,
} from '@happier-dev/agents';
import type { InteractionsService } from '@happier-dev/plugin-sdk/interactions';
import { StrictJsonValueSchema } from '@happier-dev/protocol';

import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import {
    mcpElicitationFormContent,
    mcpElicitationFormQuestions,
    parseMcpElicitationFormSchema,
} from '@/plugins/runtime/invocation/services/mcpElicitationForm';
import { readTrimmedString } from './readTrimmedString';

type SessionMcpScope = Readonly<{
    permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
}>;

export type CreateSessionScopedMcpServicesParams = Readonly<{
    owner?: PermissionRequestOwner | null;
    interactions?: InteractionsService;
    readScope: (signal?: AbortSignal) => Promise<SessionMcpScope | null>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function mapPermissionResult(value: unknown): SessionMcpElicitResultV1 {
    const decision = isRecord(value) && typeof value.decision === 'string'
        ? value.decision
        : 'denied';
    if (decision === 'approved' || decision === 'approved_for_session') {
        return Object.freeze({
            status: 'accepted',
            decision,
        });
    }
    if (decision === 'denied') {
        return Object.freeze({
            status: 'declined',
            decision: 'denied',
        });
    }
    if (decision === 'abort') {
        return Object.freeze({
            status: 'cancelled',
            decision: 'abort',
        });
    }
    if (decision === 'approved_execpolicy_amendment') {
        return Object.freeze({
            status: 'failed',
            reason: 'mcp_elicitation_effect_unsupported',
        });
    }
    return Object.freeze({
        status: 'failed',
        reason: 'mcp_elicitation_result_unrecognized',
    });
}

function hasValidMeta(meta: Readonly<Record<string, unknown>> | undefined): boolean {
    if (meta === undefined) return true;
    const parsed = StrictJsonValueSchema.safeParse(meta);
    return parsed.success && isRecord(parsed.data);
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
            if (!hasValidMeta(request.meta)) {
                return Object.freeze({
                    status: 'failed',
                    reason: 'mcp_elicitation_meta_invalid',
                });
            }
            const toolName = canonicalizeMcpToolName(request);
            if (!toolName) {
                return Object.freeze({
                    status: 'unavailable',
                    reason: 'mcp_elicitation_tool_unavailable',
                });
            }
            if (request.schema !== undefined) {
                if (!params.interactions) {
                    return Object.freeze({
                        status: 'unavailable',
                        reason: 'mcp_elicitation_interaction_unavailable',
                    });
                }
                try {
                    const schema = parseMcpElicitationFormSchema(request.schema);
                    const questions = mcpElicitationFormQuestions(schema);
                    const title = readTrimmedString(request.prompt) ?? toolName;
                    if (questions === null) {
                        const result = await params.interactions.confirm({
                            kind: 'confirmation',
                            title: 'MCP request',
                            message: title,
                        }, {
                            ...(options?.signal ? { signal: options.signal } : {}),
                        });
                        throwIfAborted(options?.signal);
                        if (result.status === 'unavailable') {
                            return Object.freeze({
                                status: 'unavailable',
                                reason: 'mcp_elicitation_interaction_unavailable',
                            });
                        }
                        return result.status === 'approved'
                            ? Object.freeze({
                                status: 'accepted' as const,
                                decision: 'approved' as const,
                                content: Object.freeze({}),
                            })
                            : result.status === 'declined'
                                ? Object.freeze({ status: 'declined' as const, decision: 'denied' as const })
                                : Object.freeze({ status: 'cancelled' as const, decision: 'abort' as const });
                    }
                    const result = await params.interactions.askQuestions({
                        kind: 'questions',
                        title,
                        questions: [...questions],
                    }, {
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                    throwIfAborted(options?.signal);
                    if (result.status === 'unavailable') {
                        return Object.freeze({
                            status: 'unavailable',
                            reason: 'mcp_elicitation_interaction_unavailable',
                        });
                    }
                    if (result.status !== 'answered') {
                        return Object.freeze({ status: 'cancelled', decision: 'abort' });
                    }
                    return Object.freeze({
                        status: 'accepted',
                        decision: 'approved',
                        content: mcpElicitationFormContent(schema, result.answers),
                    });
                } catch {
                    throwIfAborted(options?.signal);
                    return Object.freeze({
                        status: 'failed',
                        reason: 'mcp_elicitation_schema_invalid',
                    });
                }
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
                ?? `mcp-elicitation:${randomUUID()}`;
            try {
                const result = await raceWithAbort(
                    scope.permissionHandler.handleToolCall(
                        toolCallId,
                        toolName,
                        request.input,
                        {
                            ...(params.owner ? { owner: params.owner } : {}),
                            ...(options?.signal ? { signal: options.signal } : {}),
                        },
                    ),
                    options?.signal,
                );
                return mapPermissionResult(result);
            } catch {
                throwIfAborted(options?.signal);
                return Object.freeze({
                    status: 'failed',
                    reason: 'mcp_elicitation_failed',
                });
            }
        },
    });
}
