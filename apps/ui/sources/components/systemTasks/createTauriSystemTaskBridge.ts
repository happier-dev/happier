import { invokeTauri, listenTauriEvent } from '@/utils/platform/tauri';

import type { SystemTaskBridgeListenerSet, SystemTasksBridge } from './types';

type SnapshotPayload = Readonly<{
    events?: unknown[];
    result?: unknown | null;
}>;

function buildEventName(taskId: string, kind: 'event' | 'result'): string {
    return `systemTasks://task/${taskId}/${kind}`;
}

export function createTauriSystemTaskBridge(): SystemTasksBridge {
    return {
        async start(spec) {
            const response = await invokeTauri<{ taskId: string }>('start_system_task', {
                specJson: JSON.stringify(spec),
            });
            return response.taskId;
        },
        async subscribe(taskId: string, listeners: SystemTaskBridgeListenerSet) {
            let snapshotLoaded = false;
            const pendingEvents: unknown[] = [];
            let pendingResult: unknown | null = null;
            const [unlistenEvent, unlistenResult] = await Promise.all([
                listenTauriEvent(buildEventName(taskId, 'event'), (payload) => {
                    if (!snapshotLoaded) {
                        pendingEvents.push(payload);
                        return;
                    }
                    listeners.onEvent(payload);
                }),
                listenTauriEvent(buildEventName(taskId, 'result'), (payload) => {
                    if (!snapshotLoaded) {
                        pendingResult = payload;
                        return;
                    }
                    listeners.onResult(payload);
                }),
            ]);

            const snapshot = await invokeTauri<SnapshotPayload>('get_system_task_snapshot', { taskId });
            if (Array.isArray(snapshot.events)) {
                for (const event of snapshot.events) {
                    listeners.onEvent(event);
                }
            }
            for (const event of pendingEvents) {
                listeners.onEvent(event);
            }
            if (snapshot.result) {
                listeners.onResult(snapshot.result);
            }
            if (pendingResult) {
                listeners.onResult(pendingResult);
            }
            snapshotLoaded = true;

            return () => {
                unlistenEvent();
                unlistenResult();
            };
        },
        async cancel(taskId: string) {
            await invokeTauri<void>('cancel_system_task', { taskId });
        },
        async respond(taskId: string, answer: unknown) {
            await invokeTauri<void>('respond_system_task_prompt', {
                taskId,
                answerJson: JSON.stringify(answer),
            });
        },
    };
}
