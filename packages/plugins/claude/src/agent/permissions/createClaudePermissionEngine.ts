import type { AgentSessionModesService } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    SessionPermissionDecisionResult as SessionPermissionDecisionResultV1,
    SessionPermissionsService,
} from '@happier-dev/plugin-sdk/sessions';

import type { PermissionResult } from '../sdk/types.js';
import { buildClaudePermissionChoices } from './permissionChoices.js';
import {
    isAskUserQuestionToolName,
    normalizeAskUserQuestionInputForPublication,
    normalizeAskUserQuestionAnswers,
    buildAskUserQuestionAnswersForClaude,
} from './askUserQuestion.js';

export const CLAUDE_NATIVE_QUESTION_REQUEST_SOURCE = 'claude_native_question';

export type ClaudePermissionEngine = Readonly<{
    canCallTool(
        toolName: string,
        input: unknown,
        options?: Readonly<{
            requestId?: string | null;
            signal?: AbortSignal;
            toolUseId?: string | null;
        }>,
    ): Promise<PermissionResult>;
}>;

export type ClaudePermissionDecision = SessionPermissionDecisionResultV1;

export type ClaudePermissionContext = Readonly<{
    agentRuntime?: Readonly<{ modes?: AgentSessionModesService }>;
    logger?: Readonly<{ warn(message: string, fields?: Readonly<Record<string, unknown>>): void }>;

    sessions: Readonly<{
        current: Readonly<{
            permissions: Pick<SessionPermissionsService, 'requestDecision' | 'settleObservedDecision'>;
        }>;
    }>;
}>;

function readToolInputRecord(input: unknown): Record<string, unknown> | null {
    return input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null;
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
    return readToolInputRecord(input) ?? {};
}

function resolveAllowedToolInput(
    toolName: string,
    normalizedInput: Record<string, unknown>,
    result: ClaudePermissionDecision,
): Record<string, unknown> {
    const baseInput = readToolInputRecord(result.updatedInput) ?? normalizedInput;
    if (!isAskUserQuestionToolName(toolName)) return baseInput;

    const answers = result.answers && Array.isArray(normalizedInput.questions)
        ? buildAskUserQuestionAnswersForClaude(normalizedInput.questions, result.answers, 'hook')
        : normalizeAskUserQuestionAnswers(result.answers);
    return answers ? { ...baseInput, answers } : baseInput;
}

function resolveRequestId(toolName: string, requestId?: string | null, toolUseId?: string | null): string {
    const request = typeof requestId === 'string' ? requestId.trim() : '';
    if (request) return request;
    const explicit = typeof toolUseId === 'string' ? toolUseId.trim() : '';
    if (explicit) return explicit;
    return `claude:${toolName}:${Date.now().toString(36)}`;
}

function isExitPlanModeToolName(toolName: string): boolean {
    const normalized = typeof toolName === 'string' ? toolName.trim() : '';
    return normalized === 'ExitPlanMode' || normalized === 'exit_plan_mode';
}

function resolveAllowUpdatedPermissions(
    toolName: string,
    result: ClaudePermissionDecision,
): readonly Readonly<Record<string, unknown>>[] | undefined {
    if (Array.isArray(result.updatedPermissions) && result.updatedPermissions.length > 0) {
        return result.updatedPermissions;
    }
    // Historical responses did not carry the follow-up mode. Native selections
    // carry their complete setMode effect in the producer-owned offer above.
    if (!result.nativeChoice && isExitPlanModeToolName(toolName)) {
        return [{ type: 'setMode', mode: 'default' }];
    }
    return undefined;
}

/** Translate a host-validated selection at Claude's native response boundary. */
export function resolveClaudePermissionResult(
    toolName: string,
    input: unknown,
    result: ClaudePermissionDecision,
): PermissionResult {
    if (result.decision === 'approved' || result.decision === 'approved_for_session'
        || result.decision === 'approved_execpolicy_amendment') {
        const updatedPermissions = resolveAllowUpdatedPermissions(toolName, result);
        return { behavior: 'allow', updatedInput: resolveAllowedToolInput(toolName, normalizeToolInput(input), result),
            ...(updatedPermissions ? { updatedPermissions } : {}) };
    }
    return { behavior: 'deny', message: result.nativeChoice?.feedback || result.rationale || 'Permission denied', interrupt: true };
}

/** Native acceptance completes the saved Plan intent without guessing its next permission policy. */
export async function completeClaudePlanModeBestEffort(ctx: ClaudePermissionContext, toolName: string): Promise<void> {
    if (!isExitPlanModeToolName(toolName)) return;
    try {
        const modes = ctx.agentRuntime?.modes;
        if (!modes?.complete) throw new Error('claude_native_plan_completion_unavailable');
        await modes.complete({ modeId: 'plan' });
    } catch (error) {
        if (!ctx.logger) throw error;
        ctx.logger.warn('[Claude] accepted native Plan completion could not update the saved mode', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function createClaudePermissionEngine(ctx: ClaudePermissionContext): ClaudePermissionEngine {
    return Object.freeze({
        async canCallTool(toolName, input, options = {}) {
            const normalizedInput = normalizeToolInput(input);
            const publishedInput = normalizeToolInput(
                normalizeAskUserQuestionInputForPublication(toolName, normalizedInput),
            );
            const requestId = resolveRequestId(toolName, options.requestId, options.toolUseId);
            const result = await ctx.sessions.current.permissions.requestDecision({
                provider: 'claude',
                requestId,
                toolCallId: requestId,
                toolName,
                input: publishedInput,
                ...(!isAskUserQuestionToolName(toolName) ? { nativeChoices: buildClaudePermissionChoices({
                    requestId, toolName, toolInput: publishedInput,
                }) } : {}),
            }, { signal: options.signal,
                ...(!isAskUserQuestionToolName(toolName) ? { buildNativeChoices: ({ mcpTool }) => buildClaudePermissionChoices({
                    requestId, toolName, toolInput: publishedInput, mcpTool,
                }) } : {}),
            });
            if (
                result.decision === 'approved'
                || result.decision === 'approved_for_session'
                || result.decision === 'approved_execpolicy_amendment'
            ) {
                await completeClaudePlanModeBestEffort(ctx, toolName);
            }
            return resolveClaudePermissionResult(toolName, normalizedInput, result);
        },
    });
}
