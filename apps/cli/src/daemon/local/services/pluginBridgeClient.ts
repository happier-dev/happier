import type {
    LocalServiceDeclarationV1,
    LocalServiceRuntimeSnapshotV1,
} from '@/plugins/runtime/exec/privateContract';
import type { LocalServicePreviewInitialPathV1 } from '@happier-dev/protocol';
import { readFileSync } from 'node:fs';

import { dispatchDaemonPluginLocalServicesBridgeRequest } from '@/daemon/controlClient';
import {
    HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY,
    HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY,
    type PluginLocalServicesBridgeControlRequestV1,
} from './pluginBridgeProtocol';
import type { PluginLocalServicesDaemonBridge } from '@/plugins/runtime/context/localServices';

type PluginLocalServicesBridgeContext = Readonly<{
    pluginId: string;
    contributionId: string;
    sessionId: string;
    title: string;
    initialPath?: LocalServicePreviewInitialPathV1;
}>;

type LocalServiceLaunchV1 = LocalServiceDeclarationV1['launch'];

export type DaemonControlPluginLocalServicesRuntime = Readonly<{
    createPluginLocalServicesBridge(context: PluginLocalServicesBridgeContext): PluginLocalServicesDaemonBridge;
}>;

type PluginLocalServicesBridgeDeclarationV1 = Extract<
    PluginLocalServicesBridgeControlRequestV1['operation'],
    { kind: 'start' }
>['declaration'];

type PluginLocalServicesBridgeExecLaunchInputV1 = PluginLocalServicesBridgeDeclarationV1['launch'];

function requireSnapshot(
    serviceId: string,
    snapshot: LocalServiceRuntimeSnapshotV1 | null | undefined,
): LocalServiceRuntimeSnapshotV1 {
    if (snapshot) {
        return snapshot;
    }
    throw new Error(`Daemon plugin local-service bridge returned no snapshot for ${serviceId}`);
}

function serializeStdinForControlBridge(stdin: string | Uint8Array | undefined): string | undefined {
    if (typeof stdin === 'undefined' || typeof stdin === 'string') {
        return stdin;
    }
    throw new Error('Daemon plugin local-service bridge does not support binary stdin over the JSON control route');
}

function rejectUnsupportedControlBridgeLaunch(_launch: never): never {
    throw new Error('Daemon plugin local-service bridge received an unsupported launch kind');
}

function serializeExecLaunchInputForControlBridge(
    launch: LocalServiceLaunchV1,
): PluginLocalServicesBridgeExecLaunchInputV1 {
    switch (launch.kind) {
        case 'agent-cli':
            return {
                kind: 'agent-cli',
                agentId: launch.agentId,
                ...(launch.args ? { args: [...launch.args] } : {}),
                ...(launch.cwd ? { cwd: launch.cwd } : {}),
                ...(launch.env ? { env: { ...launch.env } } : {}),
                ...(typeof launch.stdin !== 'undefined' ? { stdin: serializeStdinForControlBridge(launch.stdin) } : {}),
            };
        case 'binary':
            return {
                kind: 'binary',
                executablePath: launch.executablePath,
                ...(launch.args ? { args: [...launch.args] } : {}),
                ...(launch.cwd ? { cwd: launch.cwd } : {}),
                ...(launch.env ? { env: { ...launch.env } } : {}),
                ...(typeof launch.stdin !== 'undefined' ? { stdin: serializeStdinForControlBridge(launch.stdin) } : {}),
            };
        case 'ipc':
            return {
                kind: 'ipc',
                endpoint: launch.endpoint,
            };
        case 'managed-installable':
            throw new Error(
                'Daemon plugin local-service bridge does not support managed-installable launches over the JSON control route',
            );
        default:
            return rejectUnsupportedControlBridgeLaunch(launch);
    }
}

function serializeLocalServiceDeclarationForControlBridge(
    declaration: LocalServiceDeclarationV1,
): PluginLocalServicesBridgeDeclarationV1 {
    const launchMode = (() => {
        switch (declaration.launchMode.kind) {
            case 'detectAfterLaunch':
                return {
                    kind: 'detectAfterLaunch' as const,
                    ...(declaration.launchMode.minimumConfidence
                        ? { minimumConfidence: declaration.launchMode.minimumConfidence }
                        : {}),
                };
            case 'assignAndInject':
                return {
                    kind: 'assignAndInject' as const,
                    portPolicy: { ...declaration.launchMode.portPolicy },
                    ...(declaration.launchMode.environment
                        ? {
                            environment: {
                                ...(declaration.launchMode.environment.inject
                                    ? { inject: [...declaration.launchMode.environment.inject] }
                                    : {}),
                            },
                        }
                        : {}),
                };
            case 'externalRegistered':
                return {
                    kind: 'externalRegistered' as const,
                    inventoryId: declaration.launchMode.inventoryId,
                    ...(declaration.launchMode.minimumConfidence
                        ? { minimumConfidence: declaration.launchMode.minimumConfidence }
                        : {}),
                };
        }
    })();

    const healthCheck = (() => {
        switch (declaration.healthCheck.kind) {
            case 'none':
                return { kind: 'none' as const };
            case 'http':
                return {
                    kind: 'http' as const,
                    ...(declaration.healthCheck.path ? { path: declaration.healthCheck.path } : {}),
                    ...(typeof declaration.healthCheck.timeoutMs === 'number'
                        ? { timeoutMs: declaration.healthCheck.timeoutMs }
                        : {}),
                };
            case 'command':
                return {
                    kind: 'command' as const,
                    launch: serializeExecLaunchInputForControlBridge(declaration.healthCheck.launch),
                    ...(typeof declaration.healthCheck.timeoutMs === 'number'
                        ? { timeoutMs: declaration.healthCheck.timeoutMs }
                        : {}),
                };
        }
    })();

    return {
        id: declaration.id,
        launch: serializeExecLaunchInputForControlBridge(declaration.launch),
        launchMode,
        hostPolicy: { ...declaration.hostPolicy },
        name: { ...declaration.name },
        healthCheck,
        restart: { ...declaration.restart },
        cleanup: { ...declaration.cleanup },
    };
}

function readBridgeTokenFromEnv(): string {
    const token = process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_ENV_KEY]?.trim() ?? '';
    if (token) {
        return token;
    }
    const tokenFilePath = process.env[HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY]?.trim() ?? '';
    if (tokenFilePath) {
        const fileToken = readFileSync(tokenFilePath, 'utf8').trim();
        if (fileToken) {
            return fileToken;
        }
    }
    throw new Error('Daemon plugin local-service bridge token is not available');
}

export function createDaemonControlPluginLocalServicesRuntime(): DaemonControlPluginLocalServicesRuntime {
    return Object.freeze({
        createPluginLocalServicesBridge(context): PluginLocalServicesDaemonBridge {
            const bridgeToken = readBridgeTokenFromEnv();
            return Object.freeze({
                async declare(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1 | void> {
                    const wireDeclaration = serializeLocalServiceDeclarationForControlBridge(declaration);
                    const response = await dispatchDaemonPluginLocalServicesBridgeRequest({
                        protocolVersion: 1,
                        bridgeToken,
                        context,
                        operation: { kind: 'declare', declaration: wireDeclaration },
                    });
                    if (!response.ok) {
                        throw new Error(response.errorCode);
                    }
                    return response.snapshot ?? undefined;
                },
                async start(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1> {
                    const wireDeclaration = serializeLocalServiceDeclarationForControlBridge(declaration);
                    const response = await dispatchDaemonPluginLocalServicesBridgeRequest({
                        protocolVersion: 1,
                        bridgeToken,
                        context,
                        operation: { kind: 'start', declaration: wireDeclaration },
                    });
                    if (!response.ok) {
                        throw new Error(response.errorCode);
                    }
                    return requireSnapshot(declaration.id, response.snapshot);
                },
                async get(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null> {
                    const response = await dispatchDaemonPluginLocalServicesBridgeRequest({
                        protocolVersion: 1,
                        bridgeToken,
                        context,
                        operation: { kind: 'get', serviceId: id },
                    });
                    if (!response.ok) {
                        throw new Error(response.errorCode);
                    }
                    return response.snapshot ?? null;
                },
                async stop(id: string): Promise<void> {
                    const response = await dispatchDaemonPluginLocalServicesBridgeRequest({
                        protocolVersion: 1,
                        bridgeToken,
                        context,
                        operation: { kind: 'stop', serviceId: id },
                    });
                    if (!response.ok) {
                        throw new Error(response.errorCode);
                    }
                },
            });
        },
    });
}
