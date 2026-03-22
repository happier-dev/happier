import {
    buildCodexSyntheticSubagentToolCall,
    buildCodexSyntheticSubagentToolResult,
} from '../collaboration/buildCodexSyntheticSubagentToolMessages';
import type { CodexRolloutAction } from '../localControl/rolloutMapper';

export type CodexProjectedRolloutEvent =
    | { type: 'codex-session-id'; id: string }
    | { type: 'user-text'; text: string }
    | { type: 'assistant-text'; text: string; sidechainId: string | null }
    | { type: 'tool-call'; callId: string; name: string; input: unknown; sidechainId: string | null }
    | { type: 'tool-result'; callId: string; output: unknown; sidechainId: string | null; isError?: boolean }
    | { type: 'subagent-spawn'; threadId: string }
    | { type: 'debug'; message: string; value?: unknown };

export function projectCodexRolloutActions(
    actions: ReadonlyArray<CodexRolloutAction>,
    params: Readonly<{ sidechainId: string | null }>,
): CodexProjectedRolloutEvent[] {
    const projected: CodexProjectedRolloutEvent[] = [];

    for (const action of actions) {
        if (action.type === 'codex-session-id') {
            if (params.sidechainId === null) {
                projected.push(action);
            }
            continue;
        }

        if (action.type === 'user-text') {
            if (params.sidechainId === null) {
                projected.push(action);
            }
            continue;
        }

        if (action.type === 'assistant-text') {
            projected.push({
                type: 'assistant-text',
                text: action.text,
                sidechainId: params.sidechainId,
            });
            continue;
        }

        if (action.type === 'tool-call') {
            projected.push({
                type: 'tool-call',
                callId: action.callId,
                name: action.name,
                input: action.input,
                sidechainId: params.sidechainId,
            });
            continue;
        }

        if (action.type === 'tool-result') {
            projected.push({
                type: 'tool-result',
                callId: action.callId,
                output: action.output,
                sidechainId: params.sidechainId,
            });
            continue;
        }

        if (action.type === 'subagent-spawn') {
            if (params.sidechainId !== null) continue;
            const toolCall = buildCodexSyntheticSubagentToolCall({
                threadId: action.threadId,
                prompt: action.prompt,
                nickname: action.nickname,
                role: action.role,
            });
            projected.push({
                type: 'tool-call',
                callId: toolCall.callId,
                name: toolCall.name,
                input: toolCall.input,
                sidechainId: null,
            });
            projected.push({
                type: 'subagent-spawn',
                threadId: action.threadId,
            });
            continue;
        }

        if (action.type === 'subagent-complete') {
            if (params.sidechainId !== null) continue;
            const toolResult = buildCodexSyntheticSubagentToolResult({
                threadId: action.threadId,
                status: action.status,
            });
            projected.push({
                type: 'tool-result',
                callId: toolResult.callId,
                output: toolResult.output,
                sidechainId: null,
                ...(toolResult.isError ? { isError: toolResult.isError } : {}),
            });
            continue;
        }

        if (action.type === 'debug') {
            projected.push(action);
        }
    }

    return projected;
}
