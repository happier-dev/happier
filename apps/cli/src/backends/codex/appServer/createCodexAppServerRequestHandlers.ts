import { logger } from '@/ui/logger';

import { resolveApprovalChoiceLabel } from '../runtime/codexRequestUserInputBridge';
import {
    buildCodexRequestUserInputAnswers,
    looksLikeCodexApprovalRequestUserInput,
    normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput,
} from '../runtime/codexRequestUserInputQuestions';
import { canonicalizeCodexMcpToolName } from '../utils/canonicalizeCodexMcpToolName';

import {
    readRecord,
    trimStringValue,
} from './readCodexAppServerRpcFields';
import type { CodexAppServerStreamUpdate } from './streamEventBridge';

export type CodexAppServerPermissionResult = Readonly<{
    decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: Readonly<{ command: string[] }>;
    answers?: Record<string, string>;
}>;

export type CodexAppServerPermissionHandler = Readonly<{
    handleToolCall: (
        toolCallId: string,
        toolName: string,
        input: unknown,
    ) => Promise<CodexAppServerPermissionResult>;
}>;

export function createCodexAppServerRequestHandlers(params: Readonly<{
    permissionHandler?: CodexAppServerPermissionHandler | null;
    onServerRequest: (input: Readonly<{
        method: string;
        params: unknown;
    }>) => Iterable<CodexAppServerStreamUpdate>;
}>): Readonly<{
    handleServerRequest: (method: string, requestParams: unknown) => Promise<unknown>;
    handleMcpElicitationRequest: (
        requestParams: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ) => Promise<unknown>;
}> {
    const mapApprovalDecision = (
        requestKind: 'command-execution' | 'file-change',
        result: CodexAppServerPermissionResult,
    ): Readonly<Record<string, unknown>> => {
        if (requestKind === 'command-execution' && result.decision === 'approved_execpolicy_amendment') {
            const amendment = result.execPolicyAmendment?.command;
            if (Array.isArray(amendment) && amendment.length > 0) {
                return {
                    decision: {
                        acceptWithExecpolicyAmendment: {
                            execpolicy_amendment: amendment,
                        },
                    },
                };
            }
        }

        switch (result.decision) {
            case 'approved_for_session':
                return { decision: 'acceptForSession' };
            case 'approved_execpolicy_amendment':
            case 'approved':
                return { decision: 'accept' };
            case 'abort':
                return { decision: 'cancel' };
            case 'denied':
                return { decision: 'decline' };
        }
    };

    const mapPermissionsDecision = (
        update: Extract<CodexAppServerStreamUpdate, { type: 'permissions-request' }>,
        result: CodexAppServerPermissionResult,
    ): Readonly<Record<string, unknown>> => {
        if (
            result.decision === 'approved'
            || result.decision === 'approved_for_session'
            || result.decision === 'approved_execpolicy_amendment'
        ) {
            return {
                permissions: update.permissions,
                scope: result.decision === 'approved_for_session' ? 'session' : 'turn',
            };
        }

        return {
            permissions: {},
            scope: 'turn',
        };
    };

    const buildUserInputResponse = (
        update: Extract<CodexAppServerStreamUpdate, { type: 'user-input-request' }>,
        result: CodexAppServerPermissionResult,
        options?: Readonly<{ allowDecisionFallback?: boolean }>,
    ): Readonly<Record<string, unknown>> => {
        const answers = buildCodexRequestUserInputAnswers({
            questions: update.questions,
            answersByKey: result.answers ?? {},
        });

        if (options?.allowDecisionFallback === true && Object.keys(answers).length === 0) {
            const pickQuestionWithOptions = update.questions.find((question): question is Record<string, unknown> => {
                if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
                const options = (question as Record<string, unknown>).options;
                return Array.isArray(options) && options.some((option) => option && typeof option === 'object' && !Array.isArray(option));
            }) ?? update.questions.find((question): question is Record<string, unknown> => {
                return Boolean(question) && typeof question === 'object' && !Array.isArray(question);
            });

            const optionLabels = Array.isArray(pickQuestionWithOptions?.options)
                ? pickQuestionWithOptions.options
                    .map((option) => {
                        if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
                        const optionRecord = option as Record<string, unknown>;
                        const label = typeof optionRecord.label === 'string'
                            ? optionRecord.label.trim()
                            : '';
                        return label || null;
                    })
                    .filter((label): label is string => Boolean(label))
                : [];

            const choice = (() => {
                const explicit = resolveApprovalChoiceLabel({
                    decision: result.decision,
                    questions: [pickQuestionWithOptions].filter(Boolean),
                    logger: { debug: () => {} },
                });
                if (explicit) return explicit;
                if (result.decision === 'approved' || result.decision === 'approved_execpolicy_amendment' || result.decision === 'approved_for_session') {
                    return optionLabels.find((label) => /approve|allow/i.test(label)) ?? optionLabels[0] ?? null;
                }
                if (result.decision === 'denied') {
                    return optionLabels.find((label) => /deny|reject|decline/i.test(label)) ?? optionLabels.at(-1) ?? null;
                }
                if (result.decision === 'abort') {
                    return optionLabels.find((label) => /cancel|abort|stop/i.test(label)) ?? optionLabels.at(-1) ?? null;
                }
                return null;
            })();

            const questionId = typeof pickQuestionWithOptions?.id === 'string' ? pickQuestionWithOptions.id : null;
            if (choice && questionId) {
                answers[questionId] = { answers: [choice] };
            }
        }

        return { answers };
    };

    const readMcpElicitationInvocation = (
        requestParams: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ): Readonly<{
        toolCallId: string;
        toolName: string;
        input: unknown;
    }> | null => {
        const record = readRecord(requestParams);
        if (!record) return null;

        const invocation = readRecord(record.invocation) ?? record;
        const server =
            trimStringValue(invocation.server) ??
            trimStringValue(invocation.mcpServer) ??
            trimStringValue(invocation.mcp_server) ??
            trimStringValue(invocation.serverName) ??
            trimStringValue(invocation.server_name);

        const toolFromMessage = (() => {
            const messageText = trimStringValue(record.message);
            if (!messageText) return null;
            const match = messageText.match(/tool\s+\"([^\"]+)\"/i);
            return match && match[1] ? match[1].trim() : null;
        })();

        const tool =
            trimStringValue(invocation.tool) ??
            trimStringValue(invocation.name) ??
            trimStringValue(invocation.toolName) ??
            trimStringValue(invocation.tool_name) ??
            toolFromMessage;

        const meta = readRecord(record._meta) ?? readRecord(record.meta) ?? null;
        const metaToolParams = meta ? (meta.tool_params ?? meta.toolParams ?? null) : null;
        const input = invocation.arguments ?? invocation.input ?? invocation.args ?? metaToolParams ?? {};

        const toolCallId =
            trimStringValue(record.callId) ??
            trimStringValue(record.call_id) ??
            trimStringValue(record.toolUseId) ??
            trimStringValue(record.tool_use_id) ??
            trimStringValue(record.toolCallId) ??
            trimStringValue(record.tool_call_id) ??
            trimStringValue(record.codexCallId) ??
            trimStringValue(record.codex_call_id) ??
            trimStringValue(record.codex_tool_call_id) ??
            trimStringValue(record.codex_mcp_tool_call_id) ??
            trimStringValue(record.itemId) ??
            trimStringValue(record.item_id) ??
            trimStringValue(record.id) ??
            (typeof message?.id === 'string' || typeof message?.id === 'number' ? String(message.id) : null);

        if (!toolCallId) return null;

        const toolName = server && tool ? canonicalizeCodexMcpToolName(`mcp__${server}__${tool}`) : tool;
        if (!toolName) return null;

        return { toolCallId, toolName, input };
    };

    type CodexElicitationAction = 'accept' | 'decline' | 'cancel';
    type CodexElicitationDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort';

    const mapMcpElicitationDecision = (
        result: CodexAppServerPermissionResult,
    ): Readonly<Record<string, unknown>> => {
        const decision: CodexElicitationDecision = (() => {
            switch (result.decision) {
                case 'approved_for_session':
                    return 'approved_for_session';
                case 'approved_execpolicy_amendment':
                case 'approved':
                    return 'approved';
                case 'abort':
                    return 'abort';
                case 'denied':
                default:
                    return 'denied';
            }
        })();

        const action: CodexElicitationAction = (() => {
            if (decision === 'approved' || decision === 'approved_for_session') {
                return 'accept';
            }
            if (decision === 'abort') {
                return 'cancel';
            }
            return 'decline';
        })();

        return { action, decision, content: {} };
    };

    const handleMcpElicitationRequest = async (
        requestParams: unknown,
        message?: Readonly<{ id?: unknown }> | null,
    ): Promise<unknown> => {
        const invocation = readMcpElicitationInvocation(requestParams, message);
        if (!invocation) {
            return { decision: 'decline' };
        }

        const result = params.permissionHandler
            ? await params.permissionHandler.handleToolCall(invocation.toolCallId, invocation.toolName, invocation.input)
            : { decision: 'denied' as const };

        return mapMcpElicitationDecision(result);
    };

    const handleServerRequest = async (method: string, requestParams: unknown): Promise<unknown> => {
        const updates = params.onServerRequest({ method, params: requestParams });
        for (const update of updates) {
            if (update.type === 'approval-request') {
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, update.toolName, update.input)
                    : { decision: 'denied' as const };
                return mapApprovalDecision(update.requestKind, result);
            }

            if (update.type === 'permissions-request') {
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, update.toolName, update.input)
                    : { decision: 'denied' as const };
                return mapPermissionsDecision(update, result);
            }

            if (update.type === 'user-input-request') {
                const treatAsApproval = looksLikeCodexApprovalRequestUserInput({
                    toolName: update.toolName,
                    questions: update.questions,
                });
                logger.debug('[codex-app-server] requestUserInput received', {
                    callId: update.callId,
                    toolName: update.toolName,
                    treatAsApproval,
                    questionSummaries: update.questions.map((question) => {
                        if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
                        const record = question as Record<string, unknown>;
                        const options = Array.isArray(record.options)
                            ? record.options
                                .map((option) => {
                                    if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
                                    const optionRecord = option as Record<string, unknown>;
                                    return typeof optionRecord.label === 'string' ? optionRecord.label : null;
                                })
                                .filter((label): label is string => Boolean(label))
                            : [];
                        return {
                            id: typeof record.id === 'string' ? record.id : null,
                            header: typeof record.header === 'string' ? record.header : null,
                            question: typeof record.question === 'string' ? record.question : null,
                            options,
                        };
                    }).filter(Boolean),
                });
                const toolName = treatAsApproval ? update.toolName : 'AskUserQuestion';
                const toolInput = treatAsApproval
                    ? {
                        ...(update.input && typeof update.input === 'object' && !Array.isArray(update.input)
                            ? update.input as Record<string, unknown>
                            : {}),
                        requestUserInput: {
                            questions: update.questions,
                        },
                    }
                    : normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput(update.questions);
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, toolName, toolInput)
                    : { decision: 'abort' as const };
                logger.debug('[codex-app-server] requestUserInput resolved', {
                    callId: update.callId,
                    toolName,
                    decision: result.decision,
                    answerKeys: result.answers ? Object.keys(result.answers) : [],
                });
                return buildUserInputResponse(update, result, { allowDecisionFallback: treatAsApproval });
            }
        }

        return null;
    };

    return {
        handleServerRequest,
        handleMcpElicitationRequest,
    };
}
