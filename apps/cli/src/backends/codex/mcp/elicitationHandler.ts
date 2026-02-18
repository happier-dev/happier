import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { RequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { logger } from '@/ui/logger';
import type { PermissionResult } from '@/agent/permissions/BasePermissionHandler';

import {
    getCodexElicitationToolCallId,
    isExecpolicyAmendmentDecision,
    type ElicitationAction,
    type ReviewDecision,
} from './elicitationTypes';
import { getElicitationResponseStyle, type CodexVersionInfo, type ElicitationResponseStyle } from './version';

export type CodexMcpPermissionHandler = {
    handleToolCall: (toolCallId: string, toolName: string, input: unknown) => Promise<PermissionResult>;
};

const ElicitRequestSchemaWithExtras = RequestSchema.extend({
    method: z.literal('elicitation/create'),
    params: z.any()
});

function buildElicitationResponse(
    style: ElicitationResponseStyle,
    action: ElicitationAction,
    decision: ReviewDecision
): { action: ElicitationAction; decision?: ReviewDecision; content?: Record<string, unknown> } {
    if (style === 'decision') {
        return { action, decision };
    }
    return { action, decision, content: {} };
}

function extractString(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildExecToolInput(
    params: Record<string, unknown>,
    cachedAmendment?: string[]
): {
    command: string[];
    cwd?: string;
    parsed_cmd?: unknown[];
    reason?: string;
    proposedExecpolicyAmendment?: string[];
} {
    const command = Array.isArray(params.codex_command)
        ? params.codex_command.filter((p): p is string => typeof p === 'string')
        : [];
    const cwd = extractString(params, 'codex_cwd');
    const parsed_cmd = Array.isArray(params.codex_parsed_cmd)
        ? params.codex_parsed_cmd
        : undefined;
    const reason = extractString(params, 'codex_reason');

    const proposedExecpolicyAmendment = cachedAmendment;

    return { command, cwd, parsed_cmd, reason, proposedExecpolicyAmendment };
}

function buildPatchToolInput(params: Record<string, unknown>, message: string): {
    message: string;
    reason?: string;
    grantRoot?: string;
    changes?: unknown;
} {
    const reason = extractString(params, 'codex_reason');
    const grantRoot = extractString(params, 'codex_grant_root');
    const changes = typeof params.codex_changes === 'object' && params.codex_changes !== null
        ? params.codex_changes
        : undefined;

    return { message, reason, grantRoot, changes };
}

function mapResultToDecision(result: {
    decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: { command: string[] };
}): ReviewDecision {
    switch (result.decision) {
        case 'approved_execpolicy_amendment':
            if (result.execPolicyAmendment?.command?.length) {
                return {
                    approved_execpolicy_amendment: {
                        proposed_execpolicy_amendment: result.execPolicyAmendment.command
                    }
                };
            }
            logger.debug('[CodexMCP] Missing execpolicy amendment, falling back to approved');
            return 'approved';
        case 'approved':
            return 'approved';
        case 'approved_for_session':
            return 'approved_for_session';
        case 'denied':
            return 'denied';
        case 'abort':
            return 'abort';
    }
}

function mapDecisionToAction(decision: ReviewDecision): ElicitationAction {
    if (decision === 'approved' || decision === 'approved_for_session' || isExecpolicyAmendmentDecision(decision)) {
        return 'accept';
    }
    if (decision === 'abort') {
        return 'cancel';
    }
    return 'decline';
}

export function registerCodexPermissionHandlers(params: {
    client: any;
    versionInfo: CodexVersionInfo;
    getPermissionHandler: () => CodexMcpPermissionHandler | null;
    pendingAmendments: Map<string, string[]>;
}): void {
    const responseStyle = getElicitationResponseStyle(params.versionInfo);
    logger.debug('[CodexMCP] Elicitation response style', {
        style: responseStyle,
        version: params.versionInfo.raw
    });

    params.client.setRequestHandler(
        ElicitRequestSchemaWithExtras,
        async (request: { params?: unknown }) => {
            const requestParams = (request.params ?? {}) as Record<string, unknown>;
            logger.debugLargeJson('[CodexMCP] Received elicitation request', requestParams);

            const toolCallId = getCodexElicitationToolCallId(requestParams) ?? randomUUID();
            const elicitationType = extractString(requestParams, 'codex_elicitation');
            const message = extractString(requestParams, 'message') ?? '';

            const isPatchApproval = elicitationType === 'patch-approval';
            const toolName = isPatchApproval ? 'CodexPatch' : 'CodexBash';

            const cachedAmendment = params.pendingAmendments.get(toolCallId);
            params.pendingAmendments.delete(toolCallId);

            const toolInput = isPatchApproval
                ? buildPatchToolInput(requestParams, message)
                : buildExecToolInput(requestParams, cachedAmendment);

            logger.debug('[CodexMCP] Permission request', {
                toolCallId,
                toolName,
                elicitationType
            });

            const permissionHandler = params.getPermissionHandler();
            if (!permissionHandler) {
                logger.debug('[CodexMCP] No permission handler, denying');
                return buildElicitationResponse(responseStyle, 'decline', 'denied');
            }

            try {
                const result = await permissionHandler.handleToolCall(
                    toolCallId,
                    toolName,
                    toolInput
                );

                const decision = mapResultToDecision(result);
                const action = mapDecisionToAction(decision);

                logger.debug('[CodexMCP] Sending response', {
                    toolCallId,
                    decision,
                    action,
                    responseStyle
                });
                return buildElicitationResponse(responseStyle, action, decision);
            } catch (error) {
                logger.debug('[CodexMCP] Error handling permission:', error);
                return buildElicitationResponse(responseStyle, 'decline', 'denied');
            }
        }
    );

    logger.debug('[CodexMCP] Permission handlers registered');
}
