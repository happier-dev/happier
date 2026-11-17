import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { MachineConnectorSecretGrantSubjectV1 } from '@happier-dev/deployment-protocol';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import type { PeerMediationGrantSigningKeyCapability } from '@happier-dev/protocol';

export interface ExternalActionHomeForTestsOptions {
    readonly serverIdentityId: string;
    readonly accountId: string;
    readonly manageGranteeAccountId?: string;
    readonly machineId: string;
    readonly installationId: string;
    readonly installationPublicKey: Uint8Array;
    readonly authentication?: 'present_user';
    /** The canonical mode persisted on the primary Account row. */
    readonly accountEncryptionMode?: 'plain' | 'e2ee';
    /** Opaque primary-Machine bytes supplied by the canonical CLI fixture. */
    readonly machineStoredContent?: Readonly<{ metadata: string; dataEncryptionKey: string }>;
    /** A real second installed peer for signed cross-Account Sync socket calls. */
    readonly workspaceSyncTarget?: Readonly<{ accountId: string; machineId: string;
        installationId: string; installationPublicKey: Uint8Array }>;
    /** Source Session stored by the real metadata route in composed Agent tests. */
    readonly session?: Readonly<{ id: string; metadataLayoutVersion: number; metadata: string;
        ownerMetadata: unknown; agentState: string | null; metadataVersion: number; agentStateVersion: number }>;
    dispatch(packet: SocketRpcRequestPayload, options: Readonly<{ signal: AbortSignal }>): Promise<unknown>;
}

export interface ExternalActionHomeForTests {
    readonly token: string;
    /** Real person-review bearer, separate from the original invocation credential. */
    readonly presentUserToken: string;
    readonly peerMediationGrantSigningKeys?: readonly PeerMediationGrantSigningKeyCapability[];
    readonly manageGrantee?: Readonly<{ accountId: string; token: string; presentUserToken: string;
        machineAdmission: SocketRpcMachineAdmissionContextV1 }>;
    /** Actual exact-subject row observation, never read/admission authority. */
    readConnectorGrantCount(subject: MachineConnectorSecretGrantSubjectV1): Promise<number>;
    /** External fixture withdrawal through the existing repository owner. */
    removeConnectorGrant(subject: MachineConnectorSecretGrantSubjectV1): Promise<void>;
    forwardMachineRpc(machineId: string, payload: SocketRpcRequestPayload): Promise<unknown>;
    request(method: 'POST' | 'PATCH', path: string, body: unknown, headers?: Readonly<Record<string, string>>,
        signal?: AbortSignal): Promise<Readonly<{ status: number; data: unknown }>>;
    close(): Promise<void>;
}

export function createExternalActionHomeProcessForTests(options: ExternalActionHomeForTestsOptions): Promise<ExternalActionHomeForTests>;
