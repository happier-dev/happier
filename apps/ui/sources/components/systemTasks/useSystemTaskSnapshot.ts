import * as React from 'react';

import type { SystemTaskRunState, SystemTaskRunner } from './types';

export function useSystemTaskSnapshot(
    runner: SystemTaskRunner,
    taskId: string | null,
): SystemTaskRunState | null {
    return React.useSyncExternalStore(
        React.useCallback((notify) => {
            if (!taskId) {
                return () => {};
            }
            return runner.subscribe(taskId, notify);
        }, [runner, taskId]),
        React.useCallback(() => {
            if (!taskId) {
                return null;
            }
            return runner.getSnapshot(taskId);
        }, [runner, taskId]),
        () => null,
    );
}
