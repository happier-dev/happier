import type {
    LocalServiceDeclarationV1,
    LocalServiceHandleV1,
    LocalServiceRuntimeSnapshotV1,
    LocalServicesRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

export type PluginLocalServicesDaemonBridge = Readonly<{
    declare?(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1 | void>;
    start(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1>;
    get?(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null>;
    stop?(id: string): Promise<void>;
}>;

export type PluginLocalServicesServiceOptions = Readonly<{
    daemonBridge?: PluginLocalServicesDaemonBridge | null;
}>;

const DAEMON_BRIDGE_UNAVAILABLE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_DAEMON_BRIDGE_UNAVAILABLE',
    severity: 'warning' as const,
    message: 'Plugin local-service launch requires the daemon local-services launch and preview bridge.',
});

const DECLARATION_NOT_FOUND_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_DECLARATION_NOT_FOUND',
    severity: 'error' as const,
    message: 'Plugin local-service launch requires a declared local-service id.',
});

const START_FAILED_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_START_FAILED',
    severity: 'error' as const,
    message: 'Daemon local-service launch failed before preview correlation completed.',
});

function stoppedSnapshot(id: string): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'stopped',
        diagnostics: Object.freeze([]),
    });
}

function failedSnapshot(
    id: string,
    diagnostic: LocalServiceRuntimeSnapshotV1['diagnostics'][number],
): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'failed',
        diagnostics: Object.freeze([diagnostic]),
    });
}

function freezeSnapshot(snapshot: LocalServiceRuntimeSnapshotV1): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        ...snapshot,
        diagnostics: Object.freeze(snapshot.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
    });
}

export function createPluginLocalServicesService(
    options: PluginLocalServicesServiceOptions = {},
): LocalServicesRuntimeServiceV1 {
    const declarationsById = new Map<string, LocalServiceDeclarationV1>();
    const snapshotsById = new Map<string, LocalServiceRuntimeSnapshotV1>();
    const daemonBridge = options.daemonBridge ?? null;

    function handleFor(id: string, fallback: LocalServiceRuntimeSnapshotV1): LocalServiceHandleV1 {
        return Object.freeze({
            snapshot: () => snapshotsById.get(id) ?? fallback,
            stop: async () => {
                await daemonBridge?.stop?.(id);
                snapshotsById.set(id, stoppedSnapshot(id));
            },
        });
    }

    return Object.freeze({
        async declare(declaration: LocalServiceDeclarationV1): Promise<void> {
            const storedDeclaration = Object.freeze({ ...declaration });
            declarationsById.set(storedDeclaration.id, storedDeclaration);
            if (!snapshotsById.has(storedDeclaration.id)) {
                snapshotsById.set(storedDeclaration.id, stoppedSnapshot(storedDeclaration.id));
            }
            const bridgeSnapshot = await daemonBridge?.declare?.(storedDeclaration);
            if (bridgeSnapshot) {
                snapshotsById.set(storedDeclaration.id, freezeSnapshot(bridgeSnapshot));
            }
        },
        async start(id: string): Promise<LocalServiceHandleV1> {
            const declaration = declarationsById.get(id);
            if (!declaration) {
                const snapshot = failedSnapshot(id, DECLARATION_NOT_FOUND_DIAGNOSTIC);
                snapshotsById.set(id, snapshot);
                return handleFor(id, snapshot);
            }
            if (!daemonBridge) {
                const snapshot = failedSnapshot(id, DAEMON_BRIDGE_UNAVAILABLE_DIAGNOSTIC);
                snapshotsById.set(id, snapshot);
                return handleFor(id, snapshot);
            }
            let snapshot: LocalServiceRuntimeSnapshotV1;
            try {
                snapshot = freezeSnapshot(await daemonBridge.start(declaration));
            } catch {
                snapshot = failedSnapshot(id, START_FAILED_DIAGNOSTIC);
            }
            snapshotsById.set(id, snapshot);
            return handleFor(id, snapshot);
        },
        async get(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null> {
            if (!declarationsById.has(id)) {
                return null;
            }
            const bridgeSnapshot = await daemonBridge?.get?.(id);
            if (bridgeSnapshot) {
                const snapshot = freezeSnapshot(bridgeSnapshot);
                snapshotsById.set(id, snapshot);
                return snapshot;
            }
            return snapshotsById.get(id) ?? stoppedSnapshot(id);
        },
    });
}
