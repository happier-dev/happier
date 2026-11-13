import type { ToolCall } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { knownTools } from '@/components/tools/catalog';
import type { KnownToolDefinition } from '@/components/tools/catalog/_types';
import { parseToolUseError } from '@/utils/errors/toolErrorParser';
import { resolveToolPermissionTerminalErrorMessage } from '../permissions/resolveToolPermissionTerminalErrorMessage';
import type { TranscriptPermissionDisabledReason } from '@/utils/sessions/deriveTranscriptInteraction';
import { resolveToolStatusIndicatorKind } from './resolveToolStatusIndicatorKind';

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
}>): Readonly<{ override: string | null; append: string | null; generic: string | null }> {
    const override = resolveToolPermissionTerminalErrorMessage(params);
    if (override) return { override: resolveToolErrorDisplay(override).text, append: null, generic: null };
    const result = params.tool.result;
    const isSubAgentRun = params.normalizedToolName === 'SubAgentRun' || params.tool.name === 'SubAgentRun'
        || isSubAgentRunErrorResult(result);
    if (resolveToolStatusIndicatorKind(params.tool) !== 'error' || !result || parseToolUseError(result).isToolUseError || isSubAgentRun) {
        return { override: null, append: null, generic: null };
    }
    const raw = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    // The body without a tool-specific view always states a failure itself, with the raw result.
    const generic = raw;
    const known: KnownToolDefinition | undefined = knownTools[params.normalizedToolName as keyof typeof knownTools];
    if (known?.hideDefaultError === true) return { override: null, append: null, generic };
    const typedError = parseToolUseError(result).errorMessage;
    return { override: null, append: resolveToolErrorDisplay(typedError ?? raw).text, generic };
}

/**
 * Whether the open tool body states the failure itself (a `ToolError` block): the permission
 * override always; beside a tool-specific view, the appended error (unless the tool hides it);
 * in the generic body, the raw result. A minimal body shows only the result. When this is true the card header stays quiet, so one place states
 * the error; while the card is closed, the header summary is that place.
 */
export function doesToolInlineBodyStateError(
    display: Readonly<{ override: string | null; append: string | null; generic: string | null }>,
    body: Readonly<{ hasSpecificView: boolean; minimal: boolean }>,
): boolean {
    if (display.override !== null) return true;
    if (body.hasSpecificView) return display.append !== null;
    return !body.minimal && display.generic !== null;
}
