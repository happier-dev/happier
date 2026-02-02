import type { AuthCredentials } from '@/auth/tokenStorage';
import type { PlannedChangeActions } from './changesPlanner';

export async function applyPlannedChangeActions(params: {
    planned: PlannedChangeActions;
    credentials: AuthCredentials;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    invalidate: {
        settings?: () => Promise<void>;
        profile?: () => Promise<void>;
        machines?: () => Promise<void>;
        artifacts?: () => Promise<void>;
        friends?: () => Promise<void>;
        friendRequests?: () => Promise<void>;
        feed?: () => Promise<void>;
        sessions?: () => Promise<void>;
        todos?: () => Promise<void>;
    };
    invalidateMessagesForSession: (sessionId: string) => Promise<void>;
    invalidateGitStatusForSession: (sessionId: string) => void;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    kvBulkGet: (credentials: AuthCredentials, keys: string[]) => Promise<{ values: Array<{ key: string; value: string | null; version: number }> }>;
}): Promise<void> {
    const { planned } = params;

    const refreshTasks: Array<Promise<void>> = [];
    if (planned.invalidate.settings) refreshTasks.push(params.invalidate.settings?.() ?? Promise.resolve());
    if (planned.invalidate.profile) refreshTasks.push(params.invalidate.profile?.() ?? Promise.resolve());
    if (planned.invalidate.machines) refreshTasks.push(params.invalidate.machines?.() ?? Promise.resolve());
    if (planned.invalidate.artifacts) refreshTasks.push(params.invalidate.artifacts?.() ?? Promise.resolve());
    if (planned.invalidate.friends) {
        refreshTasks.push(params.invalidate.friends?.() ?? Promise.resolve());
        refreshTasks.push(params.invalidate.friendRequests?.() ?? Promise.resolve());
    }
    if (planned.invalidate.feed) refreshTasks.push(params.invalidate.feed?.() ?? Promise.resolve());
    if (planned.invalidate.sessions) refreshTasks.push(params.invalidate.sessions?.() ?? Promise.resolve());

    for (const sessionId of planned.sessionIdsToCatchUp) {
        if (!params.isSessionMessagesLoaded(sessionId)) {
            continue;
        }
        refreshTasks.push(params.invalidateMessagesForSession(sessionId));
        params.invalidateGitStatusForSession(sessionId);
    }

    if (planned.kv.type === 'refresh-feature' && planned.kv.feature === 'todos') {
        refreshTasks.push(params.invalidate.todos?.() ?? Promise.resolve());
    }

    if (planned.kv.type === 'bulk-keys' && planned.kv.feature === 'todos') {
        const keys = planned.kv.keys;
        refreshTasks.push((async () => {
            const todoKeys = keys.filter((key: string) => key.startsWith('todo.'));
            if (todoKeys.length === 0) {
                return;
            }

            try {
                const bulk = await params.kvBulkGet(params.credentials, todoKeys);
                if (bulk.values.length !== todoKeys.length) {
                    await (params.invalidate.todos?.() ?? Promise.resolve());
                    return;
                }
                await params.applyTodoSocketUpdates(bulk.values.map((v) => ({ key: v.key, value: v.value, version: v.version })));
            } catch {
                await (params.invalidate.todos?.() ?? Promise.resolve());
            }
        })());
    }

    await Promise.all(refreshTasks);
}
