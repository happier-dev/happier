import type { ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { knownTools } from '@/components/tools/catalog';
import type { KnownToolDefinition } from '@/components/tools/catalog/_types';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import { resolveToolPermissionTerminalErrorMessage } from '../permissions/resolveToolPermissionTerminalErrorMessage';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';

export function resolveToolErrorDisplay(message: string) {
    const parsed = parseToolUseError(message);
    return { text: parsed.isToolUseError && parsed.errorMessage ? parsed.errorMessage : message, isToolUseError: parsed.isToolUseError };
}

export function isSubAgentRunErrorResult(result: unknown): boolean {
    const parsed = maybeParseJson(result);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const hasRunId = typeof record.runId === 'string' && record.runId.trim().length > 0;
    const hasCallRef = (typeof record.callId === 'string' && record.callId.trim().length > 0)
        || (typeof record.sidechainId === 'string' && record.sidechainId.trim().length > 0);
    return hasRunId && hasCallRef && (Boolean(record.error) || record.status === 'timeout' || record.status === 'failed');
}

/** The exact common error-body selection, shared by the body and its pre-mount Find corpus. */
export function resolveToolInlineErrorDisplay(params: Readonly<{
    tool: ToolCall;
    normalizedToolName: string;
    metadata: Metadata | null;
    historicalAgentId?: string | null;
    permissionDisabledReason?: TranscriptPermissionDisabledReason;
}>): Readonly<{ override: string | null; append: string | null }> {
    const override = resolveToolPermissionTerminalErrorMessage(params);
    if (override) return { override: resolveToolErrorDisplay(override).text, append: null };
    const known: KnownToolDefinition | undefined = knownTools[params.normalizedToolName as keyof typeof knownTools];
    const hideError = known?.hideDefaultError === true
        || params.normalizedToolName === 'SubAgentRun' || params.tool.name === 'SubAgentRun'
        || isSubAgentRunErrorResult(params.tool.result);
    if (hideError || params.tool.state !== 'error' || !params.tool.result || parseToolUseError(params.tool.result).isToolUseError) {
        return { override: null, append: null };
    }
    const raw = typeof params.tool.result === 'string' ? params.tool.result : JSON.stringify(params.tool.result, null, 2);
    return { override: null, append: resolveToolErrorDisplay(raw).text };
}
