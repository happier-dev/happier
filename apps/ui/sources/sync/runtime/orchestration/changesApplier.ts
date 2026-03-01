import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { PlannedChangeActions } from './changesPlanner';
import { runTasksWithLimit } from './runTasksWithLimit';

export async function applyPlannedChangeActions(params: {
    planned: PlannedChangeActions;
    credentials: AuthCredentials;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    concurrencyLimit?: number;
    invalidate: {
        settings?: () => Promise<void>;
        profile?: () => Promise<void>;
        machines?: () => Promise<void>;
        artifacts?: () => Promise<void>;
        friends?: () => Promise<void>;
        friendRequests?: () => Promise<void>;
        feed?: () => Promise<void>;
        automations?: () => Promise<void>;
        sessions?: () => Promise<void>;
        todos?: () => Promise<void>;
    };
    invalidateMessagesForSession: (sessionId: string) => Promise<void>;
    invalidateScmStatusForSession: (sessionId: string) => void;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    kvBulkGet: (credentials: AuthCredentials, keys: string[]) => Promise<{ values: Array<{ key: string; value: string | null; version: number }> }>;
}): Promise<void> {
    const { planned } = params;

    const concurrencyLimit = typeof params.concurrencyLimit === 'number' && params.concurrencyLimit > 0
        ? Math.trunc(params.concurrencyLimit)
        : 2;

    const tasks: Array<() => Promise<void>> = [];

    let sessionsInvalidationDone: Promise<void> | null = null;
    let resolveSessionsInvalidationDone: (() => void) | null = null;
    let rejectSessionsInvalidationDone: ((error: unknown) => void) | null = null;
    if (planned.invalidate.sessions) {
        sessionsInvalidationDone = new Promise<void>((resolve, reject) => {
            resolveSessionsInvalidationDone = resolve;
            rejectSessionsInvalidationDone = reject;
        });
    }

    if (planned.invalidate.settings) tasks.push(() => params.invalidate.settings?.() ?? Promise.resolve());
    if (planned.invalidate.profile) tasks.push(() => params.invalidate.profile?.() ?? Promise.resolve());
    if (planned.invalidate.machines) tasks.push(() => params.invalidate.machines?.() ?? Promise.resolve());
    if (planned.invalidate.artifacts) tasks.push(() => params.invalidate.artifacts?.() ?? Promise.resolve());
    if (planned.invalidate.friends) {
        tasks.push(() => params.invalidate.friends?.() ?? Promise.resolve());
        tasks.push(() => params.invalidate.friendRequests?.() ?? Promise.resolve());
    }
    if (planned.invalidate.feed) tasks.push(() => params.invalidate.feed?.() ?? Promise.resolve());
    if (planned.invalidate.automations) tasks.push(() => params.invalidate.automations?.() ?? Promise.resolve());
    if (planned.invalidate.sessions) {
        tasks.push(async () => {
            try {
                await params.invalidate.sessions?.();
                resolveSessionsInvalidationDone?.();
            } catch (error) {
                rejectSessionsInvalidationDone?.(error);
                throw error;
            }
        });
    }

    for (const sessionId of planned.sessionIdsToCatchUp) {
        if (!params.isSessionMessagesLoaded(sessionId)) {
            continue;
        }
        tasks.push(async () => {
            if (sessionsInvalidationDone) {
                await sessionsInvalidationDone;
            }
            await params.invalidateMessagesForSession(sessionId);
        });
        params.invalidateScmStatusForSession(sessionId);
    }

    if (planned.kv.type === 'refresh-feature' && planned.kv.feature === 'todos') {
        tasks.push(() => params.invalidate.todos?.() ?? Promise.resolve());
    }

    if (planned.kv.type === 'bulk-keys' && planned.kv.feature === 'todos') {
        const keys = planned.kv.keys;
        tasks.push(async () => {
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
        });
    }

    await runTasksWithLimit(tasks, concurrencyLimit);
}
