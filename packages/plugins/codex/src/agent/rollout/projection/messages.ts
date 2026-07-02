import type { CodexRolloutAction } from './actions.js';

export type CodexProjectedRolloutEvent =
    | { type: 'codex-session-id'; id: string }
    | { type: 'user-text'; text: string }
    | { type: 'assistant-text'; text: string; sidechainId: string | null }
    | { type: 'tool-call'; callId: string; name: string; input: unknown; sidechainId: string | null }
    | { type: 'tool-result'; callId: string; output: unknown; sidechainId: string | null; isError?: boolean }
    | { type: 'subagent-spawn'; threadId: string; prompt: string | null; nickname: string | null; role: string | null }
    | { type: 'subagent-complete'; threadId: string; status: 'completed' | 'interrupted'; summaryText: string | null }
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
            projected.push({
                type: 'subagent-spawn',
                threadId: action.threadId,
                prompt: action.prompt,
                nickname: action.nickname,
                role: action.role,
            });
            continue;
        }

        if (action.type === 'subagent-complete') {
            if (params.sidechainId !== null) continue;
            projected.push({
                type: 'subagent-complete',
                threadId: action.threadId,
                status: action.status,
                summaryText: action.summaryText,
            });
            continue;
        }

        if (action.type === 'debug') {
            projected.push(action);
        }
    }

    return projected;
}
