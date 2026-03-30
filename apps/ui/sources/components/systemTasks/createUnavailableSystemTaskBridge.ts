import type { SystemTasksBridge } from './types';

export function createUnavailableSystemTaskBridge(): SystemTasksBridge {
    return {
        async start() {
            throw new Error('system_tasks_unavailable');
        },
        async cancel() {},
        async respond() {},
        async subscribe() {
            return () => {};
        },
    };
}
