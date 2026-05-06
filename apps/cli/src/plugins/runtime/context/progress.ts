import type { ProgressHandleV1, ProgressRuntimeServiceV1, ProgressSnapshotV1 } from '@happier-dev/plugin-sdk';

function createProgressSnapshot(params: Readonly<{
    id: string;
    label: string;
    state: ProgressSnapshotV1['state'];
    current: number | null;
    total: number | null;
    message: string | null;
}>): ProgressSnapshotV1 {
    return Object.freeze({ ...params });
}

export function createPluginProgressService(): ProgressRuntimeServiceV1 {
    const handles = new Map<string, ProgressHandleV1>();
    let nextId = 1;

    const service: ProgressRuntimeServiceV1 = Object.freeze({
        start(params: Parameters<ProgressRuntimeServiceV1['start']>[0]): ProgressHandleV1 {
            const id = params.id ?? `progress-${nextId++}`;
            let snapshot = createProgressSnapshot({
                id,
                label: params.label,
                state: 'active',
                current: null,
                total: params.total ?? null,
                message: null,
            });
            const handle: ProgressHandleV1 = Object.freeze({
                id,
                report(update) {
                    snapshot = createProgressSnapshot({
                        ...snapshot,
                        current: update.current ?? snapshot.current,
                        total: update.total ?? snapshot.total,
                        message: update.message ?? snapshot.message,
                    });
                },
                finish(message) {
                    snapshot = createProgressSnapshot({
                        ...snapshot,
                        state: 'finished',
                        message: message ?? snapshot.message,
                    });
                    handles.delete(id);
                },
                fail(error) {
                    snapshot = createProgressSnapshot({
                        ...snapshot,
                        state: 'failed',
                        message: error instanceof Error ? error.message : String(error),
                    });
                    handles.delete(id);
                },
                snapshot: () => snapshot,
            });
            handles.set(id, handle);
            return handle;
        },
        report(id: string, update: Parameters<ProgressHandleV1['report']>[0]): void {
            handles.get(id)?.report(update);
        },
        finish(id: string, message?: string | null) {
            handles.get(id)?.finish(message);
        },
    });
    return service;
}
