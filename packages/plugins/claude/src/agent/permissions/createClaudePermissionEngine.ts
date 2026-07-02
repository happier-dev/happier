import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import type { PermissionResult } from '../sdk/types.js';
import {
    isAskUserQuestionToolName,
    normalizeAskUserQuestionAnswers,
} from './askUserQuestion.js';

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
    result: Awaited<ReturnType<PluginContextV1['session']['permissions']['requestDecision']>>,
): Record<string, unknown> {
    const baseInput = readToolInputRecord(result.updatedInput) ?? normalizedInput;
    if (!isAskUserQuestionToolName(toolName)) return baseInput;

    const answers = normalizeAskUserQuestionAnswers(result.answers);
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
    result: Awaited<ReturnType<PluginContextV1['session']['permissions']['requestDecision']>>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
    if (Array.isArray(result.updatedPermissions) && result.updatedPermissions.length > 0) {
        return result.updatedPermissions;
    }
    // An approved ExitPlanMode must clear Happier plan mode and apply the follow-up permission
    // mode (plan -> default) via hook `updatedPermissions` rather than TUI keystrokes. When the
    // host did not supply an explicit follow-up mode, default is the canonical post-plan mode.
    if (isExitPlanModeToolName(toolName)) {
        return [{ type: 'setMode', mode: 'default' }];
    }
    return undefined;
}

export function createClaudePermissionEngine(ctx: PluginContextV1): ClaudePermissionEngine {
    return Object.freeze({
        async canCallTool(toolName, input, options = {}) {
            const normalizedInput = normalizeToolInput(input);
            const requestId = resolveRequestId(toolName, options.requestId, options.toolUseId);
            const result = await ctx.session.permissions.requestDecision({
                provider: 'claude',
                requestId,
                toolCallId: requestId,
                toolName,
                input: normalizedInput,
            }, { signal: options.signal });
            if (
                result.decision === 'approved'
                || result.decision === 'approved_for_session'
                || result.decision === 'approved_execpolicy_amendment'
            ) {
                const updatedPermissions = resolveAllowUpdatedPermissions(toolName, result);
                return {
                    behavior: 'allow',
                    updatedInput: resolveAllowedToolInput(toolName, normalizedInput, result),
                    ...(updatedPermissions ? { updatedPermissions } : {}),
                };
            }
            return {
                behavior: 'deny',
                message: result.rationale || 'Permission denied',
                interrupt: true,
            };
        },
    });
}
