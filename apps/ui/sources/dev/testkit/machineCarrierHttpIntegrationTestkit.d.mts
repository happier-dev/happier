import type { FeaturesResponse} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { IrohEndpointDescriptorV1} from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import type { MachineOperationProtocolCapabilitiesV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';

export type Machine = Readonly<{
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: null;
    metadataVersion: number;
    operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1;
    operationProtocolCapabilitiesRevision: number;
    daemonState: {
        peerMediation: { iroh: { endpoint: IrohEndpointDescriptorV1 } };
        transfer: {
            supported: { import: boolean; export: boolean };
            listenerClasses: {
                loopback_http: { enabled: boolean; configured: boolean; active: boolean; available?: boolean };
                tailscale_serve_https: { enabled: boolean; configured: boolean; active: boolean; available?: boolean };
            };
            lifecycle: { mode: 'lazy_idle_shutdown'; version: number };
        };
    };
    daemonStateVersion: number;
}>;

export const TokenStorage: Readonly<{
    setCredentialsForServerUrl(
        serverUrl: string,
        server: Readonly<{ serverId: string }>,
        credentials: Readonly<{ token: string }>,
    ): Promise<boolean>;
    removeCredentialsForServerUrl(serverUrl: string, server: Readonly<{ serverId: string }>): Promise<void>;
}>;

export function primeServerFeaturesSnapshot(input: Readonly<{
    serverId: string;
    snapshot: Readonly<{ status: 'ready'; features: FeaturesResponse }>;
}>): void;
export function resetServerFeaturesClientForTests(): void;
export function upsertAndActivateServer(input: Readonly<{ serverUrl: string; scope: 'device' }>): Promise<Readonly<{ id: string }>>;
export const storage: Readonly<{
    setState(updater: (state: Readonly<{
        machines: Readonly<Record<string, Machine>>;
        machineListByServerId: Readonly<Record<string, readonly Machine[]>>;
    }>) => Readonly<{
        profileScope: Readonly<{ serverId: string; accountId: string }>;
        machines: Readonly<Record<string, Machine>>;
        machineListByServerId: Readonly<Record<string, readonly Machine[]>>;
    }>): void;
}>;
export function resetRuntimeFetch(): void;
export function setRuntimeFetch(fetcher: typeof globalThis.fetch): void;
export function probeIrohMachineTransferLifecycleAvailability(): Promise<boolean>;

export function createBufferedTransferDestination(maxBytes: number): Readonly<{
    destination: Readonly<{
        write(chunk: Uint8Array): Promise<void>;
        close(): Promise<void>;
        abort(error: Error): Promise<void>;
    }>;
    toBase64(): string;
}>;

export function uploadBulkPayloadFromFileViaMachineCarrier<T>(input: Readonly<{
    machineId: string;
    serverId: string;
    fileReader: Readonly<{
        sizeBytes: number;
        readBytes(offset: number, length: number): Promise<Uint8Array>;
        close(): Promise<void>;
    }>;
    directImportRequest: unknown;
    timeoutMs: number;
    signal: AbortSignal | null;
}>): Promise<T>;

export function uploadBulkPayloadFromFileViaDirectImport<T>(input: Readonly<{
    machineId: string;
    serverId: string;
    fileReader: Readonly<{
        sizeBytes: number;
        readBytes(offset: number, length: number): Promise<Uint8Array>;
        close(): Promise<void>;
    }>;
    request: Readonly<{
        t: 'session_file_upload_v1';
        workingDirectory: string;
        path: string;
        sizeBytes: number;
        sha256: string;
        overwrite: boolean;
    }>;
    acquirePreparedCarrier(input: Readonly<{ operationId: string; signal?: AbortSignal }>): Promise<Readonly<{
        kind: 'native_http';
        localOrigin: string;
        release(): Promise<void>;
    }>>;
}>): Promise<T | Readonly<{ success: false; error: string; errorCode?: string }>>;

export function resolveMachineCarrierRoute(machineId: string, serverId: string): Promise<
    | Readonly<{ kind: 'iroh_peer'; acquire(input: Readonly<{ operationId: string }>): Promise<unknown> }>
    | Readonly<{ kind: 'unavailable'; error: string; errorCode: string }>
>;

export function downloadBulkPayloadViaDirectExportToDestination(input: Readonly<{
    machineId: string;
    serverId: string;
    request: Readonly<{
        t: 'workspace_file_download_v1';
        workingDirectory: string;
        path: string;
        asZip: boolean;
    }>;
    destination: Readonly<{
        write(chunk: Uint8Array): Promise<void>;
        close(): Promise<void>;
        abort(error: Error): Promise<void>;
    }>;
    timeoutMs: number;
    acquirePreparedCarrier(input: Readonly<{ operationId: string }>): Promise<unknown>;
}>): Promise<Readonly<{ ok: boolean; name?: string; sizeBytes?: number }>>;
