import type {
    LocalServiceDeclarationV1,
    LocalServiceHandleV1,
    LocalServiceRuntimeSnapshotV1,
    LocalServicesRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

const SUBSTRATE_UNAVAILABLE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_SUBSTRATE_UNAVAILABLE',
    severity: 'warning' as const,
    message: 'Plugin local-service launch is unavailable until the local-services runtime substrate is active.',
});

function stoppedSnapshot(id: string): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'stopped',
        diagnostics: Object.freeze([]),
    });
}

function failedSnapshot(id: string): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'failed',
        diagnostics: Object.freeze([SUBSTRATE_UNAVAILABLE_DIAGNOSTIC]),
    });
}

export function createPluginLocalServicesService(): LocalServicesRuntimeServiceV1 {
    const declarationsById = new Map<string, LocalServiceDeclarationV1>();
    const snapshotsById = new Map<string, LocalServiceRuntimeSnapshotV1>();

    return Object.freeze({
        async declare(declaration: LocalServiceDeclarationV1): Promise<void> {
            declarationsById.set(declaration.id, Object.freeze({ ...declaration }));
            if (!snapshotsById.has(declaration.id)) {
                snapshotsById.set(declaration.id, stoppedSnapshot(declaration.id));
            }
        },
        async start(id: string): Promise<LocalServiceHandleV1> {
            const snapshot = failedSnapshot(id);
            snapshotsById.set(id, snapshot);
            return Object.freeze({
                snapshot: () => snapshotsById.get(id) ?? snapshot,
                stop: async () => {
                    snapshotsById.set(id, stoppedSnapshot(id));
                },
            });
        },
        async get(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null> {
            if (!declarationsById.has(id)) {
                return null;
            }
            return snapshotsById.get(id) ?? stoppedSnapshot(id);
        },
    });
}
