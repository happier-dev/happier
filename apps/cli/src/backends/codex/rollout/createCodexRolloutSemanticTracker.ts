import type { CodexRolloutAction } from '../localControl/rolloutMapper';

type NormalizedCodexRolloutAction = Exclude<
    CodexRolloutAction,
    { type: 'collaboration-tool-call' } | { type: 'collaboration-tool-result' }
>;

export function createCodexRolloutSemanticTracker() {
    const pendingSpawnByCallId = new Map<string, Readonly<{
        prompt: string | null;
        nickname: string | null;
        role: string | null;
    }>>();
    const startedThreadIds = new Set<string>();
    const completedThreadIds = new Set<string>();

    return {
        consume(action: CodexRolloutAction): NormalizedCodexRolloutAction[] {
            if (action.type === 'collaboration-tool-call') {
                if (action.name === 'spawn_agent') {
                    pendingSpawnByCallId.set(action.callId, {
                        prompt: action.prompt,
                        nickname: action.nickname,
                        role: action.role,
                    });
                }
                return [];
            }

            if (action.type === 'collaboration-tool-result') {
                const pendingSpawn = pendingSpawnByCallId.get(action.callId);
                pendingSpawnByCallId.delete(action.callId);
                if (!action.threadId) return [];
                if (startedThreadIds.has(action.threadId)) return [];

                startedThreadIds.add(action.threadId);
                return [{
                    type: 'subagent-spawn',
                    threadId: action.threadId,
                    prompt: pendingSpawn?.prompt ?? null,
                    nickname: action.nickname ?? pendingSpawn?.nickname ?? null,
                    role: pendingSpawn?.role ?? null,
                }];
            }

            if (action.type === 'subagent-spawn') {
                if (startedThreadIds.has(action.threadId)) return [];
                startedThreadIds.add(action.threadId);
                return [action];
            }

            if (action.type === 'subagent-complete') {
                if (completedThreadIds.has(action.threadId)) return [];
                completedThreadIds.add(action.threadId);

                if (!startedThreadIds.has(action.threadId)) {
                    startedThreadIds.add(action.threadId);
                    return [
                        {
                            type: 'subagent-spawn',
                            threadId: action.threadId,
                            prompt: null,
                            nickname: null,
                            role: null,
                        },
                        action,
                    ];
                }

                return [action];
            }

            return [action];
        },
    };
}
